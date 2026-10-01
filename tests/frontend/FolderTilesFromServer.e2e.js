import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// The character list's folder tiles come from the server's folder tag query, not the page's tag list: a folder tag
// the page doesn't hold gets its tile, a search matches folder names anywhere in them, and when more folder tags
// exist than get a tile, a line under the tiles says how many.

/** @param {import('@playwright/test').Page} page */
async function loadApp(page) {
    await testSetup.awaitST({ page });
    // APP_READY is an auto-fire event: a listener added after it was emitted still runs.
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

/** @param {import('@playwright/test').Page} page @param {string} name @returns {Promise<string>} avatar */
async function createCharacter(page, name) {
    return page.evaluate(async (name) => {
        const headers = window['SillyTavern'].getContext().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.append('ch_name', name);
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create -> ${response.status}`);
        return response.text();
    }, name);
}

/**
 * Makes an open folder tag ahead of every tag made before, so it is among the first tiles whatever earlier tests left
 * in this worker's data, and puts it on a new character. The page doesn't hear of either.
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 * @param {string} name
 */
async function createUnheldFolder(page, id, name) {
    await page.route('**/api/tags/changes', route => route.fulfill({ status: 500 }));
    await api(page, '/api/tags/create', {
        tag: { id, name, folder_type: 'OPEN', sort_order: -Date.now(), is_hidden_on_character_card: false, color: '', color2: '', create_date: Date.now() },
    });
    const avatar = await createCharacter(page, `FolderTile-${id}`);
    await api(page, '/api/tags/assign', { id: avatar, tagId: id });
    expect(await page.evaluate(id => window['SillyTavern'].getContext().tags.some(tag => tag.id === id), id)).toBe(false);
}

/**
 * Turns "Tags as Folders" on, which redraws the list, and waits for the folder tag read that draw makes.
 * @param {import('@playwright/test').Page} page
 * @param {(body: any) => boolean} [matches]
 */
async function drawFolders(page, matches = () => true) {
    const read = page.waitForResponse(response => new URL(response.url()).pathname === '/api/tags/query'
        && response.request().postDataJSON()?.filter?.folders === true && matches(response.request().postDataJSON()));
    await page.evaluate(() => { $('#bogus_folders').prop('checked', true).trigger('input'); });
    await read;
}

/** @param {import('@playwright/test').Page} page @param {string} term */
async function setSearchTerm(page, term) {
    if (!(await page.locator('#character_search_bar').isVisible())) {
        await page.locator('#rm_button_search').click();
    }
    await page.locator('#character_search_bar').fill(term);
}

/** @param {import('@playwright/test').Page} page @param {string} id */
const tile = (page, id) => page.locator(`#rm_print_characters_block .bogus_folder_select[tagid="${id}"]`);
/** @param {import('@playwright/test').Page} page */
const restLine = page => page.locator('#rm_print_characters_block .folder_tiles_rest');

test.describe('folder tiles read their folder tags from the server', () => {
    test.setTimeout(120000);
    /** @type {string[]} */
    let made = [];

    test.beforeEach(async ({ page }) => {
        made = [];
        await loadApp(page);
        await openCharacterManagementDrawer(page);
    });

    test.afterEach(async ({ page }) => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        for (const id of made) await api(page, '/api/tags/delete', { id });
        // The setting is stored in this worker's data, which later tests share.
        const saved = page.waitForResponse(response => response.url().endsWith('/api/settings/save-partial')
            && response.request().postData()?.includes('bogus_folders'));
        await page.evaluate(() => { $('#bogus_folders').prop('checked', false).trigger('input'); });
        await saved;
    });

    test('a folder tag the page doesn\'t hold gets its tile', async ({ page }) => {
        const id = `folder-unheld-${Date.now()}`;
        made.push(id);
        await createUnheldFolder(page, id, id);

        await drawFolders(page);
        await expect(tile(page, id)).toBeVisible();
        await expect(tile(page, id).locator('.bogus_folder_counter')).toHaveText('1 character');
        await expect(restLine(page)).toHaveCount(0);
    });

    test('a search finds folders by text anywhere in their name', async ({ page }) => {
        const stamp = Date.now();
        const id = `folder-search-${stamp}`;
        const name = `Plover${stamp} Xyzzy`;
        made.push(id);
        await createUnheldFolder(page, id, name);
        await drawFolders(page);

        const term = `over${stamp} xyz`;
        const searched = page.waitForResponse(response => new URL(response.url()).pathname === '/api/tags/query'
            && response.request().postDataJSON()?.filter?.folders === true
            && response.request().postDataJSON()?.filter?.contains === term);
        await setSearchTerm(page, term);
        await searched;
        await expect(tile(page, id)).toBeVisible();
        await expect(tile(page, id).locator('.ch_name')).toHaveText(name);

        await setSearchTerm(page, '');
    });

    test('when more folder tags exist than get a tile, a line under the tiles says how many', async ({ page }) => {
        const id = `folder-rest-${Date.now()}`;
        made.push(id);
        await createUnheldFolder(page, id, id);

        /** @type {{ count: number, more: boolean }} */
        let rest = { count: 1234, more: false };
        await page.route('**/api/tags/query', async (route) => {
            if (route.request().postDataJSON()?.filter?.folders !== true) return route.continue();
            const response = await route.fetch();
            const answer = await response.json();
            await route.fulfill({ response, json: { ...answer, cursor: answer.cursor ?? 'next', rest } });
        });

        await drawFolders(page);
        await expect(tile(page, id)).toBeVisible();
        await expect(restLine(page)).toHaveText('1,234 more folders have no tile here. Search for a folder\'s name to find it.');
        // The line sits right after the last tile.
        expect(await restLine(page).evaluate(el => el.previousElementSibling?.classList.contains('bogus_folder_select'))).toBe(true);

        rest = { count: 10000, more: true };
        await drawFolders(page);
        await expect(restLine(page)).toHaveText('10,000+ more folders have no tile here. Search for a folder\'s name to find it.');
    });

    test('folder tags that can\'t be read are said to be missing, and the list still shows', async ({ page }) => {
        const avatar = await createCharacter(page, `FolderTileFail-${Date.now()}`);
        await page.route('**/api/tags/query', route => route.request().postDataJSON()?.filter?.folders === true
            ? route.fulfill({ status: 500 })
            : route.continue());

        await drawFolders(page);
        await expect(restLine(page)).toHaveText('Folders could not be loaded.');
        await setSearchTerm(page, 'FolderTileFail-');
        await expect(page.locator(`#rm_print_characters_block .character_select[data-avatar="${avatar}"]`)).toBeVisible();
        await setSearchTerm(page, '');
    });
});
