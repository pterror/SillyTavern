import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// A character list page seen before is kept in browser storage: after a reload it is drawn at once from what was
// kept, the server is asked with the kept token whether it changed, and a changed page is drawn again.

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

/** @param {import('@playwright/test').Page} page @param {string} term */
async function setSearchTerm(page, term) {
    if (!(await page.locator('#character_search_bar').isVisible())) {
        await page.locator('#rm_button_search').click();
    }
    await page.locator('#character_search_bar').fill(term);
}

/** @param {import('@playwright/test').Page} page @param {string} avatar */
const rowName = (page, avatar) => page.locator(`#rm_print_characters_block .character_select[data-avatar="${avatar}"] .ch_name`);

/**
 * Holds the list's page queries until `release` is called, recording whether each carried a token.
 * @param {import('@playwright/test').Page} page
 */
async function holdPageQueries(page) {
    /** @type {(() => void)[]} */
    const waiting = [];
    /** @type {{ search: string | undefined, token: boolean }[]} */
    const seen = [];
    await page.route('**/api/characters/query', async (route) => {
        const body = route.request().postDataJSON();
        if (!body?.want?.includes('hashes')) return route.continue();
        seen.push({ search: body.filter?.search, token: typeof body.ifToken === 'string' });
        await new Promise(resolve => waiting.push(resolve));
        await route.continue();
    });
    return { seen, release: () => { for (const resolve of waiting.splice(0)) resolve(); } };
}

/**
 * Waits until a page for `term` is kept in browser storage.
 * @param {import('@playwright/test').Page} page
 * @param {string} term
 */
async function waitForKeptPage(page, term) {
    await expect.poll(() => page.evaluate(async (term) => {
        const { localforage } = await import('/lib.js');
        const { getCurrentUserHandle } = await import('/scripts/user.js');
        const store = localforage.createInstance({ name: `SillyTavern_QueryCache_${getCurrentUserHandle()}` });
        return (await store.keys()).some(key => key.includes(term));
    }, term)).toBe(true);
}

test.describe('kept character list pages', () => {
    test.setTimeout(120000);

    test.beforeEach(async ({ page }) => {
        await loadApp(page);
        await openCharacterManagementDrawer(page);
    });

    test.afterEach(async ({ page }) => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
    });

    test('after a reload the page is drawn before the server answers, and the server is asked with the kept token', async ({ page }) => {
        const stamp = Date.now();
        const avatar = await createCharacter(page, `Kept${stamp}`);
        await setSearchTerm(page, `Kept${stamp}`);
        await expect(rowName(page, avatar)).toHaveText(`Kept${stamp}`);
        // The search box and its term come back after the reload, so the same page is asked for.
        await waitForKeptPage(page, `Kept${stamp}`);

        const held = await holdPageQueries(page);
        await page.reload();
        await loadApp(page);
        await openCharacterManagementDrawer(page);
        await expect(rowName(page, avatar)).toHaveText(`Kept${stamp}`);
        const ours = held.seen.filter(request => request.search === `Kept${stamp}`);
        expect(ours.length).toBeGreaterThan(0);
        expect(ours.some(request => request.token)).toBe(true);
        held.release();
    });

    test('a kept page that changed on the server is drawn again with the change', async ({ page }) => {
        const stamp = Date.now();
        const first = await createCharacter(page, `Swap${stamp} First`);
        await setSearchTerm(page, `Swap${stamp}`);
        await expect(rowName(page, first)).toHaveText(`Swap${stamp} First`);
        await waitForKeptPage(page, `Swap${stamp}`);

        // Made while no page is open, so nothing updates the kept page before the next visit.
        const headers = await page.evaluate(() => window['SillyTavern'].getContext().getRequestHeaders({ omitContentType: true }));
        const origin = new URL(page.url()).origin;
        await page.goto('about:blank');
        const created = await page.context().request.post(`${origin}/api/characters/create`, { headers, multipart: { ch_name: `Swap${stamp} Later` } });
        expect(created.ok()).toBe(true);
        const later = await created.text();

        const held = await holdPageQueries(page);
        await loadApp(page);
        await openCharacterManagementDrawer(page);
        await expect(rowName(page, first)).toHaveText(`Swap${stamp} First`);
        await expect(rowName(page, later)).toHaveCount(0);
        held.release();
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await expect(rowName(page, later)).toHaveText(`Swap${stamp} Later`);
        await expect(rowName(page, first)).toHaveText(`Swap${stamp} First`);
    });
});
