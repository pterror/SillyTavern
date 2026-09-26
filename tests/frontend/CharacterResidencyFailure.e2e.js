import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * APP_READY auto-fires, so this listener runs even when added after the emit.
 * @param {import('@playwright/test').Page} page
 */
async function markAppReady(page) {
    await page.evaluate(() => {
        // @ts-ignore
        const ctx = SillyTavern.getContext();
        ctx.eventSource.once(ctx.eventTypes.APP_READY, () => { window['__appReady'] = true; });
    });
}

/** @param {import('@playwright/test').Page} page */
const isAppReady = page => page.evaluate(() => window['__appReady'] === true);

/** @param {import('@playwright/test').Page} page */
const syncFailedToast = page => page.locator('#toast-container .toast-title', { hasText: 'Character sync failed' });

test.describe('character residency failure at boot', () => {
    test('a rejecting groups fetch still reaches APP_READY, with the toast shown', async ({ page }) => {
        await page.route('**/api/groups/all', route => route.abort('failed'));
        await testSetup.awaitST({ page });
        await markAppReady(page);

        await expect.poll(() => isAppReady(page), { timeout: 15000 }).toBe(true);
        await expect(syncFailedToast(page)).toBeVisible();
    });

    test('a /changes request that never answers still reaches APP_READY, with the toast shown', async ({ page }) => {
        // Faked, so the per-request timeouts and retry delays can be run through instead of waited out.
        await page.clock.install();
        // Never fulfilled, aborted or continued: the request is held open.
        await page.route('**/api/characters/changes', () => {});
        await testSetup.awaitST({ page });
        await markAppReady(page);

        await expect.poll(async () => {
            await page.clock.runFor(60000);
            return isAppReady(page);
        }, { timeout: 20000 }).toBe(true);
        await expect(syncFailedToast(page)).toBeVisible();
    });
});
