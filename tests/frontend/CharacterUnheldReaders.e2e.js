import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// The page holds only some characters. These readers used to find a character only among the ones the page holds;
// each test makes its characters after the page has loaded and keeps the page from hearing of them.

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
 * Creates a character the page doesn't hold.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @returns {Promise<string>} its avatar key
 */
async function createUnheldCharacter(page, name) {
    const avatar = await page.evaluate(async (name) => {
        const { getRequestHeaders } = await import('./script.js');
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', `Hello from ${name}.`);
        const response = await fetch('/api/characters/create', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, name);
    expect(await isHeld(page, avatar)).toBe(false);
    return avatar;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @returns {Promise<boolean>}
 */
async function isHeld(page, avatar) {
    return page.evaluate(async (avatar) => {
        const { charactersStore } = await import('./scripts/character-store.js');
        return charactersStore.has(avatar);
    }, avatar);
}

/** @param {import('@playwright/test').Page} page */
async function currentAvatar(page) {
    return page.evaluate(async () => (await import('./script.js')).getCurrentCharacter()?.avatar ?? null);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} command
 */
async function run(page, command) {
    return page.evaluate(async (command) => (await window['SillyTavern'].getContext().executeSlashCommandsWithOptions(command)).pipe, command);
}

test.describe('readers of characters the page does not hold', () => {
    test.beforeEach(async ({ page }) => {
        await loadApp(page);
        await page.route('**/api/characters/changes', route => route.fulfill({ status: 500 }));
    });

    test('/go opens a character the page does not hold', async ({ page }) => {
        const name = `GoUnheld ${Date.now()}`;
        const avatar = await createUnheldCharacter(page, name);

        expect(await run(page, `/go ${name}`)).toBe(name);
        await expect.poll(() => currentAvatar(page)).toBe(avatar);
    });

    test('/char-create select=true selects the new character', async ({ page }) => {
        const name = `CreateSelect ${Date.now()}`;
        const avatar = await run(page, `/char-create name="${name}" select=true`);

        expect(avatar).toBeTruthy();
        await expect.poll(() => currentAvatar(page)).toBe(avatar);
    });

    test('getCharaFilename takes the avatar key of a character the page does not hold', async ({ page }) => {
        const avatar = await createUnheldCharacter(page, `FileName ${Date.now()}`);
        const fileName = await page.evaluate(async (avatar) => (await import('./scripts/utils.js')).getCharaFilename(avatar), avatar);
        expect(fileName).toBe(avatar.replace(/\.png$/, ''));
    });

    test('a welcome page assistant the page does not hold is kept and opens', async ({ page }) => {
        const avatar = await createUnheldCharacter(page, `Assistant ${Date.now()}`);
        const kept = await page.evaluate(async (avatar) => {
            const { accountStorage } = await import('./scripts/util/AccountStorage.js');
            const { getPermanentAssistantAvatar } = await import('./scripts/welcome-screen.js');
            accountStorage.setItem('assistant', avatar);
            return getPermanentAssistantAvatar();
        }, avatar);
        expect(kept).toBe(avatar);

        await page.evaluate(async () => (await import('./scripts/welcome-screen.js')).openPermanentAssistantCard());
        await expect.poll(() => currentAvatar(page)).toBe(avatar);
        const stored = await page.evaluate(async () => (await import('./scripts/util/AccountStorage.js')).accountStorage.getItem('assistant'));
        expect(stored).toBe(avatar);
    });

    test('the page lets go of a character once another is opened', async ({ page }) => {
        const first = await createUnheldCharacter(page, `ReleaseFirst ${Date.now()}`);
        const second = await createUnheldCharacter(page, `ReleaseSecond ${Date.now()}`);
        const open = (avatar) => page.evaluate(async (avatar) => (await import('./script.js')).selectCharacterByAvatar(avatar), avatar);

        await open(first);
        await expect.poll(() => currentAvatar(page)).toBe(first);
        expect(await isHeld(page, first)).toBe(true);

        await open(second);
        await expect.poll(() => currentAvatar(page)).toBe(second);
        await expect.poll(() => isHeld(page, first), { timeout: 10000 }).toBe(false);
        expect(await isHeld(page, second)).toBe(true);
    });

    test('a group draws a member the page does not hold in its avatar', async ({ page }) => {
        const avatar = await createUnheldCharacter(page, `GroupMember ${Date.now()}`);
        const sources = await page.evaluate(async (avatar) => {
            const { getGroupAvatar } = await import('./scripts/group-chats.js');
            const element = getGroupAvatar({ name: 'Collage', members: [avatar], avatar_url: '' });
            return element.find('img').toArray().map(img => img.getAttribute('src'));
        }, avatar);
        expect(sources.some(src => src.includes(encodeURIComponent(avatar)))).toBe(true);
    });
});
