import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// Bulk favorite is one server action over the selection, not a write from the page's copies: a selected
// character the page doesn't hold is flipped too, from what the server has stored.

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
 * @returns {Promise<boolean>} the fav value the server has stored
 */
async function storedFav(page, avatar) {
    return page.evaluate(async (avatar) => {
        const { getRequestHeaders } = await import('./script.js');
        const response = await fetch('/api/characters/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }) });
        const character = await response.json();
        return character.fav === true || character.fav === 'true';
    }, avatar);
}

/**
 * Runs the bulk favorite action on the given avatars, as the context menu does.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} avatars
 * @returns {Promise<{ url: string, body: any }[]>} the requests sent to /api/characters/fav and /api/characters/bulk/run
 */
async function bulkFavorite(page, avatars) {
    const sent = [];
    page.on('request', request => {
        if (/\/api\/characters\/(fav|bulk\/run)$/.test(request.url())) sent.push({ url: new URL(request.url()).pathname, body: request.postDataJSON() });
    });
    await page.evaluate(async (avatars) => {
        const { characterGroupOverlay } = await import('./script.js');
        characterGroupOverlay.selectState();
        for (const avatar of avatars) {
            const row = document.createElement('div');
            row.setAttribute('data-avatar', avatar);
            characterGroupOverlay.toggleSingleCharacter(row);
        }
        await characterGroupOverlay.handleContextMenuFavorite();
    }, avatars);
    return sent;
}

test.describe('bulk favorite', () => {
    test.beforeEach(async ({ page }) => {
        await loadApp(page);
        await page.route('**/api/characters/changes', route => route.fulfill({ status: 500 }));
    });

    test('flips characters the page does not hold, each from its stored value', async ({ page }) => {
        const stamp = Date.now();
        const notFav = await createUnheldCharacter(page, `BulkFavA ${stamp}`);
        const alreadyFav = await createUnheldCharacter(page, `BulkFavB ${stamp}`);
        await page.evaluate(async (avatar) => {
            const { getRequestHeaders } = await import('./script.js');
            await fetch('/api/characters/fav', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar, fav: true }) });
        }, alreadyFav);

        const sent = await bulkFavorite(page, [notFav, alreadyFav]);

        expect(sent.map(entry => entry.url)).toEqual(['/api/characters/bulk/run']);
        expect(sent[0].body.action).toBe('fav');
        expect(await storedFav(page, notFav)).toBe(true);
        expect(await storedFav(page, alreadyFav)).toBe(false);
    });

    test('names every selected character that no longer exists, and still flips the rest', async ({ page }) => {
        const stamp = Date.now();
        const avatar = await createUnheldCharacter(page, `BulkFavC ${stamp}`);
        const missing = `Missing ${stamp}.png`;

        const toast = expect(page.locator('.toast-warning', { hasText: missing })).toBeVisible();
        await bulkFavorite(page, [avatar, missing]);
        await toast;

        expect(await storedFav(page, avatar)).toBe(true);
    });
});
