import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// Finding a tag by its name, in the tag input, the slash commands, a card's tag import, the delete popup's merge
// picker and a lorebook entry's character filter, asks the server: none of them needs the page to hold the tag. Each
// test makes its tags after the page has loaded and keeps the page from hearing of them, so the page doesn't hold
// them.

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
 * Keeps the page from hearing of tags made after this, as if they were made in another tab whose changes haven't
 * reached it.
 * @param {import('@playwright/test').Page} page
 */
async function cutOffTagChanges(page) {
    await page.route('**/api/tags/changes', route => route.fulfill({ status: 500 }));
}

/**
 * Creates tags the page doesn't hold.
 * @param {import('@playwright/test').Page} page
 * @param {{ id: string, name: string }[]} list
 */
async function createUnheldTags(page, list) {
    for (let i = 0; i < list.length; i += 25) {
        await Promise.all(list.slice(i, i + 25).map(({ id, name }) => api(page, '/api/tags/create', {
            tag: { id, name, folder_type: 'NONE', is_hidden_on_character_card: false, color: '', color2: '', create_date: 1 },
        })));
    }
    const held = await page.evaluate(ids => window['SillyTavern'].getContext().tags.filter(tag => ids.includes(tag.id)).length, list.map(x => x.id));
    expect(held).toBe(0);
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
    const created = page.waitForResponse(response => response.url().endsWith('/api/characters/create'));
    await page.locator('#create_button_label').click();
    const avatar = await (await created).text();
    await page.locator('.character_select', { hasText: name }).first().click();
    await page.locator('#tagInput').waitFor({ state: 'visible', timeout: 10000 });
    return avatar;
}

/**
 * Types into the character's tag input and waits for its suggestions.
 * @param {import('@playwright/test').Page} page
 * @param {string} text
 * @returns {Promise<string[]>} the suggestions shown
 */
async function suggestionsFor(page, text) {
    const searched = page.waitForResponse(response => new URL(response.url()).pathname === '/api/tags/query'
        && response.request().postDataJSON()?.filter?.contains === text.trim());
    const lookedUp = page.waitForResponse(response => new URL(response.url()).pathname === '/api/tags/by-names'
        && response.request().postDataJSON()?.names?.[0] === text);
    // The chat that opens with the character takes the focus when it has loaded; text filled before that is lost.
    await expect(async () => {
        await page.locator('#tagInput').fill(text);
        await expect(page.locator('#tagInput')).toHaveValue(text, { timeout: 500 });
    }).toPass({ timeout: 30000 });
    await Promise.all([searched, lookedUp]);
    // The suggestions are drawn once both answers are in; an empty list draws nothing to wait for.
    await page.waitForTimeout(300);
    return page.locator('.ui-autocomplete:visible .ui-menu-item').allInnerTexts();
}

/** @param {import('@playwright/test').Page} page @param {string} key @returns {Promise<string[]>} */
async function serverTagsOf(page, key) {
    return (await api(page, '/api/tags/for', { ids: [key] }))[key] ?? [];
}

/**
 * Counts the /api/tags/create requests the page sends from now on.
 * @param {import('@playwright/test').Page} page
 */
function countCreates(page) {
    const sent = [];
    page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/tags/create') sent.push(request.postDataJSON());
    });
    return sent;
}

