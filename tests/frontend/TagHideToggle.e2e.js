import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// The eye toggle in Manage Tags is an action: the page asks the server to hide or show the tag, and shows the new
// state only once the server has stored it.

// Longer than the settings save debounce, so a save from opening the drawer has emitted its own SETTINGS_UPDATED.
const SETTINGS_SAVE_SETTLE_MS = 3000;

/** @param {import('@playwright/test').Page} page */
async function loadApp(page) {
    await testSetup.awaitST({ page });
    // APP_READY is an auto-fire event: a listener added after it was emitted still runs.
    await page.evaluate(() => {
        window['__appReady'] = false;
        window['__settingsUpdated'] = 0;
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, () => { window['__appReady'] = true; });
        eventSource.on(eventTypes.SETTINGS_UPDATED, () => { window['__settingsUpdated']++; });
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
 * @param {import('@playwright/test').Browser} browser
 * @param {string} id
 */
async function createTag(browser, id) {
    // Created from a throwaway context so the page under test learns of the tag only through its own boot.
    const setupContext = await browser.newContext();
    try {
        const setup = await setupContext.newPage();
        await loadApp(setup);
        await api(setup, '/api/tags/create', {
            tag: {
                id, name: id, folder_type: 'NONE', filter_state: 'UNDEFINED', sort_order: 1000,
                is_hidden_on_character_card: false, create_date: Date.now(), color: '', color2: '',
            },
        });
    } finally {
        await setupContext.close();
    }
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function storedHidden(page, id) {
    const { tags } = await api(page, '/api/tags/by-ids', { ids: [id] });
    return tags[0].is_hidden_on_character_card;
}

/** @param {import('@playwright/test').Page} page */
async function openTagManagement(page) {
    await openCharacterManagementDrawer(page);
    await page.locator('.rm_tag_filter .manageTags:visible').first().click();
    await page.locator('#tag_view_list .tag_view_prune').waitFor({ state: 'visible', timeout: 10000 });
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {string[]} every tag or settings write the page sends from now on, as `path body`
 */
function recordWrites(page) {
    /** @type {string[]} */
    const writes = [];
    page.on('request', request => {
        const path = new URL(request.url()).pathname;
        if (path === '/api/tags/edit' || path.startsWith('/api/settings/save')) writes.push(`${path} ${request.postData()}`);
    });
    return writes;
}

test.describe('Manage Tags hide toggle', () => {
    test.setTimeout(180000);

    test('a flip is stored by one edit, survives a reload, and tells extensions', async ({ browser, page }) => {
        const id = `hide-stored-${Date.now()}`;
        await createTag(browser, id);
        await loadApp(page);

        await openTagManagement(page);
        const toggle = page.locator(`.tag_view_item[id="${id}"] .eye-toggle`);
        await expect(toggle).toHaveClass(/fa-eye(\s|$)/);
        await page.waitForTimeout(SETTINGS_SAVE_SETTLE_MS);
        const writes = recordWrites(page);
        const eventsBefore = await page.evaluate(() => window['__settingsUpdated']);

        await toggle.click();
        await expect(toggle).toHaveClass(/fa-eye-slash/);
        expect(await storedHidden(page, id)).toBe(true);
        expect(writes).toEqual([`/api/tags/edit ${JSON.stringify({ id, patch: { is_hidden_on_character_card: true } })}`]);
        await expect.poll(() => page.evaluate(() => window['__settingsUpdated'])).toBe(eventsBefore + 1);

        await page.reload();
        await loadApp(page);
        await openTagManagement(page);
        await expect(page.locator(`.tag_view_item[id="${id}"] .eye-toggle`)).toHaveClass(/fa-eye-slash/);

        await page.locator(`.tag_view_item[id="${id}"] .eye-toggle`).click();
        await expect(page.locator(`.tag_view_item[id="${id}"] .eye-toggle`)).toHaveClass(/fa-eye(\s|$)/);
        expect(await storedHidden(page, id)).toBe(false);
    });

    test('a flip the server could not store leaves the toggle as it was and says so', async ({ browser, page }) => {
        const id = `hide-failed-${Date.now()}`;
        await createTag(browser, id);
        await loadApp(page);

        await openTagManagement(page);
        const toggle = page.locator(`.tag_view_item[id="${id}"] .eye-toggle`);
        await expect(toggle).toHaveClass(/fa-eye(\s|$)/);

        await page.route('**/api/tags/edit', route => route.fulfill({ status: 500, body: '{}' }));
        await toggle.click();
        await expect(page.locator('.toast-error', { hasText: 'Tag could not be saved' })).toBeVisible();
        await expect(toggle).toHaveClass(/fa-eye(\s|$)/);
        await page.unroute('**/api/tags/edit');
        expect(await storedHidden(page, id)).toBe(false);
        expect(await page.evaluate(id => window['SillyTavern'].getContext().tags.find(tag => tag.id === id).is_hidden_on_character_card, id)).toBe(false);
    });

    test('a stored rename tells extensions', async ({ browser, page }) => {
        const id = `hide-rename-${Date.now()}`;
        await createTag(browser, id);
        await loadApp(page);

        await openTagManagement(page);
        const name = page.locator(`.tag_view_item[id="${id}"] .tag_view_name`);
        await name.click();
        await page.keyboard.press('End');
        await page.waitForTimeout(SETTINGS_SAVE_SETTLE_MS);
        const writes = recordWrites(page);
        const eventsBefore = await page.evaluate(() => window['__settingsUpdated']);
        await page.keyboard.type('x');
        await page.keyboard.press('Enter');
        await expect.poll(() => page.evaluate(() => window['__settingsUpdated'])).toBeGreaterThan(eventsBefore);
        expect(writes.filter(write => !write.startsWith('/api/tags/edit '))).toEqual([]);
    });
});
