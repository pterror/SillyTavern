import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// A character row on screen whose character the page doesn't hold takes in tag changes made elsewhere: an
// assignment, and a tag deleted with a merge. The test makes the character after the page has loaded and keeps the
// page from hearing of it, so only its row has it.

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
 * @param {string} path
 * @param {object} [body]
 */
async function api(page, path, body = {}) {
    return page.evaluate(async ({ path, body }) => {
        const headers = window['SillyTavern'].getContext().getRequestHeaders();
        const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!response.ok) throw new Error(`${path} -> ${response.status}`);
        return response.json();
    }, { path, body });
}

/**
 * Creates a character the page doesn't hold.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @returns {Promise<string>} its avatar key
 */
async function createUnheldCharacter(page, name) {
    return page.evaluate(async (name) => {
        const { getRequestHeaders } = await import('./script.js');
        const form = new FormData();
        form.set('ch_name', name);
        const response = await fetch('/api/characters/create', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, name);
}

/** @param {import('@playwright/test').Page} page @param {string} id @param {string} name */
async function createTag(page, id, name) {
    await api(page, '/api/tags/create', { tag: { id, name, folder_type: 'NONE', is_hidden_on_character_card: false, color: '', color2: '', create_date: 1 } });
}

/** What a character change message on the changes stream runs. */
async function takeInEntityTagChanges(page) {
    await page.evaluate(async () => {
        const { onEntityTagsChanged } = await import('./scripts/tags.js');
        onEntityTagsChanged();
    });
}

test.describe('a row on screen the page does not hold', () => {
    test('shows a tag put on it elsewhere, and the merge target of a tag deleted elsewhere', async ({ page }) => {
        await loadApp(page);
        // The page doesn't hear of the character itself, only of tag changes.
        await page.route('**/api/characters/changes', route => route.fulfill({ status: 500 }));
        const stamp = `${Date.now()}`;
        const name = `0000 TagRowUnheld ${stamp}`;
        const avatar = await createUnheldCharacter(page, name);

        await openCharacterManagementDrawer(page);
        await page.evaluate(async () => {
            const { printCharacters } = await import('./scripts/character-list.js');
            await printCharacters(true);
        });
        const row = page.locator(`#rm_print_characters_block .character_select[data-avatar="${avatar}"]`);
        await expect(row).toBeVisible();
        const held = await page.evaluate(async (avatar) => {
            const { charactersStore } = await import('./scripts/character-store.js');
            return charactersStore.has(avatar);
        }, avatar);
        expect(held).toBe(false);

        await createTag(page, `rowtag-${stamp}`, `RowTag ${stamp}`);
        await createTag(page, `target-${stamp}`, `Target ${stamp}`);
        await api(page, '/api/tags/assign', { id: avatar, tagId: `rowtag-${stamp}` });
        await takeInEntityTagChanges(page);
        await expect(row.locator('.tag')).toHaveText([`RowTag ${stamp}`]);

        await api(page, '/api/tags/delete', { id: `rowtag-${stamp}`, mergeInto: `target-${stamp}` });
        await page.evaluate(async () => {
            const { onTagsChanged } = await import('./scripts/tags.js');
            onTagsChanged();
        });
        await expect(row.locator('.tag')).toHaveText([`Target ${stamp}`]);
    });
});
