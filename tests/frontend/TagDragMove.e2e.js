import { chooseTagSort } from './tag-manager-utils.js';
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
 * @param {import('@playwright/test').Browser} browser
 * @param {(page: import('@playwright/test').Page) => Promise<void>} work
 */
async function elsewhere(browser, work) {
    const context = await browser.newContext();
    try {
        const other = await context.newPage();
        await loadApp(other);
        await work(other);
    } finally {
        await context.close();
    }
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function cutOffTagChanges(page) {
    await page.route('**/api/tags/changes', route => route.fulfill({ status: 500 }));
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 * @param {number} sortOrder
 */
async function createTag(page, id, sortOrder) {
    await api(page, '/api/tags/create', {
        tag: {
            id, name: id, folder_type: 'NONE', filter_state: 'UNDEFINED', sort_order: sortOrder,
            is_hidden_on_character_card: false, create_date: Date.now(),
        },
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string[]} ids
 * @returns {Promise<string[]>}
 */
async function serverManualOrder(page, ids) {
    const { tags } = await api(page, '/api/tags/by-ids', { ids });
    return tags.sort((a, b) => a.sort_order - b.sort_order).map(tag => tag.id);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string[]} ids
 * @returns {Promise<boolean>}
 */
async function pageHoldsServerOrders(page, ids) {
    const { tags } = await api(page, '/api/tags/by-ids', { ids });
    const held = await page.evaluate(async ids => Object.fromEntries((await import('/scripts/tags.js')).tagsStore.getAll()
        .filter(tag => ids.includes(tag.id)).map(tag => [tag.id, tag.sort_order])), ids);
    return tags.every(tag => held[tag.id] === tag.sort_order);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {'manual' | 'alphabetical'} mode
 * @param {string} term
 */
async function openTagManagement(page, mode, term) {
    await openCharacterManagementDrawer(page);
    await page.locator('.rm_tag_filter .manageTags:visible').first().click();
    await page.locator('#tag_view_list .tag_view_prune').waitFor({ state: 'visible', timeout: 10000 });
    await chooseTagSort(page, mode);
    await page.locator('#tag_view_search').fill(term);
}

/** @param {import('@playwright/test').Page} page */
function shownOrder(page) {
    return page.locator('#tag_view_list .tag_view_item').evaluateAll(rows => rows.map(row => row.id));
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 * @param {string} [aboveId]
 */
async function drag(page, id, aboveId) {
    const from = await page.locator(`.tag_view_item[id="${id}"] .drag-handle`).boundingBox();
    const x = from.x + from.width / 2;
    const y = from.y + from.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    if (aboveId) {
        const to = await page.locator(`.tag_view_item[id="${aboveId}"]`).boundingBox();
        await page.mouse.move(x, to.y + 2, { steps: 12 });
    } else {
        await page.mouse.move(x + 6, y, { steps: 3 });
        await page.mouse.move(x, y, { steps: 3 });
    }
    await page.mouse.up();
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {{ path: string, body: any }[]}
 */
function recordTagWrites(page) {
    /** @type {{ path: string, body: any }[]} */
    const writes = [];
    page.on('request', request => {
        const path = new URL(request.url()).pathname;
        if (['/api/tags/move', '/api/tags/reorder', '/api/tags/save', '/api/tags/edit'].includes(path)) {
            writes.push({ path, body: request.postDataJSON() });
        }
    });
    return writes;
}

test.describe('dragging a tag in Manage Tags', () => {
    test.setTimeout(180000);

    test('keyboard moves keep handle focus and send one intent per move', async ({ browser, page }) => {
        const stamp = `dragk${Date.now()}`;
        const [a, b, c] = ['a', 'b', 'c'].map(letter => `${stamp}-${letter}`);
        await elsewhere(browser, async other => {
            await createTag(other, a, 9501);
            await createTag(other, b, 9502);
            await createTag(other, c, 9503);
        });
        await loadApp(page);
        await openTagManagement(page, 'manual', stamp);
        await expect.poll(() => shownOrder(page)).toEqual([a, b, c]);
        const writes = recordTagWrites(page);
        const handle = page.locator(`.tag_view_item[id="${c}"] .drag-handle`);
        await handle.focus();
        await handle.press('ArrowUp');
        await expect.poll(() => shownOrder(page)).toEqual([a, c, b]);
        await expect(page.locator('.tag_view_list_tags')).toHaveAttribute('aria-busy', 'false');
        await expect(handle).toBeFocused();
        await handle.press('ArrowUp');
        await expect.poll(() => shownOrder(page)).toEqual([c, a, b]);
        await expect(page.locator('.tag_view_list_tags')).toHaveAttribute('aria-busy', 'false');
        await expect(handle).toBeFocused();
        await handle.press('ArrowUp');
        expect(writes).toEqual([
            { path: '/api/tags/move', body: { id: c, before: b } },
            { path: '/api/tags/move', body: { id: c, before: a } },
        ]);
        expect(await serverManualOrder(page, [a, b, c])).toEqual([c, a, b]);
    });

    test('Escape cancels a drag without closing Manage Tags or saving an order', async ({ browser, page }) => {
        const stamp = `dragx${Date.now()}`;
        const [a, b] = ['a', 'b'].map(letter => `${stamp}-${letter}`);
        await elsewhere(browser, async other => {
            await createTag(other, a, 9601);
            await createTag(other, b, 9602);
        });
        await loadApp(page);
        await openTagManagement(page, 'manual', stamp);
        await expect.poll(() => shownOrder(page)).toEqual([a, b]);
        const writes = recordTagWrites(page);
        const from = await page.locator(`.tag_view_item[id="${b}"] .drag-handle`).boundingBox();
        const to = await page.locator(`.tag_view_item[id="${a}"]`).boundingBox();
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
        await page.mouse.down();
        await page.mouse.move(from.x + from.width / 2, to.y + 2, { steps: 8 });
        await expect(page.locator('[data-reorder-dragging]')).toHaveCount(1);
        await expect(page.locator('[data-reorder-before]')).toHaveAttribute('id', a);
        await page.keyboard.press('Escape');
        await page.mouse.up();
        await expect(page.locator('[data-reorder-dragging], [data-reorder-before]')).toHaveCount(0);
        await expect(page.locator('#tag_view_list')).toBeVisible();
        expect(writes).toEqual([]);
        expect(await shownOrder(page)).toEqual([a, b]);
    });

    test('Manual: sends one move, and a tag made in another tab this one has not heard of is still there', async ({ browser, page }) => {
        const stamp = `dragm${Date.now()}`;
        const [a, b, c, z] = ['a', 'b', 'c', 'z'].map(letter => `${stamp}-${letter}`);
        await elsewhere(browser, async (other) => {
            await createTag(other, a, 9001);
            await createTag(other, b, 9002);
            await createTag(other, c, 9003);
        });
        await loadApp(page);
        await cutOffTagChanges(page);
        await elsewhere(browser, other => createTag(other, z, 9004));

        await openTagManagement(page, 'manual', stamp);
        await expect.poll(() => shownOrder(page)).toEqual([a, b, c, z]);
        const writes = recordTagWrites(page);

        await drag(page, c, a);

        await expect.poll(() => serverManualOrder(page, [a, b, c]), { timeout: 30000 }).toEqual([c, a, b]);
        expect(writes).toEqual([{ path: '/api/tags/move', body: { id: c, before: a } }]);
        expect((await api(page, '/api/tags/by-ids', { ids: [z] })).tags.map(tag => tag.id)).toEqual([z]);
        await expect.poll(() => pageHoldsServerOrders(page, [a, b, c]), { timeout: 30000 }).toBe(true);
        expect(await shownOrder(page)).toEqual([c, a, b, z]);
        await expect(page.locator('#tag_sort_mode_select')).toHaveAttribute('value', 'manual');
    });

    test('a row dropped back where it was sends nothing and keeps the sort mode', async ({ browser, page }) => {
        const stamp = `dragn${Date.now()}`;
        const [a, b] = ['a', 'b'].map(letter => `${stamp}-${letter}`);
        await elsewhere(browser, async (other) => {
            await createTag(other, a, 9101);
            await createTag(other, b, 9102);
        });
        await loadApp(page);

        await openTagManagement(page, 'manual', stamp);
        const writes = recordTagWrites(page);
        for (const mode of /** @type {const} */ (['manual', 'alphabetical'])) {
            await chooseTagSort(page, mode);
            await expect.poll(() => shownOrder(page)).toEqual([a, b]);

            await drag(page, b);
            await expect(page.locator('[data-reorder-dragging]')).toHaveCount(0);

            expect(writes, mode).toEqual([]);
            await expect(page.locator('#tag_sort_mode_select')).toHaveAttribute('value', mode);
            expect(await shownOrder(page)).toEqual([a, b]);
        }
    });

    test('a refused move puts the row back, says why, and drops a tag the server deleted', async ({ browser, page }) => {
        const stamp = `dragr${Date.now()}`;
        const [a, b, c] = ['a', 'b', 'c'].map(letter => `${stamp}-${letter}`);
        await elsewhere(browser, async (other) => {
            await createTag(other, a, 9201);
            await createTag(other, b, 9202);
            await createTag(other, c, 9203);
        });
        await loadApp(page);
        await cutOffTagChanges(page);

        await openTagManagement(page, 'manual', stamp);
        await expect.poll(() => shownOrder(page)).toEqual([a, b, c]);
        await elsewhere(browser, other => api(other, '/api/tags/delete', { id: b }).then(() => {}));

        await drag(page, c, b);

        await expect(page.locator('#toast-container .toast-warning').filter({ hasText: `"${b}" was deleted` })).toBeVisible({ timeout: 30000 });
        await expect.poll(() => shownOrder(page), { timeout: 30000 }).toEqual([a, c]);
        expect(await serverManualOrder(page, [a, c])).toEqual([a, c]);
        await expect(page.locator('#tag_sort_mode_select')).toHaveAttribute('value', 'manual');
    });

    test('a move the server fails puts the row back and says so', async ({ browser, page }) => {
        const stamp = `dragf${Date.now()}`;
        const [a, b] = ['a', 'b'].map(letter => `${stamp}-${letter}`);
        await elsewhere(browser, async (other) => {
            await createTag(other, a, 9301);
            await createTag(other, b, 9302);
        });
        await loadApp(page);
        await page.route('**/api/tags/move', route => route.fulfill({ status: 500 }));

        await openTagManagement(page, 'manual', stamp);
        await expect.poll(() => shownOrder(page)).toEqual([a, b]);

        await drag(page, b, a);

        await expect(page.locator('#toast-container .toast-error').filter({ hasText: 'The order is unchanged' })).toBeVisible({ timeout: 30000 });
        await expect.poll(() => shownOrder(page), { timeout: 30000 }).toEqual([a, b]);
        expect(await serverManualOrder(page, [a, b])).toEqual([a, b]);
    });

    test('Alphabetical: sends one reorder, switches to Manual, and takes the server\'s order once it is applied', async ({ browser, page }) => {
        const stamp = `draga${Date.now()}`;
        const [a, b, c] = ['a', 'b', 'c'].map(letter => `${stamp}-${letter}`);
        await elsewhere(browser, async (other) => {
            await createTag(other, a, 9403);
            await createTag(other, b, 9401);
            await createTag(other, c, 9402);
        });
        await loadApp(page);

        await openTagManagement(page, 'alphabetical', stamp);
        await expect.poll(() => shownOrder(page)).toEqual([a, b, c]);
        const writes = recordTagWrites(page);

        await drag(page, c, a);

        await expect(page.locator('#tag_sort_mode_select')).toHaveAttribute('value', 'manual', { timeout: 30000 });
        expect(writes).toEqual([{ path: '/api/tags/reorder', body: { id: c, before: a, mode: 'alphabetical' } }]);
        await expect.poll(() => serverManualOrder(page, [a, b, c]), { timeout: 60000 }).toEqual([c, a, b]);
        await expect.poll(() => pageHoldsServerOrders(page, [a, b, c]), { timeout: 60000 }).toBe(true);
        await expect.poll(() => shownOrder(page), { timeout: 30000 }).toEqual([c, a, b]);
    });
});
