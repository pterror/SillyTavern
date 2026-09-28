import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

// fetchServerCharacterSearchResults()' request: the top 500 by relevance.
const TOP_SEARCH_PAGE_SIZE = 500;
// Over getCharactersDebounced()'s 2s delay.
const CHANGE_DEBOUNCE_TIMEOUT_MS = 6000;
const QUIET_MS = 800;

async function awaitAppReady(page) {
    await page.evaluate(() => new Promise(resolve => {
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, resolve);
    }));
}

/**
 * Records /api/characters/query and /api/characters/changes requests, and can hold /query responses.
 * The real /changes/stream is replaced by one that never sends anything, so the only stream messages are
 * the ones a test sends with sendStreamMessage().
 * @param {import('@playwright/test').Page} page
 */
async function instrument(page) {
    await page.addInitScript(() => {
        const NativeEventSource = window.EventSource;
        window['__changeStreams'] = [];
        window.EventSource = class extends NativeEventSource {
            constructor(...args) {
                // @ts-ignore
                super(...args);
                window['__changeStreams'].push(this);
            }
        };
    });
    await page.route('**/api/characters/changes/stream', route => route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: ': quiet\n\n',
    }));

    const log = {
        /** @type {{ search: string|undefined, pageSize: number, page: number, fav: boolean|undefined }[]} */
        queries: [],
        changes: 0,
        inFlight: 0,
        lastActivity: Date.now(),
        /** @type {(() => void)[]} */
        held: [],
        hold: false,
    };
    await page.route('**/api/characters/query', async route => {
        const body = route.request().postDataJSON() ?? {};
        log.queries.push({ search: body.filter?.search, pageSize: body.pageSize, page: body.page, fav: body.filter?.fav });
        log.inFlight++;
        log.lastActivity = Date.now();
        if (log.hold) {
            await new Promise(resolve => log.held.push(() => resolve(undefined)));
        }
        try {
            await route.continue();
        } finally {
            log.inFlight--;
            log.lastActivity = Date.now();
        }
    });
    // The change sync (/changes, then groups) counts as activity, so a print it leads to isn't missed.
    const onSyncActivity = request => {
        const pathname = new URL(request.url()).pathname;
        if (pathname === '/api/characters/changes' || pathname.startsWith('/api/groups/')) {
            log.lastActivity = Date.now();
        }
    };
    page.on('requestfinished', onSyncActivity);
    page.on('requestfailed', onSyncActivity);
    page.on('request', request => {
        onSyncActivity(request);
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/characters/changes') {
            log.changes++;
        }
    });
    return log;
}

/** Waits until no /query or change-sync activity for QUIET_MS, counting from this call. */
async function waitForQuiet(log) {
    const since = Date.now();
    await expect.poll(() => log.inFlight === 0 && Date.now() - Math.max(since, log.lastActivity) >= QUIET_MS, { timeout: 30000 }).toBe(true);
}

/**
 * Delivers one /changes/stream message to the page's stream handler.
 * @param {import('@playwright/test').Page} page
 * @param {object} message
 */
async function sendStreamMessage(page, message) {
    await page.evaluate((data) => {
        const streams = window['__changeStreams'].filter(s => s.url.endsWith('/api/characters/changes/stream'));
        if (!streams.length) throw new Error('no /changes/stream EventSource');
        for (const stream of streams) {
            stream.onmessage(new MessageEvent('message', { data }));
        }
    }, JSON.stringify(message));
}

function searchIndexUpdated(seq = 1) {
    return { type: 'search-index-updated', seq };
}

// The list's own page queries: not the top-500 search, and not favsToHotswap()'s favorites-only query.
function pageQueries(log, from = 0) {
    return log.queries.slice(from).filter(q => q.pageSize !== TOP_SEARCH_PAGE_SIZE && q.fav !== true);
}

function topSearchQueries(log, from = 0) {
    return log.queries.slice(from).filter(q => q.pageSize === TOP_SEARCH_PAGE_SIZE);
}

async function listShowing(page) {
    return page.locator('#right-nav-panel').evaluate(el => el.classList.contains('openDrawer') && getComputedStyle(el).visibility !== 'hidden');
}

/** @param {import('@playwright/test').Page} page */
async function setSearchTerm(page, log, term) {
    if (!(await page.locator('#character_search_bar').isVisible())) {
        await page.locator('#rm_button_search').click();
    }
    await page.locator('#character_search_bar').fill(term);
    await expect.poll(() => pageQueries(log).some(q => q.search === term)).toBe(true);
    await waitForQuiet(log);
}

