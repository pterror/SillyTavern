import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';
import { changeStreamRetryDelayMs } from '../../public/scripts/change-stream-backoff.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

// fetchServerCharacterSearchResults()' request: the top 500 by relevance.
const TOP_SEARCH_PAGE_SIZE = 500;
// Over getCharactersDebounced()'s 2s delay.
const CHANGE_DEBOUNCE_TIMEOUT_MS = 6000;
const QUIET_MS = 800;
const EVENT_SOURCE_CONNECTING = 0;
const EVENT_SOURCE_OPEN = 1;
const EVENT_SOURCE_CLOSED = 2;

async function awaitAppReady(page) {
    await page.evaluate(() => new Promise(resolve => {
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, resolve);
    }));
}

/**
 * Records /api/characters/query and /api/characters/changes requests, and can hold /query responses.
 * The real /changes/stream is replaced by one that never sends anything, so the only stream messages are
 * the ones a test sends with sendStreamMessage(). It answers with `log.streamStatus`. A 200 ends at once, and its
 * `retry` keeps the browser from reconnecting within a test, so the stream never reopens by itself.
 * @param {import('@playwright/test').Page} page
 */
async function instrument(page) {
    await page.addInitScript(() => {
        const NativeEventSource = window.EventSource;
        window['__changeStreams'] = [];
        // Every stream's creation, errors and opens, with its readyState at the time, on performance.now()'s clock.
        window['__streamEvents'] = [];
        window.EventSource = class extends NativeEventSource {
            constructor(...args) {
                // @ts-ignore
                super(...args);
                window['__changeStreams'].push(this);
                const record = type => window['__streamEvents'].push({ type, at: performance.now(), readyState: this.readyState });
                record('create');
                this.addEventListener('error', () => record('error'));
                this.addEventListener('open', () => record('open'));
            }
        };
        // When the disconnected notice was first added to and removed from the page, on the same clock.
        window['__notice'] = { shownAt: null, removedAt: null };
        const isNotice = node => node instanceof Element && node.matches('.toast-warning') && node.textContent.includes('Live updates are disconnected');
        new MutationObserver(mutations => {
            for (const mutation of mutations) {
                if (window['__notice'].shownAt === null && [...mutation.addedNodes].some(isNotice)) window['__notice'].shownAt = performance.now();
                if (window['__notice'].removedAt === null && [...mutation.removedNodes].some(isNotice)) window['__notice'].removedAt = performance.now();
            }
        }).observe(document, { childList: true, subtree: true });
    });
    await page.route('**/api/characters/changes/stream', async route => {
        // Counted before answering, so a notice a failed answer leads to can't be among them yet.
        const notices = await disconnectedNotice(page).count();
        log.streamRequests.push({ at: Date.now(), status: log.streamStatus, notices });
        await route.fulfill({
            status: log.streamStatus,
            headers: { 'Content-Type': 'text/event-stream' },
            body: 'retry: 86400000\n: quiet\n\n',
        });
    });

    const log = {
        streamStatus: 200,
        /** @type {{ at: number, status: number, notices: number }[]} */
        streamRequests: [],
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

/** Waits until no /query or change-sync activity for `quietMs`, counting from this call. */
async function waitForQuiet(log, quietMs = QUIET_MS) {
    const since = Date.now();
    await expect.poll(() => log.inFlight === 0 && Date.now() - Math.max(since, log.lastActivity) >= quietMs, { timeout: 30000 }).toBe(true);
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

test.describe('the list going from hidden to showing', () => {
    /** @type {Awaited<ReturnType<typeof instrument>>} */
    let log;

    test.beforeEach(async ({ page }) => {
        log = await instrument(page);
        await page.setViewportSize({ width: 1400, height: 900 });
        await testSetup.awaitST({ page });
        await awaitAppReady(page);
        await openCharacterManagementDrawer(page);
        await expect.poll(() => listShowing(page)).toBe(true);
        await waitForQuiet(log);
    });

    /** Covers the list with the character info panel, then waits for quiet. */
    async function coverList(page) {
        await page.locator('#rm_button_create').click();
        await expect.poll(() => listShowing(page)).toBe(false);
        await waitForQuiet(log);
    }

    /** Waits for the list to show and for quiet, then checks exactly one page query and no change sync since `from`. */
    async function expectOnePageQueryOnly(page, from, changesBefore) {
        await expect.poll(() => listShowing(page)).toBe(true);
        await expect.poll(() => pageQueries(log, from).length).toBe(1);
        await waitForQuiet(log);
        expect(pageQueries(log, from)).toHaveLength(1);
        expect(topSearchQueries(log, from)).toEqual([]);
        expect(log.changes).toBe(changesBefore);
    }

    test('closing the panel covering it re-queries the visible page once', async ({ page }) => {
        await coverList(page);
        const from = log.queries.length;
        const changesBefore = log.changes;

        await page.locator('#charInfoDrawerIcon').click();

        await expectOnePageQueryOnly(page, from, changesBefore);
    });

    test('bringing it to the front while covered re-queries the visible page once', async ({ page }) => {
        await coverList(page);
        const from = log.queries.length;
        const changesBefore = log.changes;

        await page.locator('#rightNavDrawerIcon').click();

        await expectOnePageQueryOnly(page, from, changesBefore);
    });

    test('opening its drawer re-queries the visible page once', async ({ page }) => {
        await page.locator('#rightNavDrawerIcon').click();
        await expect.poll(() => listShowing(page)).toBe(false);
        await waitForQuiet(log);
        const from = log.queries.length;
        const changesBefore = log.changes;

        await page.locator('#rightNavDrawerIcon').click();

        await expectOnePageQueryOnly(page, from, changesBefore);
    });

    test('bringing it to the front while already showing sends nothing', async ({ page }) => {
        const from = log.queries.length;
        const changesBefore = log.changes;

        await page.evaluate(async () => {
            const { frontDrawer } = await import('/script.js');
            frontDrawer('right-nav-panel');
        });
        await waitForQuiet(log);

        expect(log.queries.slice(from)).toEqual([]);
        expect(log.changes).toBe(changesBefore);
    });

    test('after a change message while covered, uncovering it syncs and fetches the page once', async ({ page }) => {
        await coverList(page);
        const from = log.queries.length;
        const changesBefore = log.changes;
        await sendStreamMessage(page, {});
        await waitForQuiet(log);
        expect(log.changes).toBe(changesBefore);

        await page.locator('#charInfoDrawerIcon').click();
        await expect.poll(() => log.changes).toBeGreaterThan(changesBefore);
        await expect.poll(() => pageQueries(log, from).length).toBe(1);
        await waitForQuiet(log);

        expect(pageQueries(log, from)).toHaveLength(1);
        expect(topSearchQueries(log, from)).toEqual([]);
    });

    test('with a search term, after a change message while covered, uncovering it syncs and fetches only the page', async ({ page }) => {
        await setSearchTerm(page, log, 'zq');
        await coverList(page);
        const from = log.queries.length;
        const changesBefore = log.changes;
        await sendStreamMessage(page, {});
        await waitForQuiet(log);
        expect(log.changes).toBe(changesBefore);

        await page.locator('#charInfoDrawerIcon').click();
        await expect.poll(() => log.changes).toBeGreaterThan(changesBefore);
        await expect.poll(() => pageQueries(log, from).length).toBe(1);
        await waitForQuiet(log);

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

test.describe('a refresh the user didn\'t ask for keeps the list\'s page and scroll distance', () => {
    const CHARACTER_COUNT = 30;
    const PAGE_SIZE = 10;
    const SCROLLED_TO = 100;

    /** @type {Awaited<ReturnType<typeof instrument>>} */
    let log;
    let term;
    /** @type {string[]} */
    let avatars;

    const listPageQueries = (from) => pageQueries(log, from).filter(q => q.pageSize === PAGE_SIZE);
    const listScrollTop = page => page.locator('#rm_print_characters_block').evaluate(el => el.scrollTop);
    const currentPage = page => page.evaluate(() => window['$']('#rm_print_characters_pagination').pagination('getCurrentPageNum'));

    test.beforeEach(async ({ page }) => {
        log = await instrument(page);
        await page.setViewportSize({ width: 1400, height: 400 });
        await testSetup.awaitST({ page });
        await awaitAppReady(page);
        term = `Pagekeep${Date.now()}`;
        avatars = await page.evaluate(async ({ term, count, size }) => {
            // @ts-ignore
            const headers = SillyTavern.getContext().getRequestHeaders({ omitContentType: true });
            const created = [];
            for (let i = 0; i < count; i++) {
                const form = new FormData();
                form.set('ch_name', `${term} ${String(i).padStart(2, '0')}`);
                const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
                if (!response.ok) throw new Error(`create failed: ${response.status}`);
                created.push(await response.text());
            }
            const { accountStorage } = await import('/scripts/util/AccountStorage.js');
            accountStorage.setItem('Characters_PerPage', String(size));
            return created;
        }, { term, count: CHARACTER_COUNT, size: PAGE_SIZE });
        await page.reload();
        await awaitAppReady(page);
        await openCharacterManagementDrawer(page);
        await expect.poll(() => listShowing(page)).toBe(true);
        await waitForQuiet(log);
    });

    /** Searches for `term` until the search index has taken up the characters created for it. */
    async function searchCreated(page) {
        await setSearchTerm(page, log, term);
        const rows = page.locator('#rm_print_characters_block .character_select');
        await expect.poll(async () => {
            if (await rows.count() >= PAGE_SIZE) return true;
            await sendStreamMessage(page, searchIndexUpdated());
            await waitForQuiet(log);
            return false;
        }, { timeout: 60000 }).toBe(true);
    }

    /** Goes to page 2 and scrolls the list to SCROLLED_TO. Returns where the queries after that start. */
    async function toPage2Scrolled(page) {
        await page.evaluate(() => window['$']('#rm_print_characters_pagination').pagination('go', 2));
        await waitForQuiet(log);
        expect(await currentPage(page)).toBe(2);
        await page.locator('#rm_print_characters_block').evaluate((el, top) => { el.scrollTop = top; }, SCROLLED_TO);
        expect(await listScrollTop(page)).toBe(SCROLLED_TO);
        return log.queries.length;
    }

    /** Checks that page queries ran since `from`, the last for page 2, and that the list is on page 2 at SCROLLED_TO. */
    async function expectPage2Kept(page, from) {
        expect(listPageQueries(from).length).toBeGreaterThan(0);
        expect(listPageQueries(from).at(-1).page).toBe(2);
        expect(await currentPage(page)).toBe(2);
        expect(await listScrollTop(page)).toBe(SCROLLED_TO);
    }

    async function coverList(page) {
        await page.locator('#rm_button_create').click();
        await expect.poll(() => listShowing(page)).toBe(false);
        await waitForQuiet(log);
    }

    async function uncoverList(page) {
        await page.locator('#charInfoDrawerIcon').click();
        await expect.poll(() => listShowing(page)).toBe(true);
    }

    async function duplicateFirstRow(page) {
        await page.evaluate(async () => {
            const avatar = document.querySelector('#rm_print_characters_block .character_select[data-avatar]').getAttribute('data-avatar');
            const { duplicateCharacter } = await import('/script.js');
            await duplicateCharacter({ avatar, silent: true });
        });
    }

    test('on search-index-updated with a search term', async ({ page }) => {
        await searchCreated(page);
        const from = await toPage2Scrolled(page);

        await sendStreamMessage(page, searchIndexUpdated());
        await expect.poll(() => listPageQueries(from).length).toBeGreaterThan(0);
        await waitForQuiet(log);

        await expectPage2Kept(page, from);
    });

    test('on the change stream reopening after an error, without a search term', async ({ page }) => {
        const from = await toPage2Scrolled(page);
        const changesBefore = log.changes;

        await fireStreamEvents(page, ['error', 'open']);
        await expect.poll(() => log.changes, { timeout: CHANGE_DEBOUNCE_TIMEOUT_MS }).toBeGreaterThan(changesBefore);
        await expect.poll(() => listPageQueries(from).length).toBeGreaterThan(0);
        await waitForQuiet(log);

        await expectPage2Kept(page, from);
    });

    test('on the change stream reopening after an error, with a search term', async ({ page }) => {
        await searchCreated(page);
        const from = await toPage2Scrolled(page);
        const changesBefore = log.changes;

        await fireStreamEvents(page, ['error', 'open']);
        await expect.poll(() => log.changes, { timeout: CHANGE_DEBOUNCE_TIMEOUT_MS }).toBeGreaterThan(changesBefore);
        await expect.poll(() => listPageQueries(from).length).toBeGreaterThan(0);
        await waitForQuiet(log);

        await expectPage2Kept(page, from);
    });

    test('on the list showing again with a change sync pending, without a search term', async ({ page }) => {
        const from = await toPage2Scrolled(page);
        await coverList(page);
        const changesBefore = log.changes;
        await sendStreamMessage(page, {});
        await waitForQuiet(log);
        expect(log.changes).toBe(changesBefore);

        await uncoverList(page);
        await expect.poll(() => log.changes).toBeGreaterThan(changesBefore);
        await expect.poll(() => listPageQueries(from).length).toBeGreaterThan(0);
        await waitForQuiet(log);

        await expectPage2Kept(page, from);
    });

    test('on the list showing again with no change sync pending', async ({ page }) => {
        const from = await toPage2Scrolled(page);
        await coverList(page);
        const changesBefore = log.changes;

        await uncoverList(page);
        await expect.poll(() => listPageQueries(from).length).toBeGreaterThan(0);
        await waitForQuiet(log);

        expect(log.changes).toBe(changesBefore);
        await expectPage2Kept(page, from);
    });

    test('on duplicating a character, when the visible page is re-queried', async ({ page }) => {
        const from = await toPage2Scrolled(page);

        await duplicateFirstRow(page);
        await waitForQuiet(log);

        await expectPage2Kept(page, from);
    });

    test('on duplicating a character, when the visible page can\'t be re-queried', async ({ page }) => {
        const from = await toPage2Scrolled(page);
        // The search sort still selected after the search term is cleared: the list isn't server-queryable.
        expect(await page.evaluate(async () => {
            window['$']('#character_sort_order option[data-field="search"]').prop('selected', true);
            const { refreshCharacterListCurrentPage } = await import('/scripts/character-list.js');
            return refreshCharacterListCurrentPage();
        })).toBe(false);
        await page.evaluate(() => {
            window['__pagesLoaded'] = 0;
            const { eventSource, eventTypes } = window['SillyTavern'].getContext();
            eventSource.on(eventTypes.CHARACTER_PAGE_LOADED, () => { window['__pagesLoaded']++; });
        });

        await duplicateFirstRow(page);
        await waitForQuiet(log);

        // Printed from the resident characters, without a page query.
        expect(await page.evaluate(() => window['__pagesLoaded'])).toBeGreaterThan(0);
        expect(listPageQueries(from)).toEqual([]);
        expect(await currentPage(page)).toBe(2);
        expect(await listScrollTop(page)).toBe(SCROLLED_TO);
    });

    test('on a background sync dropping a tag filter whose tag is gone', async ({ page }) => {
        const from = await toPage2Scrolled(page);
        const staleTagId = `stale-${Date.now()}`;
        // Excluding a tag that doesn't exist leaves the list as it is; the next print's filter-bar pass drops it.
        await page.evaluate(async (staleTagId) => {
            const { entitiesFilter } = await import('/scripts/character-list.js');
            const { FILTER_TYPES } = await import('/scripts/filters.js');
            const { selected, excluded } = entitiesFilter.getFilterData(FILTER_TYPES.TAG);
            entitiesFilter.setFilterData(FILTER_TYPES.TAG, { selected, excluded: [...excluded, staleTagId] }, true);
        }, staleTagId);
        const changesBefore = log.changes;

        await fireStreamEvents(page, ['error', 'open']);
        await expect.poll(() => log.changes, { timeout: CHANGE_DEBOUNCE_TIMEOUT_MS }).toBeGreaterThan(changesBefore);
        await expect.poll(() => listPageQueries(from).length).toBeGreaterThan(0);
        await waitForQuiet(log);

        expect(await page.evaluate(async () => {
            const { entitiesFilter } = await import('/scripts/character-list.js');
            const { FILTER_TYPES } = await import('/scripts/filters.js');
            return entitiesFilter.getFilterData(FILTER_TYPES.TAG).excluded;
        })).not.toContain(staleTagId);
        await expectPage2Kept(page, from);
    });

    test('on changing how rows look (the extra field shown on each row)', async ({ page }) => {
        const from = await toPage2Scrolled(page);

        await page.evaluate(() => {
            const select = window['$']('#aux_field');
            select.val(select.val() === 'creator' ? 'character_version' : 'creator').trigger('change');
        });
        await expect.poll(() => listPageQueries(from).length).toBeGreaterThan(0);
        await waitForQuiet(log);

        await expectPage2Kept(page, from);
    });

    test('on editing a character\'s data (adding a tag with /tag-add)', async ({ page }) => {
        const from = await toPage2Scrolled(page);

        await page.evaluate(async (name) => {
            const { executeSlashCommandsWithOptions } = window['SillyTavern'].getContext();
            await executeSlashCommandsWithOptions(`/tag-add name="${name}" Keeptag${Date.now()}`);
        }, `${term} 00`);
        await expect.poll(() => listPageQueries(from).length).toBeGreaterThan(0);
        await waitForQuiet(log);

        await expectPage2Kept(page, from);
    });

    test.describe('except the user changing the query, which goes to page 1 at the top', () => {
        async function expectPage1Top(page) {
            expect(await currentPage(page)).toBe(1);
            expect(await listScrollTop(page)).toBe(0);
        }

        test('the search term', async ({ page }) => {
            await searchCreated(page);
            await page.locator('#character_search_bar').fill('');
            await expect.poll(() => page.evaluate(async () => {
                const { hasActiveCharacterSearch } = await import('/scripts/character-list.js');
                return hasActiveCharacterSearch();
            })).toBe(false);
            await waitForQuiet(log);
            const from = await toPage2Scrolled(page);

            await page.locator('#character_search_bar').fill(term);
            await expect.poll(() => listPageQueries(from).some(q => q.search === term)).toBe(true);
            await waitForQuiet(log);

            await expectPage1Top(page);
        });

        test('a filter (favorites only)', async ({ page }) => {
            await page.evaluate(async (avatars) => {
                // @ts-ignore
                const headers = SillyTavern.getContext().getRequestHeaders();
                const response = await fetch('/api/characters/fav', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ bulk: avatars.map(avatar => ({ avatar, fav: true })) }),
                });
                if (!response.ok) throw new Error(`fav failed: ${response.status}`);
            }, avatars);
            await toPage2Scrolled(page);

            await page.locator('#rm_characters_block .rm_tag_filter .tag[id="1"]').click();
            await waitForQuiet(log);

            expect(await page.evaluate(async () => {
                const { entitiesFilter } = await import('/scripts/character-list.js');
                const { FILTER_TYPES } = await import('/scripts/filters.js');
                return entitiesFilter.getFilterData(FILTER_TYPES.FAV);
            })).toBe('SELECTED');
            await expectPage1Top(page);
        });

        test('the sort', async ({ page }) => {
            const from = await toPage2Scrolled(page);

            await page.evaluate(() => {
                const select = window['$']('#character_sort_order');
                const target = select.find('option[data-field="name"][data-order="desc"]').is(':selected')
                    ? 'option[data-field="name"][data-order="asc"]'
                    : 'option[data-field="name"][data-order="desc"]';
                select.find(target).prop('selected', true);
                select.trigger('change');
            });
            await expect.poll(() => listPageQueries(from).length).toBeGreaterThan(0);
            await waitForQuiet(log);

            await expectPage1Top(page);
        });

        test('"Tags as folders"', async ({ page }) => {
            const from = await toPage2Scrolled(page);

            await page.evaluate(() => {
                const checkbox = window['$']('#bogus_folders');
                checkbox.prop('checked', !checkbox.prop('checked')).trigger('input');
            });
            await expect.poll(() => listPageQueries(from).length).toBeGreaterThan(0);
            await waitForQuiet(log);

            await expectPage1Top(page);
        });
    });
});

function disconnectedNotice(page) {
    return page.locator('#toast-container .toast-warning .toast-message', { hasText: 'Live updates are disconnected' });
}

/**
 * Fires the page's /changes/stream handlers for the given events, in order.
 * @param {import('@playwright/test').Page} page
 * @param {('error'|'open')[]} types
 */
async function fireStreamEvents(page, types) {
    await page.evaluate((types) => {
        const streams = window['__changeStreams'].filter(s => s.url.endsWith('/api/characters/changes/stream'));
        if (!streams.length) throw new Error('no /changes/stream EventSource');
        const stream = streams.at(-1);
        for (const type of types) {
            const handler = stream[`on${type}`];
            if (handler) handler.call(stream, new Event(type));
        }
    }, types);
}

test.describe('the change stream reopening', () => {
    /** @type {Awaited<ReturnType<typeof instrument>>} */
    let log;

    async function bootWithListShowing(page) {
        await testSetup.awaitST({ page });
        await awaitAppReady(page);
        await openCharacterManagementDrawer(page);
        await expect.poll(() => listShowing(page)).toBe(true);
        await waitForQuiet(log);
    }

    test.describe('after an error', () => {
        test.beforeEach(async ({ page }) => {
            log = await instrument(page);
            await bootWithListShowing(page);
        });

        test('with the list showing, syncs and reprints the page', async ({ page }) => {
            const from = log.queries.length;
            const changesBefore = log.changes;

            await fireStreamEvents(page, ['error', 'open']);
            await expect.poll(() => pageQueries(log, from).length, { timeout: CHANGE_DEBOUNCE_TIMEOUT_MS }).toBe(1);
            await waitForQuiet(log);

            expect(log.changes).toBeGreaterThan(changesBefore);
            expect(pageQueries(log, from)).toHaveLength(1);
            expect(topSearchQueries(log, from)).toEqual([]);
        });

        test('with a search term, re-queries the visible page and syncs, without the top-500 search', async ({ page }) => {
            await setSearchTerm(page, log, 'zq');
            const from = log.queries.length;
            const changesBefore = log.changes;

            await fireStreamEvents(page, ['error', 'open']);
            await expect.poll(() => log.changes, { timeout: CHANGE_DEBOUNCE_TIMEOUT_MS }).toBeGreaterThan(changesBefore);
            await waitForQuiet(log);

            expect(pageQueries(log, from)).toEqual([{ search: 'zq', pageSize: expect.any(Number), page: 1, fav: undefined }]);
            expect(topSearchQueries(log, from)).toEqual([]);
        });

        test('with the list covered, sends nothing; uncovering it syncs and fetches the page once', async ({ page }) => {
            await page.locator('#rm_button_create').click();
            await expect.poll(() => listShowing(page)).toBe(false);
            await waitForQuiet(log);
            const from = log.queries.length;
            const changesBefore = log.changes;

            await fireStreamEvents(page, ['error', 'open']);
            await waitForQuiet(log);
            expect(log.queries.slice(from)).toEqual([]);
            expect(log.changes).toBe(changesBefore);

            await page.locator('#charInfoDrawerIcon').click();
            await expect.poll(() => log.changes).toBeGreaterThan(changesBefore);
            await expect.poll(() => pageQueries(log, from).length).toBe(1);
            await waitForQuiet(log);

            expect(pageQueries(log, from)).toHaveLength(1);
            expect(topSearchQueries(log, from)).toEqual([]);
        });
    });

    test('an open with no error before it sends nothing', async ({ page }) => {
        log = await instrument(page);
        // The mocked stream's body ends, which is an error, so this uses the server's own stream, which stays open.
        await page.unroute('**/api/characters/changes/stream');
        await bootWithListShowing(page);
        const from = log.queries.length;
        const changesBefore = log.changes;

        await fireStreamEvents(page, ['open']);
        await waitForQuiet(log, CHANGE_DEBOUNCE_TIMEOUT_MS);

        expect(log.queries.slice(from)).toEqual([]);
        expect(log.changes).toBe(changesBefore);
    });

    test('a closed stream is rebuilt with backoff, a notice shows once it has been closed 10s, and the reopen clears it and syncs', async ({ page }) => {
        test.setTimeout(90000);
        log = await instrument(page);
        log.streamStatus = 500;
        await bootWithListShowing(page);

        // The first connection and 3 rebuilds (after 1s, 2s, 4s) fail; the notice shows before the 4th (after 8s).
        await expect.poll(() => log.streamRequests.length, { timeout: 30000 }).toBe(4);
        await expect(disconnectedNotice(page)).toHaveCount(1, { timeout: 30000 });
        const changesBefore = log.changes;
        log.streamStatus = 200;

        await expect.poll(() => log.streamRequests.length, { timeout: 30000 }).toBe(5);
        await expect(disconnectedNotice(page)).toHaveCount(0);
        await expect.poll(() => log.changes, { timeout: CHANGE_DEBOUNCE_TIMEOUT_MS }).toBeGreaterThan(changesBefore);

        const requests = log.streamRequests;
        expect(requests.map(r => r.status)).toEqual([500, 500, 500, 500, 200]);
        expect(requests.map(r => r.notices)).toEqual([0, 0, 0, 0, 1]);
        const gaps = requests.slice(1).map((r, i) => r.at - requests[i].at);
        [1000, 2000, 4000, 8000].forEach((least, i) => expect(gaps[i]).toBeGreaterThanOrEqual(least));

        const { events, notice } = await page.evaluate(() => ({ events: window['__streamEvents'], notice: window['__notice'] }));
        const firstOpen = events.find(e => e.type === 'open');
        const failures = events.filter(e => e.type === 'error' && e.at < firstOpen.at);
        expect(failures.map(e => e.readyState)).toEqual([EVENT_SOURCE_CLOSED, EVENT_SOURCE_CLOSED, EVENT_SOURCE_CLOSED, EVENT_SOURCE_CLOSED]);
        // Never open until then, so not open since the first stream was created.
        expect(notice.shownAt - events[0].at).toBeGreaterThanOrEqual(10000);
        expect(notice.shownAt).toBeLessThan(firstOpen.at);
        expect(notice.removedAt).toBeGreaterThanOrEqual(firstOpen.at);
    });

    test('a stream the browser is reconnecting shows the notice once it has been down 10s, and an open clears it', async ({ page }) => {
        test.setTimeout(90000);
        log = await instrument(page);
        await bootWithListShowing(page);

        await expect(disconnectedNotice(page)).toHaveCount(1, { timeout: 30000 });
        const { events, notice } = await page.evaluate(() => ({ events: window['__streamEvents'], notice: window['__notice'] }));
        // The mocked stream opens, then its body ends: the browser keeps it CONNECTING and doesn't rebuild it.
        expect(events.map(e => [e.type, e.readyState])).toEqual([['create', EVENT_SOURCE_CONNECTING], ['open', EVENT_SOURCE_OPEN], ['error', EVENT_SOURCE_CONNECTING]]);
        expect(notice.shownAt - events[2].at).toBeGreaterThanOrEqual(10000);

        await fireStreamEvents(page, ['open']);
        await expect(disconnectedNotice(page)).toHaveCount(0);
        expect(log.streamRequests).toHaveLength(1);
    });

    test('the rebuild delay doubles from 1s and stops at 60s', () => {
        expect([0, 1, 2, 3, 4, 5, 6, 7, 20].map(changeStreamRetryDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    });
});

test.describe('character-index-failed on /changes/stream', () => {
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

    const failure = { type: 'character-index-failed', id: 'Flaky.png', name: 'Flaky', error: 'SyntaxError: Unexpected token', retryInMs: 1000, keptEntry: true };
    const warningToast = page => page.locator('.toast-warning').filter({ hasText: 'Flaky.png' });

    test('shows a warning naming the card, its error and when it is retried, and syncs nothing', async ({ page }) => {
        const changesBefore = log.changes;
        const queriesBefore = log.queries.length;

        await sendStreamMessage(page, failure);

        await expect(warningToast(page)).toHaveCount(1);
        const text = await warningToast(page).textContent();
        expect(text).toContain('"Flaky"');
        expect(text).toContain('SyntaxError: Unexpected token');
        expect(text).toContain('keeps its previous search entry');
        expect(text).toContain('1s');
        await waitForQuiet(log);
        expect(log.changes).toBe(changesBefore);
        expect(log.queries.length).toBe(queriesBefore);
    });

    test('a card with no entry kept says so, and one with an empty name is named by its id', async ({ page }) => {
        await sendStreamMessage(page, { ...failure, name: '', keptEntry: false });

        await expect(warningToast(page)).toHaveCount(1);
        const text = await warningToast(page).textContent();
        expect(text).not.toContain('""');
        expect(text).toContain('has no search entry');
    });
});
