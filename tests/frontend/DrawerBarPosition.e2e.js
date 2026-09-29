import { test, expect } from './fixtures.js';
import { testSetup, setDrawerBarPosition } from './frontent-test-utils.js';

const VIEWPORT = { width: 1400, height: 900 };

async function awaitAppReady(page) {
    await page.evaluate(() => new Promise(resolve => {
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, resolve);
    }));
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} selector
 * @returns {Promise<{ top: number, bottom: number, left: number, width: number, height: number }>}
 */
function rect(page, selector) {
    return page.locator(selector).evaluate(el => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, width: r.width, height: r.height };
    });
}

/** Waits until the drawer has finished opening (its height stops changing) and returns its rect. */
async function openedRect(page, selector) {
    let last = null;
    await expect.poll(async () => {
        const now = await rect(page, selector);
        const settled = last !== null && now.height > 0 && now.height === last.height && now.top === last.top;
        last = now;
        return settled;
    }).toBe(true);
    return last;
}

/** The thickness of the bar, --topBarBlockSize, in px. */
function barSize(page) {
    return page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.height = 'var(--topBarBlockSize)';
        document.body.append(probe);
        const size = probe.getBoundingClientRect().height;
        probe.remove();
        return size;
    });
}

async function setForceMobileView(page, on) {
    const checkbox = page.locator('#forceMobileView');
    if (await checkbox.isChecked() === on) return;
    await checkbox.evaluate(el => el.click());
    await page.waitForFunction(expected => document.body.classList.contains('forceMobileView') === expected, on);
}

/** The bar at the top: bar and holder from the top edge, the chat below the bar. */
async function expectBarAtTop(page) {
    const size = await barSize(page);
    const holder = await rect(page, '#top-settings-holder');
    const sheld = await rect(page, '#sheld');
    expect(holder.top).toBeCloseTo(0, 1);
    expect(holder.height).toBeCloseTo(size, 1);
    expect((await rect(page, '#top-bar')).top).toBeCloseTo(0, 1);
    expect(sheld.top).toBeCloseTo(size, 1);
}

test.describe('Drawer bar position', () => {
    test.use({ viewport: VIEWPORT });

    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
    });

    // The data root is shared by the worker's later tests, which expect the defaults.
    test.afterEach(async ({ page }) => {
        await setForceMobileView(page, false);
        await setDrawerBarPosition(page, 'top');
    });

    test('top: the bar is at the top edge, the chat and drawers below it', async ({ page }) => {
        await setDrawerBarPosition(page, 'top');
        const size = await barSize(page);
        await expectBarAtTop(page);
        const holder = await rect(page, '#top-settings-holder');
        const sheld = await rect(page, '#sheld');
        expect(holder.left).toBeCloseTo(sheld.left, 1);
        expect(holder.width).toBeCloseTo(sheld.width, 1);
        expect(sheld.bottom).toBeCloseTo(VIEWPORT.height - 1, 1);

        await page.locator('#user-settings-button .drawer-icon').click();
        const drawer = await openedRect(page, '#user-settings-block');
        expect(drawer.top).toBeCloseTo(size, 1);
    });

    test('bottom: the bar is at the bottom edge, as wide as the chat, which starts at the top edge', async ({ page }) => {
        await setDrawerBarPosition(page, 'bottom');
        const size = await barSize(page);
        const holder = await rect(page, '#top-settings-holder');
        const bar = await rect(page, '#top-bar');
        const sheld = await rect(page, '#sheld');

        expect(holder.bottom).toBeCloseTo(VIEWPORT.height, 1);
        expect(holder.height).toBeCloseTo(size, 1);
        expect(bar.bottom).toBeCloseTo(VIEWPORT.height, 1);
        for (const r of [holder, bar]) {
            expect(r.left).toBeCloseTo(sheld.left, 1);
            expect(r.width).toBeCloseTo(sheld.width, 1);
        }
        expect(sheld.top).toBeCloseTo(0, 1);
        expect(sheld.bottom).toBeLessThanOrEqual(holder.top);
    });

    test('bottom: a drawer opens from the top edge, ends above the bar, and its icon still opens and closes it', async ({ page }) => {
        await setDrawerBarPosition(page, 'bottom');
        const holder = await rect(page, '#top-settings-holder');
        const icon = page.locator('#user-settings-button .drawer-icon');

        await icon.click();
        await expect(page.locator('#user-settings-block')).toHaveClass(/openDrawer/);
        const drawer = await openedRect(page, '#user-settings-block');
        expect(drawer.top).toBeCloseTo(0, 1);
        expect(drawer.bottom).toBeLessThanOrEqual(holder.top);
        expect(drawer.left).toBeCloseTo(holder.left, 1);

        await icon.click();
        await expect(page.locator('#user-settings-block')).not.toHaveClass(/openDrawer/);
        await expect(page.locator('#user-settings-block')).toBeHidden();
    });

    test('bottom: fullscreen character management starts at the top edge and ends above the bar', async ({ page }) => {
        await setDrawerBarPosition(page, 'bottom');
        const holder = await rect(page, '#top-settings-holder');

        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#right-nav-panel.galleryFullscreen')).toBeVisible();
        const panel = await openedRect(page, '#right-nav-panel');
        expect(panel.top).toBeCloseTo(0, 1);
        expect(panel.bottom).toBeLessThanOrEqual(holder.top + 0.5);

        await page.locator('#rightNavDrawerIcon').click();
        await expect(page.locator('#right-nav-panel')).toBeHidden();
    });

    test('bottom survives a reload', async ({ page }) => {
        await setDrawerBarPosition(page, 'bottom');
        await page.reload();
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
        await expect(page.locator('body')).toHaveClass(/\bdrawerBarBottom\b/);
        await expect(page.locator('#drawer_bar_position')).toHaveValue('bottom');
        expect((await rect(page, '#top-settings-holder')).bottom).toBeCloseTo(VIEWPORT.height, 1);
    });

    test('bottom has no effect with Force Mobile View', async ({ page }) => {
        await setDrawerBarPosition(page, 'bottom');
        await setForceMobileView(page, true);
        await expect(page.locator('body')).toHaveClass(/\bdrawerBarBottom\b/);
        await expectBarAtTop(page);
    });
});

test.describe('Drawer bar position, mobile', () => {
    test.use({ viewport: { width: 412, height: 915 } });

    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
    });

    test.afterEach(async ({ page }) => {
        await setDrawerBarPosition(page, 'top');
    });

    test('bottom has no effect in the mobile layout', async ({ page }) => {
        await setDrawerBarPosition(page, 'bottom');
        await expect(page.locator('body')).toHaveClass(/\bdrawerBarBottom\b/);
        await expectBarAtTop(page);
    });
});