test.describe('search-index-updated on /changes/stream', () => {
    /** @type {Awaited<ReturnType<typeof instrument>>} */
    let log;

    test.beforeEach(async ({ page }) => {
        log = await instrument(page);
        await testSetup.awaitST({ page });
        await awaitAppReady(page);
        await openCharacterManagementDrawer(page);
        await expect.poll(() => listShowing(page)).toBe(true);
        await waitForQuiet(log);
    });

    test('with a search term, re-queries the visible page once and not the top-500 search', async ({ page }) => {
        await setSearchTerm(page, log, 'zq');
        const from = log.queries.length;

        await sendStreamMessage(page, searchIndexUpdated());
        await waitForQuiet(log);

        expect(pageQueries(log, from)).toEqual([{ search: 'zq', pageSize: expect.any(Number), page: 1, fav: undefined }]);
        expect(topSearchQueries(log, from)).toEqual([]);
    });

    test('without a search term, sends nothing', async ({ page }) => {
        const from = log.queries.length;

        await sendStreamMessage(page, searchIndexUpdated());
        await waitForQuiet(log);

        expect(log.queries.slice(from)).toEqual([]);
    });

    test('with the list not showing, sends nothing; coming back fetches only the page', async ({ page }) => {
        await setSearchTerm(page, log, 'zq');
        await page.locator('#rm_button_create').click();
        await expect.poll(() => listShowing(page)).toBe(false);
        const from = log.queries.length;
        const changesBefore = log.changes;

        await sendStreamMessage(page, searchIndexUpdated());
        await waitForQuiet(log);
        expect(log.queries.slice(from)).toEqual([]);

        await page.locator('#rm_button_back').click();
        await expect.poll(() => listShowing(page)).toBe(true);
        await expect.poll(() => pageQueries(log, from).length).toBe(1);
        await waitForQuiet(log);

        expect(pageQueries(log, from)).toHaveLength(1);
        expect(topSearchQueries(log, from)).toEqual([]);
        // Not marked dirty, so no change sync on the way back.
        expect(log.changes).toBe(changesBefore);
    });

    test('during a page fetch, one refresh runs after it, however many arrive', async ({ page }) => {
        await setSearchTerm(page, log, 'zq');
        const from = log.queries.length;

        log.hold = true;
        await sendStreamMessage(page, searchIndexUpdated(1));
        await expect.poll(() => log.held.length).toBe(1);
        await sendStreamMessage(page, searchIndexUpdated(2));
        await sendStreamMessage(page, searchIndexUpdated(3));
        await sendStreamMessage(page, searchIndexUpdated(4));
        log.hold = false;
        log.held.splice(0).forEach(release => release());
        await expect.poll(() => pageQueries(log, from).length).toBe(2);
        await waitForQuiet(log);

        expect(pageQueries(log, from)).toHaveLength(2);
        expect(topSearchQueries(log, from)).toEqual([]);
    });

    test('in local-pagination mode, sends nothing', async ({ page }) => {
        await setSearchTerm(page, log, 'zq');
        // A rejected sort field makes printCharacters() fall back to local pagination.
        const rejectSort = route => route.fulfill({
            status: 400,
            contentType: 'application/json',
            body: JSON.stringify({ error: true, reason: 'invalid-sort-field', message: 'rejected by test' }),
        });
        await page.route('**/api/characters/query', rejectSort);
        await page.evaluate(async () => {
            const { printCharacters } = await import('/scripts/character-list.js');
            await printCharacters(true);
        });
        await page.unroute('**/api/characters/query', rejectSort);
        await waitForQuiet(log);
        const from = log.queries.length;

        await sendStreamMessage(page, searchIndexUpdated());
        await waitForQuiet(log);

        expect(log.queries.slice(from)).toEqual([]);
    });
});

test.describe('change message ({}) on /changes/stream', () => {
    /** @type {Awaited<ReturnType<typeof instrument>>} */
    let log;

    test.beforeEach(async ({ page }) => {
        log = await instrument(page);
        await testSetup.awaitST({ page });
        await awaitAppReady(page);
        await openCharacterManagementDrawer(page);
        await expect.poll(() => listShowing(page)).toBe(true);
        await waitForQuiet(log);
    });

    test('with a search term, syncs without any /query', async ({ page }) => {
        await setSearchTerm(page, log, 'zq');
        const from = log.queries.length;
        const changesBefore = log.changes;

        await sendStreamMessage(page, {});
        await expect.poll(() => log.changes, { timeout: CHANGE_DEBOUNCE_TIMEOUT_MS }).toBeGreaterThan(changesBefore);
        await waitForQuiet(log);

        expect(log.queries.slice(from)).toEqual([]);
    });

    test('without a search term, syncs and reprints the page as before', async ({ page }) => {
        const from = log.queries.length;
        const changesBefore = log.changes;

        await sendStreamMessage(page, {});
        await expect.poll(() => pageQueries(log, from).length, { timeout: CHANGE_DEBOUNCE_TIMEOUT_MS }).toBe(1);
        await waitForQuiet(log);

        expect(log.changes).toBeGreaterThan(changesBefore);
        expect(pageQueries(log, from)).toHaveLength(1);
        expect(topSearchQueries(log, from)).toEqual([]);
    });

    test('while away with a search term, coming back syncs and fetches the page, not the top-500 search', async ({ page }) => {
        await setSearchTerm(page, log, 'zq');
        await page.locator('#rm_button_create').click();
        await expect.poll(() => listShowing(page)).toBe(false);
        const from = log.queries.length;
        const changesBefore = log.changes;

        await sendStreamMessage(page, {});
        // Away, the change message only marks the list dirty, with no debounce.
        await waitForQuiet(log);
        expect(log.queries.slice(from)).toEqual([]);
        expect(log.changes).toBe(changesBefore);

        await page.locator('#rm_button_back').click();
        await expect.poll(() => pageQueries(log, from).length).toBe(1);
        await waitForQuiet(log);

        expect(log.changes).toBeGreaterThan(changesBefore);
        expect(pageQueries(log, from)).toEqual([{ search: 'zq', pageSize: expect.any(Number), page: 1, fav: undefined }]);
        expect(topSearchQueries(log, from)).toEqual([]);
    });
});

