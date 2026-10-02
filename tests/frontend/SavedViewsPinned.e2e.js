import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// A saved view's first page is kept pinned in browser storage: it is never evicted, so opening the view after a
// reload is drawn before the server answers. Deleting the view lets go of it.

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

/** @param {import('@playwright/test').Page} page @param {string} owner @returns {Promise<string[]>} */
async function pinnedKeys(page, owner) {
    return page.evaluate(async (owner) => {
        const cache = await import('/scripts/query-result-cache.js');
        const { getCacheUserHandle } = await import('/scripts/character-cache.js');
        cache.setQueryCacheUser(getCacheUserHandle());
        return cache.pinnedQueryCacheKeys(owner);
    }, owner);
}

/** @param {import('@playwright/test').Page} page @param {string} avatar */
const row = (page, avatar) => page.locator(`#rm_print_characters_block .character_select[data-avatar="${avatar}"]`);

test.describe('saved views pin their first page', () => {
    test.setTimeout(120000);

    test('opening a saved view pins its page, a reload draws it before the server answers, and deleting it lets go', async ({ page }) => {
        await loadApp(page);
        await openCharacterManagementDrawer(page);
        const stamp = Date.now();
        const avatar = await createCharacter(page, `Pinned${stamp}`);

        if (!(await page.locator('#character_search_bar').isVisible())) await page.locator('#rm_button_search').click();
        await page.locator('#character_search_bar').fill(`Pinned${stamp}`);
        await expect(row(page, avatar)).toBeVisible();
        await page.locator('#character_view_picker').click();
        await page.locator('.view_picker_save input').fill(`Pinned view ${stamp}`);
        await page.locator('.view_picker_save .menu_button').click();
        await expect(page.locator('#character_view_picker .view_picker_name')).toHaveText(`Pinned view ${stamp}`);
        const id = await page.locator('#character_view_picker').getAttribute('data-view-id');
        expect(id).toBeTruthy();
        await expect.poll(() => pinnedKeys(page, `view:${id}`)).toHaveLength(1);
        const [key] = await pinnedKeys(page, `view:${id}`);
        expect(key).toContain(`Pinned${stamp}`);

        // The pinned page is drawn before the server answers.
        /** @type {(() => void)[]} */
        const waiting = [];
        await page.route('**/api/characters/query', async (route) => {
            if (!route.request().postDataJSON()?.want?.includes('hashes')) return route.continue();
            await new Promise(resolve => waiting.push(resolve));
            await route.continue();
        });
        await loadApp(page);
        await openCharacterManagementDrawer(page);
        await expect(page.locator('#character_view_picker .view_picker_name')).toHaveText(`Pinned view ${stamp}`);
        await expect(row(page, avatar)).toBeVisible();
        for (const resolve of waiting.splice(0)) resolve();
        await page.unrouteAll({ behavior: 'ignoreErrors' });

        await page.locator('#character_view_picker').click();
        const viewRow = page.locator(`.view_picker_popover .view_picker_row[data-view-id="${id}"]`);
        await viewRow.locator('[data-action="delete"]').click();
        await viewRow.locator('.view_picker_confirm').click();
        await expect.poll(() => pinnedKeys(page, `view:${id}`)).toHaveLength(0);
    });
});
