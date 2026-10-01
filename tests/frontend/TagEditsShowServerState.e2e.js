import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// Creating a tag, renaming it, recolouring it, changing its folder type, and putting it on or taking it off a
// character: the page shows the change only if the server stored it. One that wasn't stored is said to the user and
// the page shows what the server has. A name that wasn't stored stays in its field, marked, and survives a reload.

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

/**
 * Creates tags from a throwaway context, so the page under test learns of them only through its own boot.
 * @param {import('@playwright/test').Browser} browser
 * @param {{ id: string, name?: string, color?: string }[]} tags
 */
async function createTags(browser, tags) {
    const setupContext = await browser.newContext();
    try {
        const setup = await setupContext.newPage();
        await loadApp(setup);
        for (const { id, name = id, color = '' } of tags) {
            await api(setup, '/api/tags/create', {
                tag: {
                    id, name, folder_type: 'NONE', filter_state: 'UNDEFINED', sort_order: 1000,
                    is_hidden_on_character_card: false, create_date: Date.now(), color, color2: '',
                },
            });
        }
    } finally {
        await setupContext.close();
    }
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 * @returns {Promise<Record<string, any> | null>} the tag as the server stores it
 */
async function storedTag(page, id) {
    const { tags } = await api(page, '/api/tags/by-ids', { ids: [id] });
    return tags[0] ?? null;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 * @returns {Promise<Record<string, any> | null>} the tag as the page holds it
 */
function pageTag(page, id) {
    return page.evaluate(async id => {
        const tag = (await import('/scripts/tags.js')).tagsStore.getAll().find(tag => tag.id === id);
        return tag ? { ...tag } : null;
    }, id);
}

/** @param {import('@playwright/test').Page} page */
async function openTagManagement(page) {
    await openCharacterManagementDrawer(page);
    await page.locator('.rm_tag_filter .manageTags:visible').first().click();
    await page.locator('#tag_view_list .tag_view_prune').waitFor({ state: 'visible', timeout: 10000 });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} path
 * @returns {string[]} the body of every request the page sends to `path` from now on
 */
function recordRequests(page, path) {
    /** @type {string[]} */
    const bodies = [];
    page.on('request', request => {
        if (new URL(request.url()).pathname === path) bodies.push(request.postData());
    });
    return bodies;
}

/**
 * Creates and opens a throwaway character.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @returns {Promise<string>} its avatar key
 */
async function openNewCharacter(page, name) {
    await openCharacterManagementDrawer(page);
    await page.locator('#rm_button_create').click();
    await page.locator('#character_name_pole').fill(name);
    await page.locator('#create_button_label').click();
    await page.locator('.character_select', { hasText: name }).first().click();
    await page.locator('#tagInput').waitFor({ state: 'visible', timeout: 10000 });
    return await page.evaluate(() => {
        const context = window['SillyTavern'].getContext();
        return context.characters[context.characterId].avatar;
    });
}

/**
 * Picks `tagName` in the open character's tag input.
 * @param {import('@playwright/test').Page} page
 * @param {string} tagName
 */
async function pickInTagInput(page, tagName) {
    // The chat that opens with the character takes the focus when it has loaded; text filled before that is lost.
    await expect(async () => {
        await page.locator('#tagInput').fill(tagName);
        await expect(page.locator('#tagInput')).toHaveValue(tagName, { timeout: 500 });
    }).toPass({ timeout: 30000 });
    await page.locator('.ui-autocomplete .ui-menu-item').getByText(tagName, { exact: true }).click();
}

/** @param {import('@playwright/test').Page} page @param {string} avatar @returns {Promise<string[]>} */
function pageCharacterTagIds(page, avatar) {
    return page.evaluate(avatar => {
        const character = window['SillyTavern'].getContext().characters.find(c => c.avatar === avatar);
        return [...(character.tag_ids ?? [])];
    }, avatar);
}

/** @param {import('@playwright/test').Page} page @param {string} avatar @returns {Promise<string[]>} */
async function storedCharacterTagIds(page, avatar) {
    return (await api(page, '/api/tags/for', { ids: [avatar] }))[avatar];
}

const FAIL = { status: 500, body: '{}' };

test.describe('Tag edits show what the server stored', () => {
    test.setTimeout(180000);

    test('New Tag adds nothing and says so when the create fails, and adds the tag once it is stored', async ({ page }) => {
        await loadApp(page);
        await openTagManagement(page);
        const rows = page.locator('#tag_view_list .tag_view_item');
        const rowsBefore = await rows.count();
        const tagsBefore = await page.evaluate(async () => (await import('/scripts/tags.js')).tagsStore.getAll().length);

        await page.route('**/api/tags/create', route => route.fulfill(FAIL));
        await page.locator('#tag_view_list .tag_view_create').click();
        await expect(page.locator('.toast-error', { hasText: 'Tags could not be created' })).toBeVisible();
        await expect(page.locator('.toast-success', { hasText: 'Tag created' })).toHaveCount(0);
        expect(await rows.count()).toBe(rowsBefore);
        expect(await page.evaluate(async () => (await import('/scripts/tags.js')).tagsStore.getAll().length)).toBe(tagsBefore);
        await page.unroute('**/api/tags/create');

        const creates = recordRequests(page, '/api/tags/create');
        await page.locator('#tag_view_list .tag_view_create').click();
        await expect(page.locator('.toast-success', { hasText: 'Tag created' })).toBeVisible();
        expect(creates).toHaveLength(1);
        const { id, name } = JSON.parse(creates[0]).tag;
        await expect(page.locator(`#tag_view_list .tag_view_item[id="${id}"] .tag_view_name`)).toHaveText(name);
        expect(await storedTag(page, id)).toEqual(expect.objectContaining({ name }));
        expect(await pageTag(page, id)).toEqual(expect.objectContaining({ name }));
    });

    test('a rename is sent when Enter is pressed, not while typing', async ({ browser, page }) => {
        const id = `edit-rename-${Date.now()}`;
        await createTags(browser, [{ id }]);
        await loadApp(page);
        await openTagManagement(page);

        const edits = recordRequests(page, '/api/tags/edit');
        const name = page.locator(`#tag_view_list .tag_view_item[id="${id}"] .tag_view_name`);
        await name.click();
        await page.keyboard.press('End');
        await page.keyboard.type('-new');
        await expect(name).toHaveClass(/tag_view_name_unsaved/);
        // Longer than any debounce between typing and a request.
        await page.waitForTimeout(1500);
        expect(edits).toEqual([]);
        expect((await pageTag(page, id)).name).toBe(id);

        await page.keyboard.press('Enter');
        await expect.poll(() => storedTag(page, id).then(tag => tag.name)).toBe(`${id}-new`);
        expect(edits).toEqual([JSON.stringify({ id, patch: { name: `${id}-new` } })]);
        await expect.poll(() => pageTag(page, id).then(tag => tag.name)).toBe(`${id}-new`);
        const renamed = page.locator(`#tag_view_list .tag_view_item[id="${id}"] .tag_view_name`);
        await expect(renamed).toHaveText(`${id}-new`);
        await expect(renamed).not.toHaveClass(/tag_view_name_unsaved/);
        expect(await page.evaluate(id => localStorage.getItem(`TagNameDraft:${id}`), id)).toBeNull();
    });

    test('a rename that could not be stored keeps the typed name, marked, across a reload, and saves on a later Enter', async ({ browser, page }) => {
        const id = `edit-rename-failed-${Date.now()}`;
        await createTags(browser, [{ id }]);
        await loadApp(page);
        await openTagManagement(page);

        await page.route('**/api/tags/edit', route => route.fulfill(FAIL));
        let name = page.locator(`#tag_view_list .tag_view_item[id="${id}"] .tag_view_name`);
        await name.click();
        await page.keyboard.press('End');
        await page.keyboard.type('-typed');
        await page.keyboard.press('Enter');
        await expect(page.locator('.toast-error', { hasText: 'It was not renamed' })).toBeVisible();
        await expect(name).toHaveText(`${id}-typed`);
        await expect(name).toHaveClass(/tag_view_name_unsaved/);
        expect((await pageTag(page, id)).name).toBe(id);
        await page.unroute('**/api/tags/edit');
        expect((await storedTag(page, id)).name).toBe(id);

        await page.reload();
        await loadApp(page);
        await openTagManagement(page);
        name = page.locator(`#tag_view_list .tag_view_item[id="${id}"] .tag_view_name`);
        await expect(name).toHaveText(`${id}-typed`);
        await expect(name).toHaveClass(/tag_view_name_unsaved/);
        expect((await pageTag(page, id)).name).toBe(id);

        await name.click();
        await page.keyboard.press('Enter');
        await expect.poll(() => storedTag(page, id).then(tag => tag.name)).toBe(`${id}-typed`);
        await expect.poll(() => pageTag(page, id).then(tag => tag.name)).toBe(`${id}-typed`);
        await expect(page.locator(`#tag_view_list .tag_view_item[id="${id}"] .tag_view_name`)).not.toHaveClass(/tag_view_name_unsaved/);
    });

    test('a colour that could not be stored puts the row and its picker back and says so', async ({ browser, page }) => {
        const id = `edit-colour-${Date.now()}`;
        await createTags(browser, [{ id, color: 'rgba(10, 20, 30, 1)' }]);
        await loadApp(page);
        await openTagManagement(page);

        const row = page.locator(`#tag_view_list .tag_view_item[id="${id}"]`);
        const picker = row.locator('toolcool-color-picker.tag-color');
        await expect.poll(() => picker.evaluate(el => el['rgba'])).toBe('rgba(10, 20, 30, 1)');

        await page.route('**/api/tags/edit', route => route.fulfill(FAIL));
        await picker.evaluate(el => { el['color'] = 'rgba(200, 10, 10, 1)'; });
        await expect(page.locator('.toast-error', { hasText: 'Its colour was not changed' })).toBeVisible();
        await expect.poll(() => picker.evaluate(el => el['rgba'])).toBe('rgba(10, 20, 30, 1)');
        await expect(row.locator('.tag_view_name')).toHaveCSS('background-color', 'rgb(10, 20, 30)');
        expect((await pageTag(page, id)).color).toBe('rgba(10, 20, 30, 1)');
        await page.unroute('**/api/tags/edit');
        expect((await storedTag(page, id)).color).toBe('rgba(10, 20, 30, 1)');

        await picker.evaluate(el => { el['color'] = 'rgba(0, 100, 0, 1)'; });
        await expect.poll(() => storedTag(page, id).then(tag => tag.color)).toBe('rgba(0, 100, 0, 1)');
        await expect.poll(() => pageTag(page, id).then(tag => tag.color)).toBe('rgba(0, 100, 0, 1)');
    });

    test('a folder type that could not be stored leaves the tag as it was and says so', async ({ browser, page }) => {
        const id = `edit-folder-${Date.now()}`;
        await createTags(browser, [{ id }]);
        await loadApp(page);
        // The folder button only shows with "Tags as Folders" on.
        await page.evaluate(() => { window['SillyTavern'].getContext().powerUserSettings.bogus_folders = true; });
        await openTagManagement(page);

        const button = page.locator(`#tag_view_list .tag_view_item[id="${id}"] .tag_as_folder`);
        const titleBefore = await button.getAttribute('title');

        await page.route('**/api/tags/edit', route => route.fulfill(FAIL));
        await button.click();
        await expect(page.locator('.toast-error', { hasText: 'Its folder type was not changed' })).toBeVisible();
        await expect(button).toHaveAttribute('title', titleBefore);
        expect((await pageTag(page, id)).folder_type).toBe('NONE');
        await page.unroute('**/api/tags/edit');
        expect((await storedTag(page, id)).folder_type).toBe('NONE');

        await button.click();
        await expect.poll(() => storedTag(page, id).then(tag => tag.folder_type)).not.toBe('NONE');
        const stored = (await storedTag(page, id)).folder_type;
        await expect.poll(() => pageTag(page, id).then(tag => tag.folder_type)).toBe(stored);
        await expect(button).not.toHaveAttribute('title', titleBefore);
    });

    test('a tag that could not be put on a character is taken off it again, and one that could not be taken off is put back', async ({ browser, page }) => {
        const stamp = Date.now();
        const id = `edit-assign-${stamp}`;
        await createTags(browser, [{ id }]);
        await loadApp(page);
        const avatar = await openNewCharacter(page, `TagEditsShowServerState-${stamp}`);
        const pill = page.locator(`#tagList .tag[id="${id}"]`);

        await page.route('**/api/tags/assign', route => route.fulfill(FAIL));
        await pickInTagInput(page, id);
        await expect(page.locator('.toast-error', { hasText: `'${id}' was not added to TagEditsShowServerState-${stamp}` })).toBeVisible();
        await expect(pill).toHaveCount(0);
        expect(await pageCharacterTagIds(page, avatar)).toEqual([]);
        await page.unroute('**/api/tags/assign');
        expect(await storedCharacterTagIds(page, avatar)).toEqual([]);

        const assigned = page.waitForResponse(response => response.url().endsWith('/api/tags/assign'));
        await pickInTagInput(page, id);
        await assigned;
        await expect(pill).toHaveCount(1);
        expect(await storedCharacterTagIds(page, avatar)).toEqual([id]);

        await page.route('**/api/tags/unassign', route => route.fulfill(FAIL));
        // The tag input reopens its list after a pick; it closes when the input is left.
        await page.locator('#tagInput').blur();
        await expect(page.locator('.ui-autocomplete:visible')).toHaveCount(0);
        // Remove buttons are in the tags drawer, which starts collapsed.
        await page.locator('#tags_div > .inline-drawer-header .inline-drawer-icon').click();
        await pill.locator('.tag_remove').click();
        await expect(page.locator('.toast-error', { hasText: `'${id}' was not removed from TagEditsShowServerState-${stamp}` })).toBeVisible();
        await expect(pill).toHaveCount(1);
        expect(await pageCharacterTagIds(page, avatar)).toEqual([id]);
        await page.unroute('**/api/tags/unassign');
        expect(await storedCharacterTagIds(page, avatar)).toEqual([id]);
    });

    test('a new tag typed into the tag input is put on the character only once the server has stored the tag', async ({ page }) => {
        const stamp = Date.now();
        const tagName = `edit-input-new-${stamp}`;
        await loadApp(page);
        const avatar = await openNewCharacter(page, `TagEditsShowServerStateNew-${stamp}`);
        const assigns = recordRequests(page, '/api/tags/assign');

        await page.route('**/api/tags/create', route => route.fulfill(FAIL));
        await pickInTagInput(page, tagName);
        await expect(page.locator('.toast-error', { hasText: 'Tags could not be created' })).toBeVisible();
        await expect(page.locator('#tagList .tag')).toHaveCount(0);
        expect(await pageCharacterTagIds(page, avatar)).toEqual([]);
        expect(await page.evaluate(async name => (await import('/scripts/tags.js')).tagsStore.getAll().some(tag => tag.name === name), tagName)).toBe(false);
        expect(assigns).toEqual([]);
        await page.unroute('**/api/tags/create');

        const assigned = page.waitForResponse(response => response.url().endsWith('/api/tags/assign'));
        await pickInTagInput(page, tagName);
        await assigned;
        const id = await page.evaluate(async name => (await import('/scripts/tags.js')).tagsStore.getAll().find(tag => tag.name === name).id, tagName);
        await expect(page.locator(`#tagList .tag[id="${id}"]`)).toHaveCount(1);
        expect(await storedCharacterTagIds(page, avatar)).toEqual([id]);
        expect((await storedTag(page, id)).name).toBe(tagName);
    });
});
