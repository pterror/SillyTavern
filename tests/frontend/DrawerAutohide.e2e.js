import { test, expect } from './fixtures.js';
import { testSetup, setStackedDrawers } from './frontent-test-utils.js';

async function awaitAppReady(page) {
    await page.evaluate(() => new Promise(resolve => {
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, resolve);
    }));
}

const gallery = page => page.locator('#right-nav-panel');

async function pinGallery(page) {
    const pin = page.locator('#rm_button_panel_pin');
    if (!await pin.isChecked()) await pin.evaluate(el => el.click());
}

test.describe('Fullscreen drawers hide when split', () => {
    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
        await page.setViewportSize({ width: 1400, height: 900 });
    });

    test.afterEach(async ({ page }) => {
        await setStackedDrawers(page, false);
    });

    test('the chat down its middle hides the fullscreen gallery; covering only its top keeps it', async ({ page }) => {
        await setStackedDrawers(page, true);
        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#right-nav-panel.galleryFullscreen')).toBeVisible();
        await expect(gallery(page)).not.toHaveClass(/stackCovered/);
        await pinGallery(page);

        await page.locator('#user-settings-button .drawer-icon').click();
        await expect(page.locator('#user-settings-block')).toHaveClass(/openDrawer/);
        await expect(gallery(page)).toHaveClass(/openDrawer/);
        await expect.poll(() => gallery(page).evaluate(el => el.dataset.stackCut)).toBe('true');
        await expect(gallery(page)).not.toHaveClass(/stackCovered/);
        await page.locator('#user-settings-button .drawer-icon').click();
        await expect(page.locator('#user-settings-block')).toHaveClass(/closedDrawer/);

        await page.locator('#chatDrawerIcon').click();
        await expect(gallery(page)).toHaveClass(/stackCovered/);
        await expect(gallery(page)).toBeHidden();
        await expect.poll(() => page.locator('#sheld').evaluate(el => el.dataset.stackCut ?? null)).toBe(null);

        await page.locator('#rightNavDrawerIcon').click();
        await expect(gallery(page)).not.toHaveClass(/stackCovered/);
        await expect(gallery(page)).toBeVisible();
    });
});
