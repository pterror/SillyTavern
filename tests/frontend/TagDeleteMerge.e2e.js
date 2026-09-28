import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// Deleting a tag from the tag manager, with or without a tag to merge it into, sends the merge target to the server,
// which applies it to every card carrying the deleted tag, including cards this page never loaded.

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
 * Deletes `tagId` from the tag manager, choosing `mergeInto` (or no merge) in its dialog.
 * @param {import('@playwright/test').Page} page
 * @param {string} tagId
 * @param {string | null} mergeInto
 * @returns {Promise<unknown>} The /api/tags/delete request body.
 */
async function deleteFromTagManager(page, tagId, mergeInto) {
    const requests = trackTagRequests(page);
    const deleteRequest = page.waitForRequest(r => new URL(r.url()).pathname === '/api/tags/delete');
    await page.locator(`#tag_view_list .tag_view_item[id="${tagId}"] .tag_delete`).click();
    const popup = page.locator('dialog.popup', { hasText: 'Delete Tag' });
    await expect(popup).toBeVisible({ timeout: 10000 });
    if (mergeInto) {
        await page.evaluate(id => window['jQuery']('#merge_tag_select').val(id).trigger('change'), mergeInto);
    }
    await popup.locator('.popup-button-ok').click();
    const body = (await deleteRequest).postDataJSON();
    await expect.poll(() => requests.size, { timeout: 30000 }).toBe(0);
    return body;
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
        await openTagManagement(page);
        const body = await deleteFromTagManager(page, fixture.deleted, fixture.target);

        expect(body).toEqual({ id: fixture.deleted, mergeInto: fixture.target });
        expect(await api(page, '/api/tags/for', { ids: [fixture.loadedCard, fixture.hiddenCard] })).toEqual({
            [fixture.loadedCard]: [fixture.target],
            [fixture.hiddenCard]: [fixture.target],
        });
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
        await openTagManagement(page);
        const body = await deleteFromTagManager(page, fixture.deleted, null);

        expect(body).toEqual({ id: fixture.deleted, mergeInto: null });
        expect(await api(page, '/api/tags/for', { ids: [fixture.card] })).toEqual({ [fixture.card]: [] });
    });
});
