import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, openInfoTab } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string[]} greetings
 * @returns {Promise<string>}
 */
async function createCharacter(page, name, greetings) {
    return page.evaluate(async ({ name, greetings }) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', greetings[0]);
        for (const text of greetings.slice(1)) form.append('alternate_greetings', text);
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, { name, greetings });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function openCharacter(page, avatar) {
    await openCharacterManagementDrawer(page);
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        await stTest.context().getCharacters();
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
    await expect.poll(() => page.evaluate((avatar) => {
        // @ts-ignore
        const context = stTest.context();
        return context.characters[context.characterId]?.avatar === avatar && typeof context.chat[0]?.node_id === 'string';
    }, avatar), { timeout: 10000 }).toBe(true);
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);
}

/** @param {import('@playwright/test').Page} page */
async function shownText(page) {
    return page.evaluate(() => {
        // @ts-ignore
        return stTest.context().chat[0]?.mes;
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} swipeId
 * @param {string} text
 */
async function showSwipe(page, swipeId, text) {
    const told = page.waitForResponse(r => ['/api/chats/openings/choose', '/api/chats/message/select'].includes(new URL(r.url()).pathname), { timeout: 10000 });
    await page.evaluate(async (swipeId) => {
        const { swipe } = await import('/script.js');
        const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('/scripts/constants.js');
        // @ts-ignore
        const current = stTest.context().chat[0].swipe_id ?? 0;
        const direction = swipeId > current ? SWIPE_DIRECTION.RIGHT : SWIPE_DIRECTION.LEFT;
        await swipe(null, direction, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: 0, forceSwipeId: swipeId });
    }, swipeId);
    await expect.poll(() => shownText(page), { timeout: 10000 }).toBe(text);
    expect((await told).ok()).toBe(true);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} text
 */
async function swipeIndexOf(page, text) {
    return page.evaluate((text) => {
        // @ts-ignore
        return stTest.context().chat[0].swipes.indexOf(text);
    }, text);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function openings(page, avatar) {
    return page.evaluate(async (avatar) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders();
        const response = await fetch('/api/chats/openings', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar }) });
        return response.json();
    }, avatar);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} index
 */
function greetingRow(page, index) {
    return page.locator('dialog.alternatives li.alternative').nth(index);
}

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test.describe('the opening a chat was switched to is kept', () => {
    test.beforeEach(testSetup.awaitST);

    test('a card greeting with no row stays shown after opening another character and coming back', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `KeepA-${s}`, g);
        const other = await createCharacter(page, `KeepB-${s}`, [`Other ${s}`]);
        await openCharacter(page, avatar);
        await showSwipe(page, 2, g[2]);

        await openCharacter(page, other);
        await openCharacter(page, avatar);
        expect(await shownText(page)).toBe(g[2]);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(g[2]);
        expect((await openings(page, avatar)).stored).toBe(0);
    });

    test('it stays shown after a page reload, and switching back to the first greeting is kept too', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `KeepC-${s}`, g);
        await openCharacter(page, avatar);
        await showSwipe(page, 1, g[1]);

        await page.reload();
        await testSetup.awaitST({ page });
        await openCharacter(page, avatar);
        expect(await shownText(page)).toBe(g[1]);

        await showSwipe(page, 0, g[0]);
        await page.reload();
        await testSetup.awaitST({ page });
        await openCharacter(page, avatar);
        expect(await shownText(page)).toBe(g[0]);
    });

    test('with a stored opening, the last one switched to is shown, stored or not', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `KeepD-${s}`, g);
        const other = await createCharacter(page, `KeepE-${s}`, [`Other ${s}`]);
        await openCharacter(page, avatar);
        await showSwipe(page, 2, g[2]);
        await page.evaluate(async () => {
            const { ensureOpeningRow } = await import('/scripts/chat-store.js');
            await ensureOpeningRow(0);
        });
        await expect.poll(async () => (await openings(page, avatar)).stored).toBe(1);

        await openCharacter(page, other);
        await openCharacter(page, avatar);
        expect(await shownText(page)).toBe(g[2]);

        await showSwipe(page, await swipeIndexOf(page, g[1]), g[1]);
        await openCharacter(page, other);
        await openCharacter(page, avatar);
        expect(await shownText(page)).toBe(g[1]);

        await showSwipe(page, await swipeIndexOf(page, g[2]), g[2]);
        await openCharacter(page, other);
        await openCharacter(page, avatar);
        expect(await shownText(page)).toBe(g[2]);
        expect((await openings(page, avatar)).stored).toBe(1);
    });

    test('editing the greeting the chat was switched to shows the new text, also after coming back', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `KeepF-${s}`, g);
        const other = await createCharacter(page, `KeepG-${s}`, [`Other ${s}`]);
        await openCharacter(page, avatar);
        await showSwipe(page, 2, g[2]);

        await openInfoTab(page, 'greeting');
        await page.locator('.open_alternate_greetings').click();
        const row = greetingRow(page, 2);
        await expect(row).toContainText(g[2], { timeout: 10000 });
        const edited = `Two edited ${s}`;
        await row.locator('.alternative-edit').click();
        await row.locator('textarea').fill(edited);
        await row.getByRole('button', { name: 'Save' }).click();
        await expect(row.locator('.alternative-text')).toContainText(edited);
        await expect.poll(() => shownText(page), { timeout: 10000 }).toBe(edited);
        await page.keyboard.press('Escape');

        await openCharacter(page, other);
        await openCharacter(page, avatar);
        expect(await shownText(page)).toBe(edited);
    });
});
