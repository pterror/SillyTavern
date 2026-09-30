import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// Manage Tags lists the server's tags a page at a time: rows, counts and search come from /api/tags/query, more
// rows load when the list is scrolled, and rows scrolled far away are let go.

const MAX_ROWS = 300;

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
 * Types `term` into Manage Tags' search box and waits until the list has asked the server for it and drawn the
 * answer.
 * @param {import('@playwright/test').Page} page
 * @param {string} term
 */
async function search(page, term) {
    const answered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/tags/query'
        && response.request().postDataJSON()?.filter?.contains === term);
    await page.locator('#tag_view_search').fill(term);
    await answered;
    await expect(page.locator('#tag_view_list .tag_view_list_status')).not.toHaveAttribute('data-status', 'loading');
}

/**
 * Opens Manage Tags in `mode`, showing only the tags whose name has `term`.
 * @param {import('@playwright/test').Page} page
 * @param {'manual' | 'alphabetical' | 'by_entries'} mode
 * @param {string} term
 */
async function openTagManagement(page, mode, term) {
    await openCharacterManagementDrawer(page);
    await page.locator('.rm_tag_filter .manageTags:visible').first().click();
    await page.locator('#tag_view_list .tag_view_prune').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#tag_sort_mode_select').selectOption(mode);
    await search(page, term);
}

/** @param {import('@playwright/test').Page} page @returns {Promise<string[]>} the ids of the rows drawn, in order */
function shownOrder(page) {
    return page.locator('#tag_view_list .tag_view_item').evaluateAll(rows => rows.map(row => row.id));
}

/** @param {import('@playwright/test').Page} page @param {string} id */
function row(page, id) {
    return page.locator(`#tag_view_list .tag_view_item[id="${id}"]`);
}

/**
 * Scrolls Manage Tags to one end, again and again, until row `id` is drawn. Checks the rows drawn never exceed
 * MAX_ROWS on the way.
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 * @param {'end' | 'start'} toward
 */
async function scrollUntilDrawn(page, id, toward) {
    await expect.poll(async () => {
        const count = await page.locator('#tag_view_list .tag_view_item').count();
        expect(count).toBeLessThanOrEqual(MAX_ROWS);
        if (await row(page, id).count()) return true;
        // Not a locator action: the rows are replaced while the list loads, which a locator would wait out.
        await page.evaluate((toward) => {
            const rows = document.querySelectorAll('#tag_view_list .tag_view_item');
            rows[toward === 'end' ? rows.length - 1 : 0]?.scrollIntoView();
        }, toward);
        return false;
    }, { timeout: 60000, intervals: [200] }).toBe(true);
}

/** @param {number} n @returns {string} */
const pad = n => String(n).padStart(3, '0');

