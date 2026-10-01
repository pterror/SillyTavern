import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// Deleting and existence checks act on the library, not on the characters the page holds. Each test makes its
// characters after the page has loaded and keeps the page from hearing of them.

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
 * @param {string} avatar
 * @returns {Promise<boolean>} whether the server has the character
 */
async function existsOnServer(page, avatar) {
    return page.evaluate(async (avatar) => {
        const { getRequestHeaders } = await import('./script.js');
        const response = await fetch('/api/characters/exists', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ ids: [avatar] }) });
        return (await response.json())[avatar] === true;
    }, avatar);
}

test.describe('characters the page does not hold', () => {
    test.beforeEach(async ({ page }) => {
        await loadApp(page);
        await page.route('**/api/characters/changes', route => route.fulfill({ status: 500 }));
    });

    test('deleteCharacter deletes a character the page does not hold', async ({ page }) => {
        const avatar = await createUnheldCharacter(page, `DeleteUnheld ${Date.now()}`);
        expect(await existsOnServer(page, avatar)).toBe(true);

        const deleted = await page.evaluate(async (avatar) => {
            const { deleteCharacter } = await import('./script.js');
            return deleteCharacter(avatar, { deleteChats: false });
        }, avatar);

        expect(deleted).toBe(true);
        expect(await existsOnServer(page, avatar)).toBe(false);
        await expect(page.locator('.toast-warning', { hasText: 'not found' })).toHaveCount(0);
    });

    test('deleteCharacter deletes nothing when the characters cannot be looked up', async ({ page }) => {
        const avatar = await createUnheldCharacter(page, `DeleteLookupFails ${Date.now()}`);
        await page.route('**/api/characters/query', route => route.fulfill({ status: 500 }));

        // The toast shows while the call is still finishing its UI refresh, so it is awaited alongside the call.
        const toast = expect(page.locator('.toast-error', { hasText: 'Nothing was deleted' })).toBeVisible();
        const deleted = await page.evaluate(async (avatar) => {
            const { deleteCharacter } = await import('./script.js');
            return deleteCharacter(avatar, { deleteChats: false });
        }, avatar);
        await toast;

        expect(deleted).toBe(false);
        await page.unroute('**/api/characters/query');
        expect(await existsOnServer(page, avatar)).toBe(true);
    });
});
