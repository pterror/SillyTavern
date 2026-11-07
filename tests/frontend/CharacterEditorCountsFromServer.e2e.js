import { test, expect } from './fixtures.js';
import { openInfoTab, testSetup } from './frontent-test-utils.js';

/**
 * @param {import('@playwright/test').Page} page
 * @returns {string[]}
 */
function recordCountRequests(page) {
    /** @type {string[]} */
    const counted = [];
    page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith('/api/tokenizers/current/')) counted.push(`${path} ${request.postData() ?? ''}`);
    });
    return counted;
}

test.describe('character editor counts', () => {
    test.beforeEach(async ({ page }) => {
        await testSetup.awaitST({ page });
        await page.setViewportSize({ width: 1400, height: 900 });
    });

    test('a field\'s save answers with the card\'s counts, which the editor shows, and the page counts nothing', async ({ page }) => {
        const marker = `editor-count-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const name = `EditorCounts-${Date.now()}`;
        await page.locator('#rightNavDrawerIcon').click();
        await page.locator('#rm_button_create').click();
        await page.locator('#character_name_pole').fill(name);
        await page.locator('#create_button').evaluate(el => el.click());
        await page.waitForFunction(n => window['stTest'].context().name2 === n, name);
        const counted = recordCountRequests(page);

        await openInfoTab(page, 'description');
        await page.locator('.field_edit_toggle[data-for="description_textarea"]').click();
        await page.locator('#description_textarea').fill(`A test character who keeps a lantern lit. ${marker}`);
        const saved = page.waitForResponse(response => response.url().endsWith('/api/characters/merge-attributes') && response.ok());
        await page.locator('.field_edit_done[data-for="description_textarea"]').click();
        const answer = await (await saved).json();
        expect(Array.isArray(answer.card_token_counts?.counts)).toBe(true);
        await expect(page.locator('[data-token-counter="description_textarea"]')).toHaveText(/^[1-9]\d*$/);
        await expect(page.locator('#result_info_total_tokens')).toHaveText(/^[1-9]\d*$/);
        expect(counted.filter(line => line.includes(marker))).toEqual([]);
    });

    test('a tokenizer change answers with the open card counted anew', async ({ page }) => {
        const name = `EditorRecount-${Date.now()}`;
        await page.locator('#rightNavDrawerIcon').click();
        await page.locator('#rm_button_create').click();
        await page.locator('#character_name_pole').fill(name);
        await page.locator('#create_button').evaluate(el => el.click());
        await page.waitForFunction(n => window['stTest'].context().name2 === n, name);
        const counted = recordCountRequests(page);

        const saved = page.waitForResponse(response => response.url().endsWith('/api/settings/save-partial') && response.ok()
            && (response.request().postData() ?? '').includes('tokenizer'));
        await page.evaluate(() => $('#tokenizer').val('1').trigger('change'));
        const answer = await (await saved).json();
        expect(Array.isArray(answer.card_token_counts?.counts)).toBe(true);
        expect(answer.card_token_counts.tokenizer?.id).toBe(1);
        expect(counted.filter(line => line.includes('/count'))).toEqual([]);
    });
});
