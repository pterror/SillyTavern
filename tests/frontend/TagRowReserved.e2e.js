import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function measure(page) {
    return page.evaluate(() => ({
        row: document.getElementById('tags_div_preview').getBoundingClientRect().height,
        chip: document.querySelector('#tags_div_preview .tag')?.getBoundingClientRect().height ?? null,
        chipIndent: (document.querySelector('#tags_div_preview .tag')?.getBoundingClientRect().left ?? NaN) - document.getElementById('tags_div_preview').getBoundingClientRect().left,
        below: document.getElementById('creatorInfoWrapper').getBoundingClientRect().top - document.getElementById('tags_div').getBoundingClientRect().top,
    }));
}

test.describe('character info tag row', () => {
    test.beforeEach(testSetup.awaitST);

    test('keeps one chip of height with no tags, so the first tag and removing it move nothing below', async ({ page }) => {
        const name = `TagRowReservedTest-${Date.now()}`;
        await openCharacterManagementDrawer(page);
        await page.locator('#rm_button_create').click();
        await page.locator('#character_name_pole').fill(name);
        await page.locator('#create_button_label').click();
        await page.waitForFunction(n => window['stTest'].context().name2 === n, name);
        await expect(page.locator('#char-info-panel')).toHaveClass(/openDrawer/);
        await page.locator('#tagInput').waitFor({ state: 'visible', timeout: 10000 });
        try {
            await expect(page.locator('#tags_div_preview .tag')).toHaveCount(0);
            const empty = await measure(page);
            expect(empty.row).toBeGreaterThan(0);

            const tag = `reserved${Date.now()}`;
            await page.locator('#tagInput').pressSequentially(tag);
            await page.locator('.ui-autocomplete .ui-menu-item').first().click();
            await page.locator('#tagInput').fill('');
            await page.locator('#tagInput').blur();
            await expect(page.locator('#tags_div_preview .tag')).toHaveCount(1);
            const one = await measure(page);
            expect(one.chip).toBe(empty.row);
            expect(one.chipIndent).toBe(0);
            expect(one.row).toBe(empty.row);
            expect(one.below).toBe(empty.below);

            await page.locator('#tagList .tag .tag_remove').first().dispatchEvent('click');
            await expect(page.locator('#tags_div_preview .tag')).toHaveCount(0);
            const removed = await measure(page);
            expect(removed.row).toBe(empty.row);
            expect(removed.below).toBe(empty.below);
        } finally {
            await page.locator('#delete_button').click();
            const confirmButton = page.locator('.popup-button-ok');
            await confirmButton.first().waitFor({ state: 'visible', timeout: 5000 });
            await confirmButton.first().click();
        }
    });
});
