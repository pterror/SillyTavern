import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// Slash commands that take a character's name find it through the server, so they work for a character the page
// doesn't hold. Each test makes its characters after the page has loaded and keeps the page from hearing of them.

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
        const response = await fetch('/api/characters/create', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, name);
    const held = await page.evaluate(async (avatar) => {
        const { charactersStore } = await import('./scripts/character-store.js');
        return charactersStore.has(avatar);
    }, avatar);
    expect(held).toBe(false);
    return avatar;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} command
 * @returns {Promise<string>} the command's result
 */
async function run(page, command) {
    return page.evaluate(async (command) => (await window['SillyTavern'].getContext().executeSlashCommandsWithOptions(command)).pipe, command);
}

test.describe('findCharAsync', () => {
    test.beforeEach(async ({ page }) => {
        await loadApp(page);
        await page.route('**/api/characters/changes', route => route.fulfill({ status: 500 }));
    });

    test('/char-find finds a character the page does not hold, by name and by avatar key', async ({ page }) => {
        const stamp = `${Date.now()}`;
        const name = `FindCharUnheld ${stamp}`;
        const avatar = await createUnheldCharacter(page, name);

        expect(await run(page, `/char-find "${name.toUpperCase()}"`)).toBe(avatar);
        expect(await run(page, `/char-find "${avatar}"`)).toBe(avatar);
        expect(await run(page, `/char-find "FindCharNobody ${stamp}"`)).toBe('');
    });

    test('/char-find warns when two characters share the name, and answers the first', async ({ page }) => {
        const stamp = `${Date.now()}`;
        const name = `FindCharTwin ${stamp}`;
        const first = await createUnheldCharacter(page, name);
        const second = await createUnheldCharacter(page, name);
        const expected = [first, second].sort()[0];

        expect(await run(page, `/char-find "${name}"`)).toBe(expected);
        await expect(page.locator('.toast-warning', { hasText: 'Multiple characters found' })).toBeVisible();
    });
});
