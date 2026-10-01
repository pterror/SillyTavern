import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, holdCharacters } from './frontent-test-utils.js';

// Deleting a tag from the tag manager, with or without a tag to merge it into, sends one request naming the merge
// target. The server applies it to every card carrying the deleted tag, including cards this page never loaded, or
// refuses it, and the page shows what the server did.

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
        const text = await response.text();
        try { return JSON.parse(text); } catch { return text; }
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

/** @param {import('@playwright/test').Page} page @param {string} name @returns {Promise<string>} tag id */
async function createTag(page, name) {
    const id = `tag-delete-merge-${name}`;
    await api(page, '/api/tags/create', {
        tag: {
            id, name, folder_type: 'NONE', filter_state: 'UNDEFINED', sort_order: 1000,
            is_hidden_on_character_card: false, color: '', color2: '', create_date: Date.now(),
        },
    });
    return id;
}

/**
 * @param {import('@playwright/test').Browser} browser
 * @param {(page: import('@playwright/test').Page) => Promise<T>} fn
 * @template T
 */
async function withSetupPage(browser, fn) {
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        await loadApp(page);
        return await fn(page);
    } finally {
        await context.close();
    }
}

/** @param {import('@playwright/test').Page} page */
async function openTagManagement(page) {
    await openCharacterManagementDrawer(page);
    await page.locator('.rm_tag_filter .manageTags:visible').first().click();
    await page.locator('#tag_view_list .tag_view_prune').waitFor({ state: 'visible', timeout: 10000 });
}

/** @param {import('@playwright/test').Page} page */
function trackTagRequests(page) {
    const inFlight = new Set();
    const isTags = request => new URL(request.url()).pathname.startsWith('/api/tags/');
    page.on('request', r => { if (isTags(r)) inFlight.add(r); });
    page.on('requestfinished', r => inFlight.delete(r));
    page.on('requestfailed', r => inFlight.delete(r));
    return inFlight;
}

/**
 * Opens the delete dialog for `tagId` in the tag manager and chooses `mergeInto` (or no merge) in it.
 * @param {import('@playwright/test').Page} page
 * @param {string} tagId
 * @param {string | null} mergeInto
 * @returns {Promise<import('@playwright/test').Locator>} The dialog, not yet confirmed.
 */
async function openDeleteDialog(page, tagId, mergeInto) {
    await page.locator(`#tag_view_list .tag_view_item[id="${tagId}"] .tag_delete`).click();
    const popup = page.locator('dialog.popup', { hasText: 'Delete Tag' });
    await expect(popup).toBeVisible({ timeout: 10000 });
    if (mergeInto) {
        // As if picked from the search: the picker holds an option for the picked tag only. The tag may be gone from
        // the server by now, so its name comes from its id (createTag()).
        const name = mergeInto.replace(/^tag-delete-merge-/, '');
        await page.evaluate(({ id, name }) => {
            window['jQuery']('#merge_tag_select').append(new Option(name, id, true, true)).trigger('change');
        }, { id: mergeInto, name });
    }
    return popup;
}

/**
 * Confirms an open delete dialog and waits until the page's tag requests have settled.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} popup
 * @returns {Promise<{ body: unknown, paths: string[] }>} The /api/tags/delete request body, and the path of every
 *   /api/tags/ request the page sent from the confirm on.
 */
async function confirmDelete(page, popup) {
    const requests = trackTagRequests(page);
    /** @type {string[]} */
    const paths = [];
    page.on('request', r => {
        const { pathname } = new URL(r.url());
        if (pathname.startsWith('/api/tags/')) paths.push(pathname);
    });
    const deleteRequest = page.waitForRequest(r => new URL(r.url()).pathname === '/api/tags/delete');
    await popup.locator('.popup-button-ok').click();
    const body = (await deleteRequest).postDataJSON();
    await expect.poll(() => requests.size, { timeout: 30000 }).toBe(0);
    return { body, paths };
}

