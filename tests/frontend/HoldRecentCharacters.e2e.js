import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// "Keep recently used characters": off, extensions see only the current character; on with a number, they also see
// the most recently used characters up to that number, and the page holds them, across a reload.

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/** @param {import('@playwright/test').Page} page */
async function loadApp(page) {
    await testSetup.awaitST({ page });
    await page.evaluate(() => {
        window['__appReady'] = false;
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, () => { window['__appReady'] = true; });
    });
    await page.waitForFunction(() => window['__appReady'], null, { timeout: 60000 });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @returns {Promise<string>} its avatar key
 */
async function createCharacter(page, name) {
    return page.evaluate(async (name) => {
        const { getRequestHeaders } = await import('./script.js');
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', `Hello from ${name}.`);
        const response = await fetch('/api/characters/create', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, name);
}

/**
 * Sets the setting through its controls and waits for it to be saved.
 * @param {import('@playwright/test').Page} page
 * @param {boolean} on
 * @param {number} [count]
 */
async function setHoldRecent(page, on, count) {
    await page.evaluate(async ({ on, count }) => {
        const { saveSettings } = await import('./script.js');
        if (count !== undefined) {
            $('#hold_recent_characters_count').val(count).trigger('change');
        }
        $('#hold_recent_characters').prop('checked', on).trigger('input');
        await saveSettings();
    }, { on, count });
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string[]>} the avatars extensions see
 */
async function shownAvatars(page) {
    return page.evaluate(() => window['SillyTavern'].getContext().characters.map(character => character.avatar));
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<number>} how many characters the library has
 */
async function libraryCount(page) {
    return page.evaluate(async () => {
        const { characterRepository } = await import('./scripts/character-repository.js');
        const result = await characterRepository.query({}, { field: 'name', order: 'asc' }, 1, 1, ['total']);
        return Number(String(result.total).replace('~', ''));
    });
}

test.describe('Keep recently used characters', () => {
    test.afterEach(async ({ page }) => {
        // The workers share their data root; leave the setting off for the tests after this one.
        await setHoldRecent(page, false, 100);
    });

    test('off by default, extensions see only the current character', async ({ page }) => {
        await loadApp(page);
        const avatar = await createCharacter(page, 'HoldRecent Off');
        await expect(page.locator('#hold_recent_characters')).not.toBeChecked();
        await page.evaluate(async (avatar) => {
            const { selectCharacterByAvatar } = await import('./script.js');
            await selectCharacterByAvatar(avatar, { switchMenu: false });
        }, avatar);
        expect(await shownAvatars(page)).toEqual([avatar]);
    });

    test('on, the recently used characters are shown and held, after a reload too, and let go when turned off', async ({ page }) => {
        await loadApp(page);
        const first = await createCharacter(page, 'HoldRecent One');
        const second = await createCharacter(page, 'HoldRecent Two');
        const count = Math.min(await libraryCount(page), 5000);

        await setHoldRecent(page, true, count);
        await expect.poll(() => shownAvatars(page), { timeout: 30000 }).toEqual(expect.arrayContaining([first, second]));
        expect((await shownAvatars(page)).length).toBe(count);

        await page.reload();
        await loadApp(page);
        await expect(page.locator('#hold_recent_characters')).toBeChecked();
        await expect(page.locator('#hold_recent_characters_count')).toHaveValue(String(count));
        await expect.poll(() => shownAvatars(page), { timeout: 30000 }).toEqual(expect.arrayContaining([first, second]));
        const heldWhole = await page.evaluate(async (avatars) => {
            const { charactersStore } = await import('./scripts/character-store.js');
            return avatars.map(avatar => charactersStore.get(avatar)?.shallow === false);
        }, [first, second]);
        expect(heldWhole).toEqual([true, true]);

        await setHoldRecent(page, false);
        expect(await shownAvatars(page)).toEqual([]);
        await expect.poll(() => page.evaluate(async (avatars) => {
            const { charactersStore } = await import('./scripts/character-store.js');
            return avatars.some(avatar => charactersStore.has(avatar));
        }, [first, second]), { timeout: 10000 }).toBe(false);
    });

    test('lowering the number shows fewer, most recently used kept', async ({ page }) => {
        await loadApp(page);
        // Enough characters for three to be kept, whatever else this worker's library holds.
        await createCharacter(page, 'HoldRecent Lower A');
        await createCharacter(page, 'HoldRecent Lower B');
        const avatar = await createCharacter(page, 'HoldRecent Lower');
        await page.evaluate(async (avatar) => {
            const { selectCharacterByAvatar } = await import('./script.js');
            await selectCharacterByAvatar(avatar, { switchMenu: false });
        }, avatar);
        await setHoldRecent(page, true, 3);
        await expect.poll(() => shownAvatars(page).then(list => list.length), { timeout: 30000 }).toBe(3);
        await setHoldRecent(page, true, 1);
        expect(await shownAvatars(page)).toEqual([avatar]);
    });
});