test.describe('Manage Tags reads pages of tags from the server', () => {
    test.setTimeout(180000);

    test('every tag is reachable by scrolling, in the server\'s order, and rows scrolled far away are let go', async ({ browser, page }) => {
        const stamp = `paged${Date.now()}`;
        const ids = Array.from({ length: 350 }, (_, i) => `${stamp}-${pad(i)}`);
        await elsewhere(browser, other => createTags(other, ids, 20000));
        await loadApp(page);

        await openTagManagement(page, 'manual', stamp);
        await expect(row(page, ids[0])).toBeVisible();
        // One request's worth to start with, not every tag.
        expect((await shownOrder(page)).length).toBeLessThanOrEqual(MAX_ROWS);
        await expect(row(page, ids[349])).toHaveCount(0);

        await scrollUntilDrawn(page, ids[349], 'end');
        const atEnd = await shownOrder(page);
        expect(atEnd.length).toBeLessThanOrEqual(MAX_ROWS);
        // A run of the server's order with nothing left out or repeated, ending at the list's last tag.
        expect(atEnd).toEqual(ids.slice(350 - atEnd.length));
        // The rows at the start were let go.
        await expect(row(page, ids[0])).toHaveCount(0);

        await scrollUntilDrawn(page, ids[0], 'start');
        const atStart = await shownOrder(page);
        expect(atStart.length).toBeLessThanOrEqual(MAX_ROWS);
        expect(atStart).toEqual(ids.slice(0, atStart.length));
    });

    test('search finds a tag far past the first page, and each sort mode shows the server\'s order', async ({ browser, page }) => {
        const stamp = `pages${Date.now()}`;
        const ids = Array.from({ length: 230 }, (_, i) => `${stamp}-${pad(i)}`);
        // A manual order unlike the alphabetical one.
        const manual = [...ids].reverse();
        const fixture = await elsewhere(browser, async (other) => {
            await createTags(other, manual, 30000);
            const card = await createCharacter(other, `TagManagePaged-${stamp}`);
            await api(other, '/api/tags/assign', { id: card, tagId: ids[200] });
            return { card };
        });
        expect(fixture.card).toBeTruthy();
        await loadApp(page);

        await openTagManagement(page, 'manual', `${stamp}-217`);
        await expect.poll(() => shownOrder(page)).toEqual([ids[217]]);

        for (const mode of /** @type {const} */ (['manual', 'alphabetical', 'by_entries'])) {
            // Whichever of the two changes something makes the list ask again.
            const answered = page.waitForResponse(response => new URL(response.url()).pathname === '/api/tags/query'
                && response.request().postDataJSON()?.filter?.contains === stamp && response.request().postDataJSON()?.sort?.field === mode);
            await page.locator('#tag_sort_mode_select').selectOption(mode);
            await page.locator('#tag_view_search').fill(stamp);
            await answered;
            const { rows } = await api(page, '/api/tags/query', { filter: { contains: stamp }, sort: { field: mode }, pageSize: 100 });
            const wanted = rows.map(tag => tag.id);
            expect(wanted.length).toBe(100);
            await expect.poll(async () => (await shownOrder(page)).slice(0, 100), { message: mode }).toEqual(wanted);
        }
        // Most used first: the one tag a character carries leads.
        expect((await shownOrder(page))[0]).toBe(ids[200]);
    });

    test('a count is the server\'s, for a tag only a character this page has not heard of carries, and follows a change made elsewhere', async ({ browser, page }) => {
        const stamp = `pagec${Date.now()}`;
        const [a, b] = [`${stamp}-a`, `${stamp}-b`];
        await elsewhere(browser, other => createTags(other, [a, b], 40000));
        await loadApp(page);
        const counter = (/** @type {string} */ id) => row(page, id).locator('.tag_view_counter_value');

        // The page never learns of this assignment: it can't count it from the characters it holds.
        await page.route('**/api/tags/assignment-changes', route => route.fulfill({ status: 500 }));
        const card = await elsewhere(browser, async (other) => {
            const card = await createCharacter(other, `TagManagePagedCount-${stamp}`);
            await api(other, '/api/tags/assign', { id: card, tagId: a });
            return card;
        });

        await openTagManagement(page, 'manual', stamp);
        await expect(counter(a)).toHaveText('1');
        await expect(counter(b)).toHaveText('0');

        // With the popup open, another tab's assignment shows in the count.
        await page.unroute('**/api/tags/assignment-changes');
        await elsewhere(browser, other => api(other, '/api/tags/assign', { id: card, tagId: b }));
        await expect(counter(b)).toHaveText('1', { timeout: 30000 });
    });

    test('a tag made in another tab shows up in the open list at its place', async ({ browser, page }) => {
        const stamp = `pageo${Date.now()}`;
        const [a, c] = [`${stamp}-a`, `${stamp}-c`];
        await elsewhere(browser, other => createTags(other, [a, c], 50000));
        await loadApp(page);

        await openTagManagement(page, 'alphabetical', stamp);
        await expect.poll(() => shownOrder(page)).toEqual([a, c]);

        await elsewhere(browser, other => createTags(other, [`${stamp}-b`], 50010));
        await expect.poll(() => shownOrder(page), { timeout: 30000 }).toEqual([a, `${stamp}-b`, c]);
    });

    test('New Tag: the server picks a free name, and the new tag stays in view though the search does not match it', async ({ browser, page }) => {
        const stamp = `pagen${Date.now()}`;
        const [a, b] = [`${stamp}-a`, `${stamp}-b`];
        await elsewhere(browser, other => createTags(other, [a, b], 60000));
        await loadApp(page);

        await openTagManagement(page, 'manual', stamp);
        await expect.poll(() => shownOrder(page)).toEqual([a, b]);

        /** @type {any[]} */
        const creates = [];
        page.on('request', request => {
            if (new URL(request.url()).pathname === '/api/tags/create') creates.push(request.postDataJSON());
        });
        const newNames = [];
        for (let i = 0; i < 2; i++) {
            await page.locator('#tag_view_list .tag_view_create').click();
            await expect(page.locator('#tag_view_list .tag_view_item_kept')).toHaveCount(i + 1, { timeout: 30000 });
            const kept = page.locator('#tag_view_list .tag_view_item_kept').nth(i);
            newNames.push(await kept.locator('.tag_view_name').innerText());
        }
        // Asked of the server as a base name with no place in the order; the server gave two different free names.
        expect(creates.map(body => ({ name: body.tag.name, freeName: body.freeName, hasOrder: 'sort_order' in body.tag })))
            .toEqual([{ name: 'New Tag', freeName: true, hasOrder: false }, { name: 'New Tag', freeName: true, hasOrder: false }]);
        expect(newNames[0]).toMatch(/^New Tag( #\d+)?$/);
        expect(newNames[1]).toMatch(/^New Tag #\d+$/);
        expect(newNames[1]).not.toBe(newNames[0]);

        // Kept above the rows the search matches, which are still there.
        const order = await shownOrder(page);
        expect(order.slice(2)).toEqual([a, b]);
        const stored = (await api(page, '/api/tags/by-ids', { ids: order.slice(0, 2) })).tags;
        expect(stored.map(tag => tag.name).sort()).toEqual([...newNames].sort());
        expect(stored.every(tag => typeof tag.sort_order === 'number')).toBe(true);

        // A new search is a new list: the kept rows go.
        await page.locator('#tag_view_search').fill(`${stamp}-a`);
        await expect.poll(() => shownOrder(page)).toEqual([a]);
    });

    test('says when nothing matches, when a read failed, and when the server has found nothing yet, and goes on when asked', async ({ browser, page }) => {
        const stamp = `pagef${Date.now()}`;
        const [a, b] = [`${stamp}-a`, `${stamp}-b`];
        await elsewhere(browser, other => createTags(other, [a, b], 80000));
        await loadApp(page);
        const status = page.locator('#tag_view_list .tag_view_list_status');

        await openTagManagement(page, 'manual', `${stamp}-nothing-has-this`);
        await expect(status).toHaveText('No tags match the search.');
        await expect.poll(() => shownOrder(page)).toEqual([]);

        // A read the server fails: the list says so and offers to try again.
        await page.route('**/api/tags/query', route => route.fulfill({ status: 500 }));
        await page.locator('#tag_view_search').fill(stamp);
        await expect(status).toContainText('The tags could not be loaded.');
        await page.unroute('**/api/tags/query');
        await status.locator('.menu_button').click();
        await expect.poll(() => shownOrder(page)).toEqual([a, b]);

        // Reads the server's work cap cuts short with nothing found: the list stops asking after a few and offers
        // to go on.
        let cutShort = 0;
        await page.route('**/api/tags/query', (route) => {
            cutShort++;
            return route.fulfill({ json: { rows: [], cursor: 'a-cursor-the-server-never-made', more: true, counts: {}, approximate: [] } });
        });
        await page.locator('#tag_view_search').fill(`${stamp}-`);
        await expect(status).toContainText('No tag found yet among the ones looked at so far.', { timeout: 30000 });
        expect(cutShort).toBe(6);
        await page.waitForTimeout(1500);
        expect(cutShort).toBe(6);
        // Asked to go on, with a cursor the server refuses: the list starts over and shows the tags.
        await page.unroute('**/api/tags/query');
        await status.locator('.menu_button').click();
        await expect.poll(() => shownOrder(page), { timeout: 30000 }).toEqual([a, b]);
    });

    test('a rename that takes a tag out of the rows drawn keeps it in view', async ({ browser, page }) => {
        const stamp = `pager${Date.now()}`;
        const ids = Array.from({ length: 130 }, (_, i) => `${stamp}-${pad(i)}`);
        await elsewhere(browser, other => createTags(other, ids, 70000));
        await loadApp(page);

        await openTagManagement(page, 'alphabetical', stamp);
        await expect(row(page, ids[0])).toBeVisible();
        await expect(row(page, ids[129])).toHaveCount(0);

        // Renamed past the end of the alphabet, and out of what the search matches.
        const name = row(page, ids[0]).locator('.tag_view_name');
        await name.click();
        await name.fill(`zzzz renamed ${stamp.slice(0, 3)}`);
        await name.press('Enter');

        await expect(row(page, ids[0])).toHaveClass(/tag_view_item_kept/, { timeout: 30000 });
        await expect(name).toHaveText(`zzzz renamed ${stamp.slice(0, 3)}`);
        expect((await shownOrder(page)).slice(0, 2)).toEqual([ids[0], ids[1]]);
        expect((await api(page, '/api/tags/by-ids', { ids: [ids[0]] })).tags[0].name).toBe(`zzzz renamed ${stamp.slice(0, 3)}`);
    });
});