/**
 * Deletes `tagId` from the tag manager, choosing `mergeInto` (or no merge) in its dialog.
 * @param {import('@playwright/test').Page} page
 * @param {string} tagId
 * @param {string | null} mergeInto
 */
async function deleteFromTagManager(page, tagId, mergeInto) {
    return confirmDelete(page, await openDeleteDialog(page, tagId, mergeInto));
}

/** @param {import('@playwright/test').Page} page */
async function countSettingsUpdated(page) {
    await page.evaluate(() => {
        window['__settingsUpdated'] = 0;
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.on(eventTypes.SETTINGS_UPDATED, () => { window['__settingsUpdated']++; });
    });
}

/** @param {import('@playwright/test').Page} page @param {string} key @returns {Promise<string[]>} */
async function pageTagIds(page, key) {
    return page.evaluate(async (key) => {
        const { charactersStore } = await import('/scripts/character-store.js');
        const { groupsStore } = await import('/scripts/group-store.js');
        return [...((charactersStore.get(key) ?? groupsStore.get(key))?.tag_ids ?? [])];
    }, key);
}

/** @param {import('@playwright/test').Page} page @returns {Promise<string[]>} */
async function pageTagDefinitionIds(page) {
    return page.evaluate(async () => (await import('/scripts/tags.js')).tagsStore.getAll().map(t => t.id));
}

