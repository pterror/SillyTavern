import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/** @param {import('@playwright/test').Page} page */
async function loadList(page) {
    await testSetup.awaitST({ page });
    await page.evaluate(() => new Promise(resolve => {
        const { eventSource, eventTypes } = window['stTest'].context();
        eventSource.once(eventTypes.APP_READY, resolve);
    }));
    await openCharacterManagementDrawer(page);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @returns {Promise<string>}
 */
function createCharacter(page, name) {
    return page.evaluate(async (name) => {
        const { getRequestHeaders } = await import('./script.js');
        const form = new FormData();
        form.set('ch_name', name);
        const response = await fetch('/api/characters/create', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, name);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function deleteCharacter(page, avatar) {
    await page.evaluate(async (avatar) => {
        const { getRequestHeaders } = await import('./script.js');
        await fetch('/api/characters/delete', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, delete_chats: true }) });
    }, avatar);
}

test.describe('the character list while searching', () => {
    test('a character made elsewhere that matches the search shows up, and leaves when deleted', async ({ page }) => {
        await loadList(page);
        const stamp = `${Date.now()}`;
        const name = `Livesearchee${stamp}`;
        if (!(await page.locator('#character_search_bar').isVisible())) {
            await page.locator('#rm_button_search').click();
        }
        await page.locator('#character_search_bar').fill(name);
        const row = page.locator(`#rm_print_characters_block .character_select .ch_name:text-is("${name}")`);
        await expect(row).toHaveCount(0);

        const avatar = await createCharacter(page, name);
        try {
            await expect(row).toHaveCount(1, { timeout: 15000 });
        } finally {
            await deleteCharacter(page, avatar);
        }
        await expect(row).toHaveCount(0, { timeout: 15000 });
        await expect(page.locator('#character_search_bar')).toHaveValue(name);
    });
});
