import { test, expect } from './fixtures.js';
import { testSetup, setStackedDrawers, setDrawerBarPosition, setDrawerBarMobilePosition } from './frontent-test-utils.js';

async function awaitAppReady(page) {
    await page.evaluate(() => new Promise(resolve => {
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, resolve);
    }));
}

const chatIcon = page => page.locator('#chatDrawerIcon');

/**
 * Whether the icon's center is on screen and a click there reaches the icon.
 * @param {import('@playwright/test').Page} page
 */
function chatIconClickable(page) {
    return chatIcon(page).evaluate(el => {
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        return x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight
            && el.contains(document.elementFromPoint(x, y));
    });
}

/**
 * Whether the chat is what the user sees and can click at its own center.
 * @param {import('@playwright/test').Page} page
 */
function chatHitAtCenter(page) {
    return page.locator('#sheld').evaluate(el => {
        const r = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    });
}

/** @param {import('@playwright/test').Page} page */
function chatOrder(page) {
    return page.locator('#sheld').evaluate(el => el.style.getPropertyValue('--drawerOrder'));
}

test.describe('Chat icon in the drawer bar', () => {
    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
        await page.setViewportSize({ width: 1400, height: 900 });
    });

    // The data root is shared by the worker's later tests, which expect the defaults.
    test.afterEach(async ({ page }) => {
        await setStackedDrawers(page, false);
        await setDrawerBarPosition(page, 'top');
        await setDrawerBarMobilePosition(page, 'top');
    });

    test('shown only with stacked drawers on, first in the bar', async ({ page }) => {
        await setStackedDrawers(page, false);
        await expect(chatIcon(page)).toBeHidden();

        await setStackedDrawers(page, true);
        await expect(chatIcon(page)).toBeVisible();
        const firstShown = await page.locator('#top-settings-holder > .drawer').evaluateAll(drawers =>
            drawers.find(d => d.getBoundingClientRect().width > 0)?.id);
        expect(firstShown).toBe('chat-button');
    });

    test('brings forward a chat that fullscreen character management covers entirely, and is lit while the chat is in front', async ({ page }) => {
        await setStackedDrawers(page, true);
        await expect(chatIcon(page)).toHaveClass(/stackFront/);

        // Fullscreen is character management's default.
        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#right-nav-panel.galleryFullscreen')).toBeVisible();
        await expect(page.locator('#sheld')).toHaveClass(/stackCovered/);
        await expect(chatIcon(page)).not.toHaveClass(/stackFront/);

        await chatIcon(page).click();
        await expect(page.locator('#sheld')).not.toHaveClass(/stackCovered/);
        await expect.poll(() => chatHitAtCenter(page)).toBe(true);
        await expect(chatIcon(page)).toHaveClass(/stackFront/);
        // Character management stays open, showing only where the chat doesn't cover it.
        await expect(page.locator('#right-nav-panel')).toHaveClass(/openDrawer/);
        await expect(page.locator('#right-nav-panel')).toHaveAttribute('data-stack-cut', 'true');

        // In front already: clicking again changes nothing.
        const order = await chatOrder(page);
        await chatIcon(page).click();
        expect(await chatOrder(page)).toBe(order);
        await expect(chatIcon(page)).toHaveClass(/stackFront/);

        // Character management brought forward again by its icon: the chat icon goes dark.
        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#sheld')).toHaveClass(/stackCovered/);
        await expect(chatIcon(page)).not.toHaveClass(/stackFront/);
    });

    test('goes dark while a drawer covers part of the chat, and lights when the chat comes forward', async ({ page }) => {
        await setStackedDrawers(page, true);
        await page.locator('#user-settings-button .drawer-icon').click();
        await expect(page.locator('#user-settings-block')).toHaveClass(/openDrawer/);
        await expect(chatIcon(page)).not.toHaveClass(/stackFront/);

        await chatIcon(page).click();
        await expect(chatIcon(page)).toHaveClass(/stackFront/);
        await expect.poll(() => chatHitAtCenter(page)).toBe(true);
    });

    for (const position of ['top', 'bottom', 'left', 'right']) {
        test(`shown in the bar at the ${position}`, async ({ page }) => {
            await setStackedDrawers(page, true);
            await setDrawerBarPosition(page, position);
            await expect(chatIcon(page)).toBeVisible();
            await expect.poll(() => chatIconClickable(page)).toBe(true);
        });
    }
});

test.describe('Chat icon in the drawer bar, mobile', () => {
    test.use({ viewport: { width: 412, height: 915 } });

    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
    });

    test.afterEach(async ({ page }) => {
        await setStackedDrawers(page, false);
        await setDrawerBarMobilePosition(page, 'top');
    });

    for (const position of ['top', 'bottom']) {
        test(`shown in the bar at the ${position}`, async ({ page }) => {
            await setStackedDrawers(page, true);
            await setDrawerBarMobilePosition(page, position);
            await expect(chatIcon(page)).toBeVisible();
            await expect.poll(() => chatIconClickable(page)).toBe(true);
        });
    }
});
