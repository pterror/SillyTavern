import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// When the server refuses a tag create or edit, the page re-reads that tag: it takes the stored copy if there is one,
// and otherwise drops the tag and re-reads the tags of the characters and groups it holds.

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

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 * @param {string} name
 * @param {string} [filterState]
 */
async function createTag(page, id, name, filterState = 'UNDEFINED') {
    await api(page, '/api/tags/create', {
        tag: {
            id, name, folder_type: 'NONE', filter_state: filterState, sort_order: 1000,
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

/** @param {import('@playwright/test').Page} page @param {string} id */
function pageTag(page, id) {
    return page.evaluate(id => {
        const tag = window['SillyTavern'].getContext().tags.find(t => t.id === id);
        return tag ? { name: tag.name, filter_state: tag.filter_state } : null;
    }, id);
}

/** @param {import('@playwright/test').Page} page @param {string} avatar */
function pageCharacterTagIds(page, avatar) {
    return page.evaluate(async avatar => {
        // What the page holds, not what extensions are shown (only the current character).
        const { charactersStore } = await import('/scripts/character-store.js');
        const character = charactersStore.get(avatar);
        return character ? [...(character.tag_ids ?? [])] : null;
    }, avatar);
}

test.describe('A refused tag save', () => {
    test.setTimeout(180000);

    test('of a tag deleted and merged behind the page drops it and picks up the merge target', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withSetupPage(browser, async (setup) => {
            const deleted = await createTag(setup, `tag-refused-deleted-${stamp}`, `deleted-${stamp}`);
            const card = await createCharacter(setup, `TagRefusedResync-${stamp}`);
            await api(setup, '/api/tags/assign', { id: card, tagId: deleted });
            return { deleted, card, target: `tag-refused-target-${stamp}` };
        });

        await loadApp(page);
        await openTagManagement(page);
        expect(await pageCharacterTagIds(page, fixture.card)).toEqual([fixture.deleted]);

        // Made only now, so the page has no definition of the merge target until it re-reads one.
        await createTag(page, fixture.target, `target-${stamp}`);
        await api(page, '/api/tags/delete', { id: fixture.deleted, mergeInto: fixture.target });
        expect(await pageTag(page, fixture.target)).toBeNull();

        const reread = page.waitForRequest(r => new URL(r.url()).pathname === '/api/tags/for'
            && r.postDataJSON()?.ids?.includes(fixture.card));
        const name = page.locator(`#tag_view_list .tag_view_item[id="${fixture.deleted}"] .tag_view_name`);
        await name.click();
        await name.pressSequentially('x');
        await page.keyboard.press('Enter');
        await reread;

        await expect.poll(() => pageTag(page, fixture.deleted), { timeout: 30000 }).toBeNull();
        await expect(page.locator(`.tag[id="${fixture.deleted}"]`)).toHaveCount(0);
        await expect.poll(() => pageCharacterTagIds(page, fixture.card), { timeout: 30000 }).toEqual([fixture.target]);
        await expect.poll(() => pageTag(page, fixture.target), { timeout: 30000 })
            .toEqual(expect.objectContaining({ name: `target-${stamp}` }));
    });

    test('of a create whose id the server already has takes the stored copy but keeps its own filter state', async ({ page }) => {
        const stamp = Date.now();
        const storedName = `stored-${stamp}`;

        await loadApp(page);
        await openTagManagement(page);

        // The server gets a tag with the same id just before the page's own create reaches it.
        /** @type {{ id: string, sentFilterState: boolean } | null} */
        let pageCreated = null;
        await page.route('**/api/tags/create', async route => {
            const { tag } = route.request().postDataJSON();
            if (tag.name !== storedName && !pageCreated) {
                pageCreated = { id: tag.id, sentFilterState: Object.hasOwn(tag, 'filter_state') };
                await createTag(page, tag.id, storedName, 'SELECTED');
            }
            await route.continue();
        });

        await page.locator('#tag_view_list .tag_view_create').click();
        await expect.poll(() => pageCreated, { timeout: 30000 }).not.toBeNull();
        const { id, sentFilterState } = /** @type {{ id: string, sentFilterState: boolean }} */ (pageCreated);
        // A tag's filter is this browser's, so it is not part of what the page asks the server to store.
        expect(sentFilterState).toBe(false);

        await expect.poll(() => pageTag(page, id), { timeout: 30000 }).toEqual({ name: storedName, filter_state: 'UNDEFINED' });
    });
});
