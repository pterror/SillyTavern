import { test, expect } from './fixtures.js';
import { testSetup, setDrawerBarPosition } from './frontent-test-utils.js';

// The sidebar drawers (AI Response Configuration on the left, character info and character management on the right)
// reach from the top of the screen to the bottom, wherever the drawer bar is.

async function awaitAppReady(page) {
    await page.evaluate(() => new Promise(resolve => {
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, resolve);
    }));
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 * @returns {Promise<{ top: number, bottom: number }>}
 */
function verticalExtent(page, id) {
    return page.locator(`#${id}`).evaluate(el => {
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom - window.innerHeight) };
    });
}

test.describe('Sidebar drawers are full height', () => {
    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
        await page.setViewportSize({ width: 1400, height: 900 });
    });

    // The data root is shared by the worker's later tests, which expect the defaults.
    test.afterEach(async ({ page }) => {
        await setDrawerBarPosition(page, 'top');
    });

    for (const position of ['top', 'bottom', 'left', 'right']) {
        test(`with the drawer bar at the ${position}`, async ({ page }) => {
            await setDrawerBarPosition(page, position);
            await page.evaluate(() => document.getElementById('right-nav-panel').classList.remove('galleryFullscreen'));
            for (const [icon, id] of [['#leftNavDrawerIcon', 'left-nav-panel'], ['#charInfoDrawerIcon', 'char-info-panel'], ['#rightNavDrawerIcon', 'right-nav-panel']]) {
                await page.locator(icon).click();
                await expect(page.locator(`#${id}`)).toHaveClass(/openDrawer/);
                // top: 0 from the screen's top; bottom: 0 from the screen's bottom.
                await expect.poll(() => verticalExtent(page, id)).toEqual({ top: 0, bottom: 0 });
                await page.locator(icon).click();
                await expect(page.locator(`#${id}`)).toHaveClass(/closedDrawer/);
            }
        });
    }
});
