import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, setStackedDrawers } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

const CHARACTER_COUNT = 24;
const SCROLLED_TO = 300;

/** @param {import('@playwright/test').Page} page */
async function awaitAppReady(page) {
    await page.evaluate(() => {
        window['__appReady'] = false;
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, () => { window['__appReady'] = true; });
    });
    await page.waitForFunction(() => window['__appReady'], null, { timeout: 60000 });
}

/** @param {import('@playwright/test').Page} page */
const listScrollTop = page => page.locator('#rm_print_characters_block').evaluate(el => el.scrollTop);

for (const { layout, width, height } of [
    { layout: 'desktop', width: 1400, height: 500 },
    { layout: 'mobile', width: 450, height: 600 },
]) {
    for (const stacked of [false, true]) {
        test(`${layout}, stacked drawers ${stacked ? 'on' : 'off'}: reopening character management keeps the list's scroll position`, async ({ page }) => {
            await page.setViewportSize({ width, height });
            await testSetup.awaitST({ page });
            await awaitAppReady(page);
            await page.evaluate(async ({ count, prefix }) => {
                // @ts-ignore
                const headers = SillyTavern.getContext().getRequestHeaders({ omitContentType: true });
                for (let i = 0; i < count; i++) {
                    const form = new FormData();
                    form.set('ch_name', `${prefix} ${String(i).padStart(2, '0')}`);
                    const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
                    if (!response.ok) throw new Error(`create failed: ${response.status}`);
                }
            }, { count: CHARACTER_COUNT, prefix: `Scroll${Date.now()}` });
            await page.reload();
            await awaitAppReady(page);
            await setStackedDrawers(page, stacked);
            await openCharacterManagementDrawer(page);
            await expect.poll(() => page.locator('#rm_print_characters_block .character_select').count()).toBeGreaterThan(CHARACTER_COUNT);
            await page.waitForTimeout(500);

            await page.locator('#rm_print_characters_block').evaluate((el, top) => { el.scrollTop = top; }, SCROLLED_TO);
            expect(await listScrollTop(page)).toBe(SCROLLED_TO);

            await page.locator('#rightNavDrawerIcon').click();
            await expect(page.locator('#right-nav-panel')).toHaveClass(/closedDrawer/);
            await expect(page.locator('#right-nav-panel')).toBeHidden();

            await page.locator('#rightNavDrawerIcon').click();
            await expect(page.locator('#right-nav-panel')).toHaveClass(/openDrawer/);
            await page.waitForTimeout(1000);
            expect(Math.abs(await listScrollTop(page) - SCROLLED_TO)).toBeLessThanOrEqual(8);
        });
    }
}