test.describe('re-rendering the visible page keeps the list\'s scroll distance', () => {
    const CHARACTER_COUNT = 40;
    const SCROLLED_TO = 200;

    /** @type {Awaited<ReturnType<typeof instrument>>} */
    let log;

    /**
     * Creates CHARACTER_COUNT characters whose names all contain `term`.
     * @param {import('@playwright/test').Page} page
     * @param {string} term
     */
    async function createCharacters(page, term) {
        await page.evaluate(async ({ term, count }) => {
            // @ts-ignore
            const headers = SillyTavern.getContext().getRequestHeaders({ omitContentType: true });
            for (let i = 0; i < count; i++) {
                const form = new FormData();
                form.set('ch_name', `${term} ${i}`);
                const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
                if (!response.ok) throw new Error(`create failed: ${response.status}`);
            }
        }, { term, count: CHARACTER_COUNT });
    }

    /** @param {import('@playwright/test').Page} page */
    async function listScrollTop(page) {
        return page.locator('#rm_print_characters_block').evaluate(el => el.scrollTop);
    }

    /**
     * Searches for `term` until the list shows every character created for it.
     * @param {import('@playwright/test').Page} page
     * @param {string} term
     */
    async function showSearchResults(page, term) {
        await setSearchTerm(page, log, term);
        const rows = page.locator('#rm_print_characters_block .character_select');
        // The search index takes up the new characters in the background.
        await expect.poll(async () => {
            if (await rows.count() >= CHARACTER_COUNT) return true;
            await sendStreamMessage(page, searchIndexUpdated());
            await waitForQuiet(log);
            return false;
        }, { timeout: 60000 }).toBe(true);
    }

    /**
     * Scrolls the list to SCROLLED_TO.
     * @param {import('@playwright/test').Page} page
     */
    async function scrollList(page) {
        await page.locator('#rm_print_characters_block').evaluate((el, top) => { el.scrollTop = top; }, SCROLLED_TO);
        expect(await listScrollTop(page)).toBe(SCROLLED_TO);
    }

    test.beforeEach(async ({ page }) => {
        log = await instrument(page);
        await page.setViewportSize({ width: 1280, height: 400 });
        await testSetup.awaitST({ page });
        await awaitAppReady(page);
    });

    test('on search-index-updated with a search term', async ({ page }) => {
        const term = `Scrollkeep${Date.now()}`;
        await createCharacters(page, term);
        await page.reload();
        await awaitAppReady(page);
        await openCharacterManagementDrawer(page);
        await expect.poll(() => listShowing(page)).toBe(true);
        await waitForQuiet(log);
        await showSearchResults(page, term);
        await scrollList(page);
        const from = log.queries.length;

        await sendStreamMessage(page, searchIndexUpdated());
        await waitForQuiet(log);

        expect(pageQueries(log, from)).toHaveLength(1);
        expect(await listScrollTop(page)).toBe(SCROLLED_TO);
    });

    test('on refreshCharacterListCurrentPage(), as after duplicating a character', async ({ page }) => {
        const term = `Scrollkeep${Date.now()}`;
        await createCharacters(page, term);
        await page.reload();
        await awaitAppReady(page);
        await openCharacterManagementDrawer(page);
        await expect.poll(() => listShowing(page)).toBe(true);
        await waitForQuiet(log);
        await showSearchResults(page, term);
        await scrollList(page);
        const from = log.queries.length;

        expect(await page.evaluate(async () => {
            const { refreshCharacterListCurrentPage } = await import('/scripts/character-list.js');
            return refreshCharacterListCurrentPage();
        })).toBe(true);
        await waitForQuiet(log);

        expect(pageQueries(log, from)).toHaveLength(1);
        expect(await listScrollTop(page)).toBe(SCROLLED_TO);
    });
});
