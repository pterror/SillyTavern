import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// The page lets go of a tag once nothing needs it: nothing on screen draws it, no character or group it holds
// carries it, no filter is set on it, and no extension put it into `tags`.

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

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
        return response.json();
    }, { path, body });
}

/** @param {import('@playwright/test').Page} page @param {string} id */
async function createTag(page, id) {
    await api(page, '/api/tags/create', { tag: { id, name: id, folder_type: 'NONE', is_hidden_on_character_card: false, color: '', color2: '', create_date: 1 } });
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

/** @param {import('@playwright/test').Page} page @param {string} id @returns {Promise<boolean>} */
async function holds(page, id) {
    return page.evaluate(async (id) => {
        const { tagsStore } = await import('/scripts/tags.js');
        return tagsStore.has(id);
    }, id);
}

/** @param {import('@playwright/test').Page} page @param {string} term */
async function openTagManagementOn(page, term) {
    await openCharacterManagementDrawer(page);
    await page.locator('.rm_tag_filter .manageTags:visible').first().click();
    await page.locator('#tag_view_list .tag_view_prune').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('#tag_view_search').fill(term);
}

// Past the sweep's delay after the last change.
const SWEEP_TIMEOUT_MS = 10000;

test.describe('letting go of tags', () => {
    test.setTimeout(120000);

    test('a tag Manage Tags showed is let go once it is closed; the open character\'s tags are kept', async ({ browser, page }) => {
        const stamp = Date.now();
        const shown = `letgo-shown-${stamp}`;
        const carried = `letgo-carried-${stamp}`;
        const context = await browser.newContext();
        let avatar;
        try {
            const setup = await context.newPage();
            await loadApp(setup);
            await createTag(setup, shown);
            await createTag(setup, carried);
            avatar = await createCharacter(setup, `TagLetGo-${stamp}`);
            await api(setup, '/api/tags/assign', { id: avatar, tagId: carried });
        } finally {
            await context.close();
        }
        await loadApp(page);
        await page.evaluate(async (avatar) => {
            const { selectCharacterByAvatar } = await import('/script.js');
            await selectCharacterByAvatar(avatar);
        }, avatar);
        await expect.poll(() => holds(page, carried)).toBe(true);

        await openTagManagementOn(page, `letgo-shown-${stamp}`);
        await expect(page.locator(`#tag_view_list .tag_view_item[id="${shown}"]`)).toBeVisible();
        expect(await holds(page, shown)).toBe(true);

        await page.locator('dialog[open]', { has: page.locator('#tag_view_list') }).locator('.popup-button-ok').click();
        await expect(page.locator('#tag_view_list')).toHaveCount(0);
        await expect.poll(() => holds(page, shown), { timeout: SWEEP_TIMEOUT_MS }).toBe(false);
        expect(await holds(page, carried)).toBe(true);
    });

    test('a tag an extension put into `tags` is kept after it is stored', async ({ page }) => {
        const stamp = Date.now();
        const id = `letgo-extension-${stamp}`;
        await loadApp(page);
        await page.evaluate(async (id) => {
            const { tags } = await import('/scripts/tags.js');
            const { saveSettingsDebounced } = await import('/script.js');
            tags.push({ id, name: id, color: '', color2: '', folder_type: 'NONE' });
            saveSettingsDebounced();
        }, id);
        await expect.poll(async () => (await api(page, '/api/tags/by-ids', { ids: [id] })).tags.length).toBe(1);
        // Long enough for a sweep to have run after the create was taken in.
        await page.waitForTimeout(5000);
        expect(await holds(page, id)).toBe(true);
    });

    test('a tag a filter is set on is kept', async ({ browser, page }) => {
        const stamp = Date.now();
        const id = `letgo-filter-${stamp}`;
        const context = await browser.newContext();
        try {
            const setup = await context.newPage();
            await loadApp(setup);
            await createTag(setup, id);
        } finally {
            await context.close();
        }
        await page.addInitScript((id) => localStorage.setItem(`CharacterList_tag_${id}`, 'SELECTED'), id);
        await loadApp(page);
        await openCharacterManagementDrawer(page);
        await expect.poll(() => holds(page, id), { timeout: SWEEP_TIMEOUT_MS }).toBe(true);
        await page.waitForTimeout(5000);
        expect(await holds(page, id)).toBe(true);
    });
});