test.describe('Deleting a tag from the tag manager', () => {
    test.setTimeout(180000);

    test('sends the merge target, and a card this page never loaded gets it', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withSetupPage(browser, async (setup) => {
            const deleted = await createTag(setup, `deleted-${stamp}`);
            const target = await createTag(setup, `target-${stamp}`);
            const loadedCard = await createCharacter(setup, `TagDeleteMergeLoaded-${stamp}`);
            const hiddenCard = await createCharacter(setup, `TagDeleteMergeHidden-${stamp}`);
            await api(setup, '/api/tags/assign', { id: loadedCard, tagId: deleted });
            await api(setup, '/api/tags/assign', { id: hiddenCard, tagId: deleted });
            return { deleted, target, loadedCard, hiddenCard };
        });

        // The page never receives hiddenCard, so only the server can move its tag.
        await page.route('**/api/characters/changes', async route => {
            const response = await route.fetch();
            const json = await response.json();
            json.changes = json.changes.filter(c => c.id !== fixture.hiddenCard);
            await route.fulfill({ response, json });
        });
        await page.route('**/api/characters/batch', async route => {
            const response = await route.fetch();
            const json = await response.json();
            await route.fulfill({ response, json: json.filter(c => c.avatar !== fixture.hiddenCard) });
        });

        await loadApp(page);
        await holdCharacters(page, [fixture.loadedCard]);
        await openTagManagement(page);
        await countSettingsUpdated(page);
        const { body, paths } = await deleteFromTagManager(page, fixture.deleted, fixture.target);

        expect(body).toEqual({ id: fixture.deleted, mergeInto: fixture.target });
        expect(await api(page, '/api/tags/for', { ids: [fixture.loadedCard, fixture.hiddenCard] })).toEqual({
            [fixture.loadedCard]: [fixture.target],
            [fixture.hiddenCard]: [fixture.target],
        });

        // One delete; the page writes no assignment of its own.
        expect(paths.filter(p => p === '/api/tags/delete')).toHaveLength(1);
        expect(paths.filter(p => /\/(assign|unassign|assign-many|edit|create)$/.test(p))).toEqual([]);
        await expect(page.locator('.toast-success', { hasText: `'deleted-${stamp}' deleted and merged into 'target-${stamp}'.` })).toBeVisible();
        await expect(page.locator(`#tag_view_list .tag_view_item[id="${fixture.deleted}"]`)).toHaveCount(0);
        expect(await pageTagDefinitionIds(page)).not.toContain(fixture.deleted);
        expect(await pageTagIds(page, fixture.loadedCard)).toEqual([fixture.target]);
        expect(await page.evaluate(() => window['__settingsUpdated'])).toBe(1);
    });

    test('with no merge target, sends mergeInto null and the tag is gone from every card', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withSetupPage(browser, async (setup) => {
            const deleted = await createTag(setup, `nomerge-${stamp}`);
            const card = await createCharacter(setup, `TagDeleteNoMerge-${stamp}`);
            await api(setup, '/api/tags/assign', { id: card, tagId: deleted });
            return { deleted, card };
        });

        await loadApp(page);
        await holdCharacters(page, [fixture.card]);
        await openTagManagement(page);
        const { body } = await deleteFromTagManager(page, fixture.deleted, null);

        expect(body).toEqual({ id: fixture.deleted, mergeInto: null });
        expect(await api(page, '/api/tags/for', { ids: [fixture.card] })).toEqual({ [fixture.card]: [] });
        await expect(page.locator('.toast-success', { hasText: `'nomerge-${stamp}' deleted.` })).toBeVisible();
        expect(await pageTagIds(page, fixture.card)).toEqual([]);
    });

    test('a merge target deleted meanwhile: nothing is deleted, a warning says so, and the page matches the server', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withSetupPage(browser, async (setup) => {
            const kept = await createTag(setup, `kept-${stamp}`);
            const gone = await createTag(setup, `gone-${stamp}`);
            const card = await createCharacter(setup, `TagDeleteRefused-${stamp}`);
            await api(setup, '/api/tags/assign', { id: card, tagId: kept });
            return { kept, gone, card };
        });

        await loadApp(page);
        await holdCharacters(page, [fixture.card]);
        await openTagManagement(page);
        await countSettingsUpdated(page);
        const popup = await openDeleteDialog(page, fixture.kept, fixture.gone);
        await withSetupPage(browser, setup => api(setup, '/api/tags/delete', { id: fixture.gone }));
        await confirmDelete(page, popup);

        // 'was deleted' until the server has finished removing the target, 'no longer exists' after.
        await expect(page.locator('.toast-warning', {
            hasText: new RegExp(`'kept-${stamp}' was not deleted: 'gone-${stamp}', the tag to merge it into, (was deleted|no longer exists)\\.`),
        })).toBeVisible();
        await expect(page.locator('.toast-success')).toHaveCount(0);
        expect(await api(page, '/api/tags/for', { ids: [fixture.card] })).toEqual({ [fixture.card]: [fixture.kept] });
        expect((await api(page, '/api/tags/by-ids', { ids: [fixture.kept, fixture.gone] })).tags.map(t => t.id)).toEqual([fixture.kept]);

        await expect(page.locator(`#tag_view_list .tag_view_item[id="${fixture.kept}"]`)).toHaveCount(1);
        await expect(page.locator(`#tag_view_list .tag_view_item[id="${fixture.gone}"]`)).toHaveCount(0);
        const definitionIds = await pageTagDefinitionIds(page);
        expect(definitionIds).toContain(fixture.kept);
        expect(definitionIds).not.toContain(fixture.gone);
        expect(await pageTagIds(page, fixture.card)).toEqual([fixture.kept]);
        expect(await page.evaluate(() => window['__settingsUpdated'])).toBe(0);
    });

    test('a merge target itself merged into another tag meanwhile: the toast and the page name the tag the cards got', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withSetupPage(browser, async (setup) => {
            const deleted = await createTag(setup, `moved-${stamp}`);
            const picked = await createTag(setup, `picked-${stamp}`);
            const final = await createTag(setup, `final-${stamp}`);
            const card = await createCharacter(setup, `TagDeleteFollowed-${stamp}`);
            await api(setup, '/api/tags/assign', { id: card, tagId: deleted });
            return { deleted, picked, final, card };
        });

        await loadApp(page);
        await holdCharacters(page, [fixture.card]);
        await openTagManagement(page);
        // The server follows a picked tag to the tag it was merged into only until it has finished removing the picked
        // one, which a test can't hold open. So the request is sent on naming the final tag, and its answer is what
        // the server gives in that window.
        await page.route('**/api/tags/delete', async route => {
            const response = await route.fetch({ postData: JSON.stringify({ id: fixture.deleted, mergeInto: fixture.final }) });
            await route.fulfill({ response });
        });
        const { body } = await deleteFromTagManager(page, fixture.deleted, fixture.picked);
        expect(body).toEqual({ id: fixture.deleted, mergeInto: fixture.picked });

        await expect(page.locator('.toast-success', {
            hasText: `'moved-${stamp}' deleted and merged into 'final-${stamp}'. 'picked-${stamp}' had itself been merged into 'final-${stamp}'.`,
        })).toBeVisible();
        expect(await api(page, '/api/tags/for', { ids: [fixture.card] })).toEqual({ [fixture.card]: [fixture.final] });
        expect(await pageTagIds(page, fixture.card)).toEqual([fixture.final]);
    });

    test('a delete the server fails: an error says so and the page keeps the tag', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withSetupPage(browser, async (setup) => {
            const kept = await createTag(setup, `failing-${stamp}`);
            const card = await createCharacter(setup, `TagDeleteFailed-${stamp}`);
            await api(setup, '/api/tags/assign', { id: card, tagId: kept });
            return { kept, card };
        });

        await loadApp(page);
        await holdCharacters(page, [fixture.card]);
        await openTagManagement(page);
        await page.route('**/api/tags/delete', route => route.fulfill({ status: 500, body: '{}' }));
        const { paths } = await deleteFromTagManager(page, fixture.kept, null);

        await expect(page.locator('.toast-error', { hasText: `'failing-${stamp}' could not be deleted.` })).toBeVisible();
        await expect(page.locator('.toast-success')).toHaveCount(0);
        expect(paths).toEqual(['/api/tags/delete']);
        await expect(page.locator(`#tag_view_list .tag_view_item[id="${fixture.kept}"]`)).toHaveCount(1);
        expect(await pageTagDefinitionIds(page)).toContain(fixture.kept);
        expect(await pageTagIds(page, fixture.card)).toEqual([fixture.kept]);
        expect(await api(page, '/api/tags/for', { ids: [fixture.card] })).toEqual({ [fixture.card]: [fixture.kept] });
    });

    test('a filter on the deleted tag moves to the tag it was merged into', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withSetupPage(browser, async (setup) => {
            const deleted = await createTag(setup, `filtered-${stamp}`);
            const target = await createTag(setup, `heir-${stamp}`);
            const card = await createCharacter(setup, `TagDeleteFilter-${stamp}`);
            await api(setup, '/api/tags/assign', { id: card, tagId: deleted });
            return { deleted, target, card };
        });

        await loadApp(page);
        await openCharacterManagementDrawer(page);
        const filterBar = page.locator('#rm_characters_block .rm_tag_filter');
        await page.locator('#rm_characters_block .rm_tag_controls .showTagList').click();
        await filterBar.locator(`.tag[id="${fixture.deleted}"]`).click();
        await expect(filterBar.locator(`.tag[id="${fixture.deleted}"].selected`)).toBeVisible();

        await page.locator('.rm_tag_filter .manageTags:visible').first().click();
        await page.locator('#tag_view_list .tag_view_prune').waitFor({ state: 'visible', timeout: 10000 });
        await deleteFromTagManager(page, fixture.deleted, fixture.target);

        await expect(page.locator('.toast-success', { hasText: `The filter on it now filters by 'heir-${stamp}'.` })).toBeVisible();
        await expect(filterBar.locator(`.tag[id="${fixture.target}"].selected`)).toBeAttached();
        await expect(filterBar.locator(`.tag[id="${fixture.deleted}"]`)).toHaveCount(0);
        const stored = await page.evaluate(({ deleted, target }) => {
            const { accountStorage } = window['SillyTavern'].getContext();
            return { deleted: accountStorage.getItem(`CharacterList_tag_${deleted}`), target: accountStorage.getItem(`CharacterList_tag_${target}`) };
        }, fixture);
        expect(stored).toEqual({ deleted: null, target: 'SELECTED' });
    });
});
