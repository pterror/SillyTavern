import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

// fetchServerCharacterSearchResults()' request: the top 500 by relevance.
const TOP_SEARCH_PAGE_SIZE = 500;
const SEED_AVATAR = 'default_Seraphina.png';
const TAG_ID = 'count-tag';

async function awaitAppReady(page) {
    await page.evaluate(() => new Promise(resolve => {
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, resolve);
    }));
}

/**
 * Replaces characterRepository.query() with one answering from `window.__stub`, so each test sets the totals the
 * page and the top-500 search come back with.
 * - `pageTotal(filter)`: the list page's `total`, as the server would count it for that filter.
 * - `topRows`, `topTotal`: the top-500 search's rows and `total`.
 * - `rejectSort`: a sort field every query but the top-500 fails with invalid-sort-field for.
 * - `calls`: every query but the top-500, as `{ fav, sort }` (the filter's fav and the sort field).
 * @param {import('@playwright/test').Page} page
 */
async function stubQuery(page) {
    await page.evaluate(async ({ topPageSize }) => {
        const { characterRepository, CharacterQueryError } = await import('/scripts/character-repository.js');
        window['__stub'] = {
            pageTotal: () => 0,
            topRows: [],
            topTotal: 0,
            rejectSort: null,
            calls: [],
        };
        characterRepository.query = async (filter = {}, sort, _page, pageSize) => {
            const stub = window['__stub'];
            if (pageSize === topPageSize) {
                return { seq: 0, token: null, rows: stub.topRows, total: stub.topTotal, searchBackend: 'tantivy' };
            }
            stub.calls.push({ fav: filter.fav, sort: sort?.field });
            if (stub.rejectSort !== null && sort?.field === stub.rejectSort) {
                throw new CharacterQueryError('rejected by test', { status: 400, reason: 'invalid-sort-field' });
            }
            return { seq: 0, token: null, rows: [], total: stub.pageTotal(filter) };
        };
    }, { topPageSize: TOP_SEARCH_PAGE_SIZE });
}

/** @param {import('@playwright/test').Page} page */
function navigatorText(page) {
    return page.locator('#rm_print_characters_pagination .J-paginationjs-nav').innerText();
}

/** @param {import('@playwright/test').Page} page */
async function setSearchTerm(page, term) {
    if (!(await page.locator('#character_search_bar').isVisible())) {
        await page.locator('#rm_button_search').click();
    }
    await page.locator('#character_search_bar').fill(term);
}

/** Runs what a 'search-index-updated' on /changes/stream runs. */
async function searchIndexUpdated(page) {
    await page.evaluate(async () => {
        const { onSearchIndexUpdated } = await import('/scripts/character-list.js');
        onSearchIndexUpdated();
    });
}

/** @param {import('@playwright/test').Page} page */
async function loadList(page) {
    await testSetup.awaitST({ page });
    await awaitAppReady(page);
    await openCharacterManagementDrawer(page);
    await stubQuery(page);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} path
 * @param {object} body
 */
async function api(page, path, body) {
    await page.evaluate(async ({ path, body }) => {
        const headers = window['SillyTavern'].getContext().getRequestHeaders();
        const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!response.ok) throw new Error(`${path} -> ${response.status}`);
    }, { path, body });
}

test.describe('character list count', () => {
    test.beforeEach(async ({ page }) => {
        await loadList(page);
    });

    test.describe('server-paged', () => {
        test('when matches go down, search-index-updated brings the count down with the page', async ({ page }) => {
            await page.evaluate(() => {
                window['__stub'].pageTotal = () => 50;
                window['__stub'].topTotal = 50;
            });
            await setSearchTerm(page, 'zq');
            await expect.poll(() => navigatorText(page)).toMatch(/\.\. 50$/);

            // The top-500 search isn't re-sent on this refresh, so its total stays at 50.
            await page.evaluate(() => { window['__stub'].pageTotal = () => 3; });
            await searchIndexUpdated(page);

            await expect.poll(() => navigatorText(page)).toBe('1-3 .. 3');
        });

        test('with a tag filter, the count is the page total, not the top-500 search total', async ({ page }) => {
            // The filter bar lists only tags that exist and are assigned, so the tag is made on the server first.
            await api(page, '/api/tags/create', {
                tag: {
                    id: TAG_ID, name: 'count-tag', folder_type: 'NONE', filter_state: 'UNDEFINED', sort_order: 1000,
                    is_hidden_on_character_card: false, color: '', color2: '', create_date: Date.now(),
                },
            });
            await api(page, '/api/tags/assign', { id: SEED_AVATAR, tagId: TAG_ID });
            await page.reload();
            await loadList(page);

            await page.evaluate(() => {
                window['__stub'].pageTotal = filter => filter.tags?.include?.length ? 5 : 40;
                window['__stub'].topTotal = 40;
            });
            await setSearchTerm(page, 'zq');
            await expect.poll(() => navigatorText(page)).toMatch(/\.\. 40$/);

            // The filter bar starts collapsed.
            await page.locator(`#rm_characters_block .rm_tag_filter [id="${TAG_ID}"]`).dispatchEvent('click');

            await expect.poll(() => navigatorText(page)).toBe('1-5 .. 5');
        });

        test('an approximate page total is shown with its ~', async ({ page }) => {
            await page.evaluate(() => { window['__stub'].pageTotal = () => '~1200'; });
            await setSearchTerm(page, 'zq');

            await expect.poll(() => navigatorText(page)).toMatch(/^1-\d+ \.\. ~1200$/);

            await page.evaluate(() => { window['__stub'].pageTotal = () => 1200; });
            await searchIndexUpdated(page);

            await expect.poll(() => navigatorText(page)).toMatch(/^1-\d+ \.\. 1200$/);
        });
    });

    test('with a saved sort the server rejects, the count is the fallback page total, with a warning naming the sort', async ({ page }) => {
        await page.evaluate(async () => {
            const { power_user } = await import('/scripts/power-user.js');
            const { printCharacters } = await import('/scripts/character-list.js');
            window['__stub'].rejectSort = 'nonsense-count';
            window['__stub'].pageTotal = () => 7;
            window['__stub'].calls = [];
            const saved = power_user.sort_field;
            power_user.sort_field = 'nonsense-count';
            try {
                await printCharacters(true);
            } finally {
                power_user.sort_field = saved;
            }
        });

        await expect.poll(() => navigatorText(page)).toBe('1-7 .. 7');
        await expect(page.locator('.toast-warning').filter({ hasText: '"nonsense-count"' })).toHaveCount(1);
        // The list and the favorites hotswap each fall back to name order.
        await expect.poll(() => page.evaluate(() => window['__stub'].calls)).toEqual([
            { fav: undefined, sort: 'nonsense-count' },
            { fav: undefined, sort: 'name' },
            { fav: true, sort: 'nonsense-count' },
            { fav: true, sort: 'name' },
        ]);
    });
});
