import { test, expect } from './fixtures.js';
import { testSetup, setStackedDrawers } from './frontent-test-utils.js';

// With stacked drawers on, a fullscreen drawer whose uncovered part falls apart into separate pieces is hidden whole.

async function awaitAppReady(page) {
    await page.evaluate(() => new Promise(resolve => {
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, resolve);
    }));
}

const gallery = page => page.locator('#right-nav-panel');

// Pins are toggled through the checkbox's own click handler; the checkbox itself is styled out of view.
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

    // The data root is shared by the worker's later tests, which expect the defaults.
    test.afterEach(async ({ page }) => {
        await setStackedDrawers(page, false);
    });

    test('the chat down its middle hides the fullscreen gallery; covering only its top keeps it', async ({ page }) => {
        await setStackedDrawers(page, true);
        // Fullscreen is character management's default.
        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#right-nav-panel.galleryFullscreen')).toBeVisible();
        await expect(gallery(page)).not.toHaveClass(/stackCovered/);
        // Pinned, so opening another drawer leaves it open.
        await pinGallery(page);

        // A drop-down drawer covers the gallery's top middle only: what's left is one piece.
        await page.locator('#user-settings-button .drawer-icon').click();
        await expect(page.locator('#user-settings-block')).toHaveClass(/openDrawer/);
        await expect(gallery(page)).toHaveClass(/openDrawer/);
        await expect.poll(() => gallery(page).evaluate(el => el.dataset.stackCut)).toBe('true');
        await expect(gallery(page)).not.toHaveClass(/stackCovered/);
        await page.locator('#user-settings-button .drawer-icon').click();
        await expect(page.locator('#user-settings-block')).toHaveClass(/closedDrawer/);

        // The chat column brought forward over it, top to bottom: two strips left, so it hides.
        await page.locator('#chatDrawerIcon').click();
        await expect(gallery(page)).toHaveClass(/stackCovered/);
        await expect(gallery(page)).toBeHidden();
        // Hidden, it cuts nothing: the chat isn't cut where the gallery was.
        await expect.poll(() => page.locator('#sheld').evaluate(el => el.dataset.stackCut ?? null)).toBe(null);

        // Brought forward again, it shows.
        await page.locator('#rightNavDrawerIcon').click();
        await expect(gallery(page)).not.toHaveClass(/stackCovered/);
        await expect(gallery(page)).toBeVisible();
    });
});
