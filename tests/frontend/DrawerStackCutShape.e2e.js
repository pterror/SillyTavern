import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, setStackedDrawers } from './frontent-test-utils.js';

// Stacked drawers settle: once nothing moves, nothing is recomputed or rewritten.

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

test.describe('stacked drawers', () => {
    test('once nothing moves, the stack stops: no layer is rewritten while the page is idle', async ({ page }) => {
        await page.setViewportSize({ width: 1400, height: 900 });
        await loadApp(page);
        await setStackedDrawers(page, true);
        await openCharacterManagementDrawer(page);
        await page.locator('#rm_print_characters_block .character_select').first().click();
        await expect(page.locator('#char-info-panel')).toHaveClass(/openDrawer/);
        await page.waitForTimeout(800);
        const rewrites = await page.evaluate(async () => {
            const layers = [...document.querySelectorAll('#sheld, #top-settings-holder > .drawer > .drawer-content')];
            const records = [];
            const observer = new MutationObserver(list => records.push(...list.map(m => `${m.target.id}.${m.attributeName}`)));
            for (const el of layers) observer.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
            await new Promise(r => setTimeout(r, 500));
            observer.disconnect();
            return records;
        });
        expect(rewrites).toEqual([]);
    });
});
