import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// The tag filter bar above the character list draws the used tags the server lists, a page at a time, and the saved
// tag filters are kept whatever the page managed to read: one is removed only when the server says its tag is gone.

const BAR = '#rm_characters_block .rm_tag_filter';

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
 * Runs `work` on a page of its own context, so the page under test learns of what it does only from the server.
 * @param {import('@playwright/test').Browser} browser
 * @param {(page: import('@playwright/test').Page) => Promise<T>} work
 * @returns {Promise<T>}
 * @template T
 */
async function elsewhere(browser, work) {
    const context = await browser.newContext();
    try {
        const other = await context.newPage();
        await loadApp(other);
        return await work(other);
    } finally {
        await context.close();
    }
}

/**
 * Creates tags named like their ids, in the manual order given by their place in `ids`.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} ids
 * @param {number} firstSortOrder
 */
async function createTags(page, ids, firstSortOrder) {
    await page.evaluate(async ({ ids, firstSortOrder }) => {
        const headers = window['SillyTavern'].getContext().getRequestHeaders();
        for (let i = 0; i < ids.length; i += 25) {
            await Promise.all(ids.slice(i, i + 25).map(async (id, j) => {
                const tag = {
                    id, name: id, folder_type: 'NONE', sort_order: firstSortOrder + i + j,
                    is_hidden_on_character_card: false, color: '', color2: '', create_date: Date.now(),
                };
                const response = await fetch('/api/tags/create', { method: 'POST', headers, body: JSON.stringify({ tag }) });
                if (!response.ok) throw new Error(`create ${id} -> ${response.status}`);
            }));
        }
    }, { ids, firstSortOrder });
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
 * A manual order ahead of every tag made before: the tags of the test that asks lead the bar, whatever earlier tests
 * left in this worker's data.
 * @returns {number}
 */
const leadingSortOrder = () => -Date.now();

/**
 * Opens the character list with its bar showing its tags.
 * @param {import('@playwright/test').Page} page
 */
async function openBar(page) {
    await openCharacterManagementDrawer(page);
    const toggle = page.locator(`${BAR} .showTagList`);
    await toggle.waitFor({ state: 'visible', timeout: 10000 });
    if (!(await toggle.evaluate(el => el.classList.contains('selected')))) await toggle.click();
}

/** @param {import('@playwright/test').Page} page @param {string} id */
function pill(page, id) {
    return page.locator(`${BAR} .tag[id="${id}"]`);
}

/** @param {import('@playwright/test').Page} page @returns {Promise<string[]>} the ids of the tag pills drawn, in order */
function pillOrder(page) {
    return page.locator(`${BAR} .tag:not(.actionable):not(.placeholder-expander)`).evaluateAll(pills => pills.map(el => el.id));
}

/** @param {import('@playwright/test').Page} page @param {string} key */
function stored(page, key) {
    return page.evaluate(key => localStorage.getItem(key), key);
}

/** @param {number} n @returns {string} */
const pad = n => String(n).padStart(3, '0');

test.describe('The tag filter bar reads the used tags from the server', () => {
    test.setTimeout(180000);

    test('a used tag is in the bar and an unused one is not, though the page could not count either itself', async ({ browser, page }) => {
        const stamp = `bar-used-${Date.now()}`;
        const [used, unused] = [`${stamp}-used`, `${stamp}-unused`];
        await elsewhere(browser, async (other) => {
            await createTags(other, [used, unused], leadingSortOrder());
            const card = await createCharacter(other, `TagFilterBar-${stamp}`);
            await api(other, '/api/tags/assign', { id: card, tagId: used });
        });
        const usageReads = [];
        page.on('request', request => {
            if (new URL(request.url()).pathname === '/api/tags/usage') usageReads.push(request.url());
        });
        await loadApp(page);

        await openBar(page);
        await expect(pill(page, used)).toBeVisible();
        await expect(pill(page, unused)).toHaveCount(0);
        expect(usageReads).toEqual([]);
    });

    test('a tag that becomes used in another tab appears, and an unchanged page of the bar is not downloaded again', async ({ browser, page }) => {
        const stamp = `bar-live-${Date.now()}`;
        const [a, b] = [`${stamp}-a`, `${stamp}-b`];
        const card = await elsewhere(browser, async (other) => {
            await createTags(other, [a, b], leadingSortOrder());
            const card = await createCharacter(other, `TagFilterBarLive-${stamp}`);
            await api(other, '/api/tags/assign', { id: card, tagId: a });
            return card;
        });
        await loadApp(page);
        await openBar(page);
        await expect(pill(page, a)).toBeVisible();
        await expect(pill(page, b)).toHaveCount(0);

        await elsewhere(browser, other => api(other, '/api/tags/assign', { id: card, tagId: b }));
        await expect(pill(page, b)).toBeVisible({ timeout: 30000 });
        expect((await pillOrder(page)).slice(0, 2)).toEqual([a, b]);

        // The same assignment again changes nothing the bar draws: its re-read sends the hash it has and is told so.
        const reread = page.waitForResponse(async (response) => {
            if (new URL(response.url()).pathname !== '/api/tags/query') return false;
            const asked = response.request().postDataJSON();
            return asked?.filter?.used === true && typeof asked.ifHash === 'string' && asked.ifHash.length > 0;
        }, { timeout: 30000 });
        const other = await elsewhere(browser, async (other) => {
            const second = await createCharacter(other, `TagFilterBarLive2-${stamp}`);
            await api(other, '/api/tags/assign', { id: second, tagId: b });
            return second;
        });
        expect(other).toBeTruthy();
        expect(await (await reread).json()).toEqual({ unchanged: true, hash: expect.any(String) });
    });

    test('more used tags than the bar draws at first are reachable, in the server\'s order', async ({ browser, page }) => {
        const stamp = `bar-more-${Date.now()}`;
        const ids = Array.from({ length: 60 }, (_, i) => `${stamp}-${pad(i)}`);
        await elsewhere(browser, async (other) => {
            await createTags(other, ids, leadingSortOrder());
            const card = await createCharacter(other, `TagFilterBarMore-${stamp}`);
            for (const tagId of ids) await api(other, '/api/tags/assign', { id: card, tagId });
        });
        await loadApp(page);
        await openBar(page);

        await expect(pill(page, ids[0])).toBeVisible();
        expect(await pillOrder(page)).toEqual(ids.slice(0, 50));

        await page.locator(`${BAR} .placeholder-expander`).click();
        await expect(pill(page, ids[59])).toBeVisible();
        expect((await pillOrder(page)).slice(0, 60)).toEqual(ids);
    });

    test('a saved filter survives reads that fail, keeps its pill, and the bar says its tags could not be loaded', async ({ browser, page }) => {
        const stamp = `bar-fail-${Date.now()}`;
        const [used, unused] = [`${stamp}-used`, `${stamp}-unused`];
        await elsewhere(browser, async (other) => {
            await createTags(other, [used, unused], leadingSortOrder());
            const card = await createCharacter(other, `TagFilterBarFail-${stamp}`);
            await api(other, '/api/tags/assign', { id: card, tagId: used });
        });
        await loadApp(page);
        await page.evaluate(({ used, unused }) => {
            localStorage.setItem(`CharacterList_tag_${used}`, 'SELECTED');
            // A filter on a tag nothing carries is a filter all the same.
            localStorage.setItem(`CharacterList_tag_${unused}`, 'EXCLUDED');
        }, { used, unused });

        const failing = ['**/api/tags/query', '**/api/tags/by-ids'];
        for (const url of failing) await page.route(url, route => route.fulfill({ status: 500 }));
        await page.reload();
        await loadApp(page);
        await openBar(page);

        await expect(page.locator(`${BAR} .placeholder-expander`)).toContainText('could not be loaded');
        await expect(pill(page, used)).toHaveClass(/selected/);
        await expect(pill(page, unused)).toHaveClass(/excluded/);
        expect(await stored(page, `CharacterList_tag_${used}`)).toBe('SELECTED');
        expect(await stored(page, `CharacterList_tag_${unused}`)).toBe('EXCLUDED');

        for (const url of failing) await page.unroute(url);
        await page.locator(`${BAR} .placeholder-expander`).click();
        await expect(page.locator(`${BAR} .placeholder-expander`, { hasText: 'could not be loaded' })).toHaveCount(0);
        await expect(pill(page, used)).toHaveClass(/selected/);
        await expect(pill(page, unused)).toHaveClass(/excluded/);
        expect(await stored(page, `CharacterList_tag_${unused}`)).toBe('EXCLUDED');

        // Both can be cleared from the bar.
        await page.locator(`${BAR} .clearAllFilters`).click();
        await expect(pill(page, used)).not.toHaveClass(/selected/);
        await expect.poll(() => stored(page, `CharacterList_tag_${unused}`)).toBe('UNDEFINED');
    });

    test('a saved filter on a tag the server no longer has is removed, with a warning that names it', async ({ browser, page }) => {
        const stamp = `bar-gone-${Date.now()}`;
        const [kept, deleted] = [`${stamp}-kept`, `${stamp}-deleted`];
        await elsewhere(browser, other => createTags(other, [kept, deleted], leadingSortOrder()));
        await loadApp(page);
        await openBar(page);

        await page.evaluate(({ deleted, kept }) => {
            localStorage.setItem(`CharacterList_tag_${deleted}`, 'SELECTED');
            localStorage.setItem(`CharacterList_tagname_${deleted}`, 'A Deleted Tag');
            localStorage.setItem(`CharacterList_tag_${kept}`, 'SELECTED');
            // A filter saved before names were kept.
            localStorage.setItem('GroupCandidates_tag_never-existed', 'EXCLUDED');
        }, { deleted, kept });
        // Deleted while this browser has no tab that hears of it.
        await page.goto('about:blank');
        await elsewhere(browser, other => api(other, '/api/tags/delete', { id: deleted, mergeInto: null }));

        await loadApp(page);
        await openBar(page);
        const warning = page.locator('.toast-warning', { hasText: 'Tag filters removed' });
        await expect(warning).toContainText('A Deleted Tag');
        await expect(warning).toContainText('never-existed');
        expect(await stored(page, `CharacterList_tag_${deleted}`)).toBeNull();
        expect(await stored(page, `CharacterList_tagname_${deleted}`)).toBeNull();
        expect(await stored(page, 'GroupCandidates_tag_never-existed')).toBeNull();
        // The filter on the tag that is still there is untouched.
        expect(await stored(page, `CharacterList_tag_${kept}`)).toBe('SELECTED');
        await expect(pill(page, kept)).toHaveClass(/selected/);
        await expect(pill(page, deleted)).toHaveCount(0);
    });

    test('a folder whose tag is not among the tags the bar drew opens and closes', async ({ browser, page }) => {
        const stamp = `bar-folder-${Date.now()}`;
        const ids = Array.from({ length: 51 }, (_, i) => `${stamp}-${pad(i)}`);
        const folder = `${stamp}-folder`;
        const card = await elsewhere(browser, async (other) => {
            const first = leadingSortOrder();
            await createTags(other, ids, first);
            // After the 51 others in the manual order, so past the 50 the bar draws.
            await other.evaluate(async ({ folder, sort_order }) => {
                const headers = window['SillyTavern'].getContext().getRequestHeaders();
                const tag = { id: folder, name: folder, folder_type: 'OPEN', sort_order, is_hidden_on_character_card: false, color: '', color2: '', create_date: Date.now() };
                const response = await fetch('/api/tags/create', { method: 'POST', headers, body: JSON.stringify({ tag }) });
                if (!response.ok) throw new Error(`create -> ${response.status}`);
            }, { folder, sort_order: first + 100 });
            const card = await createCharacter(other, `TagFilterBarFolder-${stamp}`);
            for (const tagId of [...ids, folder]) await api(other, '/api/tags/assign', { id: card, tagId });
            return card;
        });
        await loadApp(page);
        await page.evaluate(() => { $('#bogus_folders').prop('checked', true).trigger('input'); });
        await openBar(page);
        await expect(pill(page, ids[0])).toBeVisible();
        await expect(pill(page, folder)).toHaveCount(0);

        await page.locator(`#rm_print_characters_block .bogus_folder_select[tagid="${folder}"]`).click();
        await expect(pill(page, folder)).toHaveClass(/selected/);
        await expect(page.locator(`#rm_characters_block .rm_tag_bogus_drilldown .tag[id="${folder}"]`)).toBeVisible();
        await expect(page.locator(`#rm_print_characters_block .character_select[data-avatar="${card}"]`)).toBeVisible();
        expect(await stored(page, `CharacterList_tag_${folder}`)).toBe('SELECTED');

        await page.locator('#rm_print_characters_block .bogus_folder_select_back').click();
        await expect(page.locator(`#rm_characters_block .rm_tag_bogus_drilldown .tag[id="${folder}"]`)).toHaveCount(0);
        await expect.poll(() => stored(page, `CharacterList_tag_${folder}`)).toBe('UNDEFINED');

        // The setting is stored in this worker's data, which later tests share.
        const saved = page.waitForResponse(response => response.url().endsWith('/api/settings/save-partial')
            && response.request().postData()?.includes('bogus_folders'));
        await page.evaluate(() => { $('#bogus_folders').prop('checked', false).trigger('input'); });
        await saved;
    });

    test('clicking a filter keeps the tag\'s name with it, and clearing the filter drops the name', async ({ browser, page }) => {
        const stamp = `bar-name-${Date.now()}`;
        const tag = `${stamp}-tag`;
        await elsewhere(browser, async (other) => {
            await createTags(other, [tag], leadingSortOrder());
            const card = await createCharacter(other, `TagFilterBarName-${stamp}`);
            await api(other, '/api/tags/assign', { id: card, tagId: tag });
        });
        await loadApp(page);
        await openBar(page);

        await pill(page, tag).click();
        await expect(pill(page, tag)).toHaveClass(/selected/);
        expect(await stored(page, `CharacterList_tagname_${tag}`)).toBe(tag);

        await pill(page, tag).click();
        await pill(page, tag).click();
        await expect(pill(page, tag)).not.toHaveClass(/selected|excluded/);
        expect(await stored(page, `CharacterList_tagname_${tag}`)).toBeNull();
    });
});
