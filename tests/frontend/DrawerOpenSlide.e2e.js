import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// Fullscreen character management and character info slide open like the other drawers, instead of appearing at
// full height.

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
 * Opens a closed drawer by its classes and records its height every frame until it settles.
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 * @returns {Promise<number[]>}
 */
async function openingHeights(page, id) {
    return page.evaluate(async (id) => {
        const el = document.getElementById(id);
        el.classList.add('openDrawer');
        el.classList.remove('closedDrawer');
        const heights = [];
        for (let i = 0; i < 40; i++) {
            await new Promise(resolve => requestAnimationFrame(resolve));
            heights.push(Math.round(el.getBoundingClientRect().height));
        }
        return heights;
    }, id);
}

test.describe('drawers slide open', () => {
    test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: 1400, height: 900 });
        await loadApp(page);
        await page.evaluate(() => document.documentElement.style.setProperty('--animation-duration', '200ms'));
    });

    test('fullscreen character management', async ({ page }) => {
        await expect(page.locator('#right-nav-panel')).toHaveClass(/galleryFullscreen/);
        await expect(page.locator('#right-nav-panel')).toHaveClass(/closedDrawer/);
        const heights = await openingHeights(page, 'right-nav-panel');
        const full = heights.at(-1);
        expect(full).toBeGreaterThan(400);
        // Some frame shows it part way open.
        expect(heights.some(h => h > 120 && h < full - 20)).toBe(true);
    });

    test('fullscreen character info', async ({ page }) => {
        await page.evaluate(() => {
            const el = document.getElementById('char-info-panel');
            el.classList.add('charInfoFullscreen');
            el.setAttribute('data-active-menu', 'rm_ch_create_block');
        });
        const heights = await openingHeights(page, 'char-info-panel');
        const full = heights.at(-1);
        expect(full).toBeGreaterThan(400);
        expect(heights.some(h => h > 120 && h < full - 20)).toBe(true);
    });
});
