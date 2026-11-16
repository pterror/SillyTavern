import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

/** @param {import('@playwright/test').Page} page */
async function loadApp(page) {
    await testSetup.awaitST({ page });
    await page.evaluate(() => {
        window['__appReady'] = false;
        const { eventSource, eventTypes } = window['stTest'].context();
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
        const headers = window['stTest'].context().getRequestHeaders();
        const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!response.ok) throw new Error(`${path} -> ${response.status}`);
        return response.json();
    }, { path, body });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @returns {Promise<string>}
 */
async function createCharacter(page, name) {
    return page.evaluate(async (name) => {
        const headers = window['stTest'].context().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.append('ch_name', name);
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create -> ${response.status}`);
        return response.text();
    }, name);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 * @param {string} name
 * @param {'OPEN'|'CLOSED'} folderType
 */
async function createFolder(page, id, name, folderType) {
    await api(page, '/api/tags/create', {
        tag: { id, name, folder_type: folderType, sort_order: -Date.now(), is_hidden_on_character_card: false, color: '', color2: '', create_date: Date.now() },
    });
}

/** @param {import('@playwright/test').Page} page */
async function showTagBar(page) {
    const toggle = page.locator('#rm_characters_block .rm_tag_filter .showTagList');
    if (!(await toggle.evaluate(element => element.classList.contains('selected')))) await toggle.click();
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} term
 */
async function setSearchTerm(page, term) {
    if (!(await page.locator('#character_search_bar').isVisible())) {
        await page.locator('#rm_button_search').click();
    }
    await page.locator('#character_search_bar').fill(term);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
const row = (page, avatar) => page.locator(`#rm_print_characters_block .character_select[data-avatar="${avatar}"]`);
/**
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 */
const caseChip = (page, id) => page.locator(`#character_folder_switcher .folder_case[data-folder-case="${id}"]`);

test.describe('folders', () => {
    test.setTimeout(120000);
    /** @type {string[]} */
    let made = [];
    /** @type {{ id: string, folder_type: string }[]} */
    let unfoldered = [];

    test.beforeEach(async ({ page }) => {
        made = [];
        unfoldered = [];
        await loadApp(page);
        await openCharacterManagementDrawer(page);
    });

    test.afterEach(async ({ page }) => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await setSearchTerm(page, '').catch(() => {});
        for (const id of made) await api(page, '/api/tags/delete', { id });
        for (const { id, folder_type } of unfoldered) await api(page, '/api/tags/edit', { id, patch: { folder_type } });
    });

    test('there is no "Tags as folders" setting and no "Show only folders" pill', async ({ page }) => {
        await expect(page.locator('#bogus_folders')).toHaveCount(0);
        expect(await page.evaluate(() => Object.hasOwn(window['stTest'].context().powerUserSettings, 'bogus_folders'))).toBe(false);
        await expect(page.locator('#rm_characters_block .rm_tag_filter .tag.filterByFavorites')).toHaveCount(1);
        await expect(page.locator('#rm_characters_block .rm_tag_filter .tag.filterByFolder')).toHaveCount(0);
    });

    test('with no closed folder, the switcher stays hidden, and printing the list again neither lists folders nor redraws the tag bar', async ({ page }) => {
        const stamp = Date.now();
        const tagId = `plain-${stamp}`;
        made.push(tagId);
        await api(page, '/api/tags/create', {
            tag: { id: tagId, name: `Plain ${stamp}`, folder_type: 'NONE', sort_order: -Date.now(), is_hidden_on_character_card: false, color: '', color2: '', create_date: Date.now() },
        });
        const card = await createCharacter(page, `NoFolder${stamp}`);
        await api(page, '/api/tags/assign', { id: card, tagId });
        for (const folderType of ['OPEN', 'CLOSED']) {
            const { rows } = await api(page, '/api/tags/query', { filter: { folderType }, sort: { field: 'alphabetical' }, pageSize: 500 });
            for (const tag of rows) {
                unfoldered.push({ id: tag.id, folder_type: folderType });
                await api(page, '/api/tags/edit', { id: tag.id, patch: { folder_type: 'NONE' } });
            }
        }

        let folderLists = 0;
        await page.route('**/api/tags/query', async route => {
            if (route.request().postDataJSON()?.filter?.folderType !== 'CLOSED') return route.fallback();
            folderLists++;
            await route.fulfill({ json: { rows: [], cursor: null } });
        });
        await page.reload();
        await loadApp(page);
        await openCharacterManagementDrawer(page);
        await showTagBar(page);
        const pill = page.locator(`#rm_characters_block .rm_tag_filter .tag[id="${tagId}"]`);
        await expect(pill).toBeVisible();
        await expect.poll(() => folderLists).toBeGreaterThan(0);
        await expect(page.locator('#character_folder_switcher')).toBeHidden();

        await setSearchTerm(page, `NoFolder${stamp}`);
        await expect(row(page, card)).toBeVisible();
        await setSearchTerm(page, '');
        await expect(pill).toBeVisible();

        const listed = folderLists;
        await pill.evaluate(element => { element['__drawnBefore'] = true; });
        await page.evaluate(async () => (await import('/scripts/character-list.js')).printCharacters());
        await page.evaluate(async () => (await import('/scripts/character-list.js')).printCharacters());
        expect(folderLists).toBe(listed);
        expect(await pill.evaluate(element => element['__drawnBefore'] === true)).toBe(true);
        await expect(page.locator('#character_folder_switcher')).toBeHidden();
        await expect(page.locator('#rm_characters_block .rm_tag_bogus_drilldown .tag')).toHaveCount(0);
    });

    test('a tag made a closed folder in Manage tags becomes a case of the switcher', async ({ page }) => {
        const stamp = Date.now();
        const tagId = `made-closed-${stamp}`;
        made.push(tagId);
        await createFolder(page, tagId, `Later ${stamp}`, 'OPEN');
        const inside = await createCharacter(page, `Later${stamp}`);
        await api(page, '/api/tags/assign', { id: inside, tagId });
        await setSearchTerm(page, `Later${stamp}`);
        await expect(row(page, inside)).toBeVisible();
        await expect(caseChip(page, tagId)).toHaveCount(0);

        await api(page, '/api/tags/edit', { id: tagId, patch: { folder_type: 'CLOSED' } });
        await expect(caseChip(page, tagId)).toBeVisible();
        await expect(row(page, inside)).toHaveCount(0);
    });

    test('a closed folder\'s characters show under its case, the rest under "No folder"', async ({ page }) => {
        const stamp = Date.now();
        const folderId = `closed-${stamp}`;
        made.push(folderId);
        await createFolder(page, folderId, `Vault ${stamp}`, 'CLOSED');
        const inside = await createCharacter(page, `Switch${stamp} Inside`);
        const outside = await createCharacter(page, `Switch${stamp} Outside`);
        await api(page, '/api/tags/assign', { id: inside, tagId: folderId });

        await setSearchTerm(page, `Switch${stamp}`);
        await expect(caseChip(page, 'none')).toHaveClass(/current/);
        await expect(caseChip(page, folderId)).toBeVisible();
        await expect(row(page, outside)).toBeVisible();
        await expect(row(page, inside)).toHaveCount(0);
        await expect(page.locator('#rm_print_characters_block .bogus_folder_select')).toHaveCount(0);

        await caseChip(page, folderId).click();
        await expect(row(page, inside)).toBeVisible();
        await expect(row(page, outside)).toHaveCount(0);
        await expect(caseChip(page, folderId)).toHaveClass(/current/);

        await page.reload();
        await loadApp(page);
        await openCharacterManagementDrawer(page);
        await setSearchTerm(page, `Switch${stamp}`);
        await expect(caseChip(page, folderId)).toHaveClass(/current/);
        await expect(row(page, inside)).toBeVisible();
        await expect(row(page, outside)).toHaveCount(0);

        await caseChip(page, 'none').click();
        await expect(row(page, outside)).toBeVisible();
        await expect(row(page, inside)).toHaveCount(0);
    });

    test('a character in two closed folders shows under both', async ({ page }) => {
        const stamp = Date.now();
        const a = `closed-a-${stamp}`;
        const b = `closed-b-${stamp}`;
        made.push(a, b);
        await createFolder(page, a, `Ward A ${stamp}`, 'CLOSED');
        await createFolder(page, b, `Ward B ${stamp}`, 'CLOSED');
        const both = await createCharacter(page, `Twice${stamp}`);
        await api(page, '/api/tags/assign', { id: both, tagId: a });
        await api(page, '/api/tags/assign', { id: both, tagId: b });
        await setSearchTerm(page, `Twice${stamp}`);

        await expect(row(page, both)).toHaveCount(0);
        await caseChip(page, a).click();
        await expect(row(page, both)).toBeVisible();
        await caseChip(page, b).click();
        await expect(row(page, both)).toBeVisible();
    });

    test('upstream\'s chooseBogusFolder() picks a closed folder\'s case', async ({ page }) => {
        const stamp = Date.now();
        const folderId = `closed-up-${stamp}`;
        made.push(folderId);
        await createFolder(page, folderId, `Crypt ${stamp}`, 'CLOSED');
        const inside = await createCharacter(page, `Upstream${stamp}`);
        await api(page, '/api/tags/assign', { id: inside, tagId: folderId });
        await setSearchTerm(page, `Upstream${stamp}`);
        await expect(caseChip(page, folderId)).toBeVisible();

        await page.evaluate(async id => (await import('/scripts/tags.js')).chooseBogusFolder(null, id), folderId);
        await expect(caseChip(page, folderId)).toHaveClass(/current/);
        await expect(row(page, inside)).toBeVisible();
        expect(await page.evaluate(async () => (await import('/scripts/tags.js')).isBogusFolderOpen())).toBe(true);

        await page.evaluate(async id => (await import('/scripts/tags.js')).chooseBogusFolder(null, id, true), folderId);
        await expect(caseChip(page, 'none')).toHaveClass(/current/);
    });

    test('with more closed folders than fit on a row, the switcher folds into a searchable list', async ({ page }) => {
        const stamp = Date.now();
        const ids = Array.from({ length: 60 }, (_, i) => `closed-many-${stamp}-${i}`);
        made.push(...ids);
        for (const [i, id] of ids.entries()) await createFolder(page, id, `Shelf ${stamp} ${String(i).padStart(2, '0')}`, 'CLOSED');
        const inside = await createCharacter(page, `Folded${stamp}`);
        await api(page, '/api/tags/assign', { id: inside, tagId: ids[0] });
        await setSearchTerm(page, `Folded${stamp}`);

        const button = page.locator('#character_folder_switcher .folder_case_button');
        await expect(button).toBeVisible();
        await expect(page.locator('#character_folder_switcher .folder_case')).toHaveCount(0);
        await button.click();
        const popover = page.locator('.folder_case_popover');
        await popover.locator('input[type="search"]').fill(`Shelf ${stamp} 00`);
        await popover.locator(`.view_picker_row[data-folder-case="${ids[0]}"] .view_picker_row_name`).click();
        await expect(row(page, inside)).toBeVisible();
        await expect(button.locator('.folder_case_label')).toHaveText(`Shelf ${stamp} 00`);

        await button.click();
        await page.keyboard.press('Escape');
        await expect(popover).toHaveCount(0);
        await expect(page.locator('#rm_button_create')).toBeVisible();
    });

    test('an open folder is a view in the picker\'s Folders section', async ({ page }) => {
        const stamp = Date.now();
        const folderId = `open-${stamp}`;
        made.push(folderId);
        await createFolder(page, folderId, `Shelf ${stamp}`, 'OPEN');
        const inside = await createCharacter(page, `OpenView${stamp} In`);
        const outside = await createCharacter(page, `OpenView${stamp} Out`);
        await api(page, '/api/tags/assign', { id: inside, tagId: folderId });
        await setSearchTerm(page, '');

        await page.locator('#character_view_picker').click();
        const folderRow = page.locator(`.view_picker_popover .view_picker_folder[data-view-id="folder:${folderId}"]`);
        await expect(folderRow).toBeVisible();
        await folderRow.locator('.view_picker_row_name').click();
        await expect(page.locator('#character_view_picker .view_picker_name')).toHaveText(`Shelf ${stamp}`);
        await setSearchTerm(page, `OpenView${stamp}`);
        await expect(row(page, inside)).toBeVisible();
        await expect(row(page, outside)).toHaveCount(0);

        await page.locator('#character_view_picker').click();
        await expect(page.locator('.view_picker_unsaved [data-action="save"]')).toHaveCount(0);
        await expect(page.locator('.view_picker_unsaved [data-action="save-as"]')).toBeVisible();
        await page.keyboard.press('Escape');
    });
});