test.describe('tag names are looked up on the server', () => {
    test.setTimeout(120000);

    test.beforeEach(async ({ page }) => {
        await loadApp(page);
        await cutOffTagChanges(page);
    });

    test('the tag input suggests a tag the page doesn\'t hold by the middle of its name, and picking it adds that tag', async ({ page }) => {
        const stamp = `${Date.now()}`;
        const avatar = await openNewCharacter(page, `TagNames-${stamp}`);
        await createUnheldTags(page, [{ id: `zebra-${stamp}`, name: `Zebra Stripes ${stamp}` }]);
        const creates = countCreates(page);

        // The typed text first, as a new tag to create, since no tag has that name.
        expect(await suggestionsFor(page, `bra Stripes ${stamp}`)).toEqual([`bra Stripes ${stamp}`, `Zebra Stripes ${stamp}`]);

        const assigned = page.waitForRequest(request => request.url().endsWith('/api/tags/assign'));
        await page.locator('.ui-autocomplete .ui-menu-item').getByText(`Zebra Stripes ${stamp}`, { exact: true }).click();
        expect((await assigned).postDataJSON()).toEqual(expect.objectContaining({ id: avatar, tagId: `zebra-${stamp}` }));
        await expect.poll(() => serverTagsOf(page, avatar)).toEqual([`zebra-${stamp}`]);
        expect(creates).toEqual([]);
    });

    test('a typed name a tag has offers that tag, not a new one; one already on the character is not offered', async ({ page }) => {
        const stamp = `${Date.now()}`;
        const avatar = await openNewCharacter(page, `TagNamesExact-${stamp}`);
        const name = `Exact Match ${stamp}`;
        await createUnheldTags(page, [{ id: `exact-${stamp}`, name }]);
        const creates = countCreates(page);

        expect(await suggestionsFor(page, name.toLowerCase())).toEqual([name]);
        const assigned = page.waitForResponse(response => response.url().endsWith('/api/tags/assign'));
        await page.locator('.ui-autocomplete .ui-menu-item').getByText(name, { exact: true }).click();
        await assigned;
        await expect(page.locator(`#tagList .tag[id="exact-${stamp}"]`)).toBeVisible();

        expect(await suggestionsFor(page, name)).toEqual([]);
        expect(await serverTagsOf(page, avatar)).toEqual([`exact-${stamp}`]);
        expect(creates).toEqual([]);
    });

    test('/tag-add and /tag-exists with the name of a tag the page doesn\'t hold use that tag', async ({ page }) => {
        const stamp = `${Date.now()}`;
        const name = `TagNamesSlash-${stamp}`;
        const avatar = await openNewCharacter(page, name);
        await createUnheldTags(page, [{ id: `slash-${stamp}`, name: `Slash Tag ${stamp}` }]);
        const creates = countCreates(page);

        const results = await page.evaluate(async ({ name, stamp }) => {
            const context = window['SillyTavern'].getContext();
            const added = await context.executeSlashCommandsWithOptions(`/tag-add name="${name}" slash tag ${stamp}`);
            const exists = await context.executeSlashCommandsWithOptions(`/tag-exists name="${name}" SLASH TAG ${stamp}`);
            return [added.pipe, exists.pipe];
        }, { name, stamp });

        expect(results).toEqual(['true', 'true']);
        expect(await serverTagsOf(page, avatar)).toEqual([`slash-${stamp}`]);
        expect(creates).toEqual([]);
    });

    test('importing a card\'s tags adds the existing tag by name and creates only the new one, ordered by the server', async ({ page }) => {
        const stamp = `${Date.now()}`;
        const avatar = await openNewCharacter(page, `TagNamesImport-${stamp}`);
        await createUnheldTags(page, [{ id: `imported-${stamp}`, name: `Imported ${stamp}` }]);
        const creates = countCreates(page);

        const newName = `Brand New ${stamp}`;
        const added = await page.evaluate(async ({ avatar, stamp, newName }) => {
            const { importTags, tag_import_setting } = await import('./scripts/tags.js');
            return importTags({ avatar, name: 'x', tags: [`IMPORTED ${stamp}`, newName] }, { importSetting: tag_import_setting.ALL, suppressSuccessToast: true });
        }, { avatar, stamp, newName });
        expect(added).toBe(true);

        expect(creates.map(body => body.tag.name)).toEqual([newName]);
        expect(creates[0].tag).not.toHaveProperty('sort_order');
        const created = (await api(page, '/api/tags/by-names', { names: [newName] })).tags[0].tag;
        await expect.poll(async () => (await serverTagsOf(page, avatar)).sort()).toEqual([`imported-${stamp}`, created.id].sort());
        const pageOrder = await page.evaluate(id => window['SillyTavern'].getContext().tags.find(tag => tag.id === id)?.sort_order, created.id);
        expect(typeof created.sort_order).toBe('number');
        expect(pageOrder).toBe(created.sort_order);
    });

    test('the delete popup finds a merge target past the first 50 tags by name', async ({ page }) => {
        const stamp = `${Date.now()}`;
        const targets = Array.from({ length: 60 }, (_, i) => ({ id: `target-${stamp}-${String(i).padStart(2, '0')}`, name: `Target ${stamp} ${String(i).padStart(2, '0')}` }));
        await createUnheldTags(page, [{ id: `victim-${stamp}`, name: `Victim ${stamp}` }, ...targets]);

        await openCharacterManagementDrawer(page);
        await page.locator('.rm_tag_filter .manageTags:visible').first().click();
        await page.locator('#tag_view_list .tag_view_prune').waitFor({ state: 'visible', timeout: 10000 });
        await page.locator('#tag_view_search').fill(`Victim ${stamp}`);
        const victimRow = page.locator(`#tag_view_list .tag_view_item[id="victim-${stamp}"]`);
        await victimRow.locator('.tag_delete').click();

        await page.locator('dialog[open] .select2-selection').click();
        await page.locator('dialog[open] .select2-search__field').fill(`${stamp} 57`);
        const option = page.locator('.select2-results__option', { hasText: `Target ${stamp} 57` });
        await expect(option).toBeVisible();
        await option.click();

        const deleted = page.waitForRequest(request => request.url().endsWith('/api/tags/delete'));
        await page.locator('dialog[open] .popup-button-ok').last().click();
        expect((await deleted).postDataJSON()).toEqual(expect.objectContaining({ id: `victim-${stamp}`, mergeInto: `target-${stamp}-57` }));
    });

    test('a lorebook entry\'s character filter finds a tag the page doesn\'t hold, and shows its name when opened again', async ({ page }) => {
        const stamp = `${Date.now()}`;
        const worldName = `TagNamesWI_${stamp}`;
        await createUnheldTags(page, [{ id: `lore-${stamp}`, name: `Lore Tag ${stamp}` }]);

        await page.evaluate(async (worldName) => {
            const { createNewWorldInfo, createWorldInfoEntry, saveWorldInfo, loadWorldInfo } = await import('./scripts/world-info.js');
            if (!await createNewWorldInfo(worldName, { interactive: false })) throw new Error('no world');
            const data = await loadWorldInfo(worldName);
            const entry = await createWorldInfoEntry(worldName, data);
            entry.key = ['lore_keyword'];
            await saveWorldInfo(worldName, data, true);
        }, worldName);

        /** Opens the book's first entry, and returns its character filter's select2 box. */
        const openEntry = async () => {
            await page.evaluate(async (worldName) => {
                const { openWorldInfoEditor } = await import('./scripts/world-info.js');
                openWorldInfoEditor(worldName);
            }, worldName);
            const entryRow = page.locator('#world_popup_entries_list .world_entry').first();
            await entryRow.waitFor({ state: 'attached', timeout: 10000 });
            await entryRow.evaluate(row => $(row).find('.inline-drawer-toggle').first().trigger('click'));
            const filter = entryRow.locator('select[name="characterFilter"]');
            await filter.waitFor({ state: 'attached' });
            return entryRow;
        };

        try {
            const entryRow = await openEntry();
            await entryRow.locator('select[name="characterFilter"] + .select2-container .select2-selection').click();
            await page.keyboard.type(`ore Tag ${stamp}`);
            const option = page.locator('.select2-results__option', { hasText: `[Tag] Lore Tag ${stamp}` });
            await expect(option).toBeVisible();
            const saved = page.waitForRequest(request => request.url().endsWith('/api/worldinfo/entry/edit'));
            await option.click();
            expect((await saved).postDataJSON().data.characterFilter.tags).toEqual([`lore-${stamp}`]);

            // Picking it from the search didn't make the page hold it.
            expect(await page.evaluate(id => window['SillyTavern'].getContext().tags.some(tag => tag.id === id), `lore-${stamp}`)).toBe(false);
            const again = await openEntry();
            const choices = again.locator('select[name="characterFilter"] + .select2-container .select2-selection__choice');
            await expect(choices).toHaveCount(1);
            await expect(choices).toContainText(`[Tag] Lore Tag ${stamp}`);
        } finally {
            await page.evaluate(async (worldName) => {
                const { deleteWorldInfo } = await import('./scripts/world-info.js');
                await deleteWorldInfo(worldName);
            }, worldName);
        }
    });
});
