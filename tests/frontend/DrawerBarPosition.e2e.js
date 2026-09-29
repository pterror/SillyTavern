import { test, expect } from './fixtures.js';
import { testSetup, setDrawerBarPosition, setDrawerBarMobilePosition, setStackedDrawers } from './frontent-test-utils.js';

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

/**
 * Sets a User Settings input through its own input handler, as typing into it does, and waits until it is saved.
 * @param {import('@playwright/test').Page} page
 * @param {string} selector
 * @param {string} key The power_user key the input saves.
 * @param {number} value
 */
async function setSettingInput(page, selector, key, value) {
    if (Number(await page.locator(selector).inputValue()) === value) return;
    const saved = page.waitForResponse(response => response.url().endsWith('/api/settings/save-partial')
        && response.ok()
        && (response.request().postData() ?? '').includes(key));
    await page.locator(selector).evaluate((el, v) => {
        el.value = String(v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await saved;
}

/**
 * Sets whether character info is fullscreen through its own toggle, and waits until it is saved.
 * @param {import('@playwright/test').Page} page
 * @param {boolean} on
 */
async function setCharInfoFullscreen(page, on) {
    const panel = page.locator('#char-info-panel');
    if (await panel.evaluate(el => el.classList.contains('charInfoFullscreen')) === on) return;
    const saved = page.waitForResponse(response => response.url().endsWith('/api/settings/save-partial')
        && response.ok()
        && (response.request().postData() ?? '').includes('charInfoFullscreen'));
    await page.locator('#charInfoFullscreenToggle').evaluate(el => el.click());
    await saved;
}

/**
 * The width in px of `n` ch in #sheld's font, which is what Chat Width Max caps #sheld at.
 * @param {import('@playwright/test').Page} page
 * @param {number} n
 */
function chWidthInSheld(page, n) {
    return page.locator('#sheld').evaluate((sheld, count) => {
        const probe = document.createElement('div');
        probe.style.cssText = `position: absolute; visibility: hidden; height: 0; width: ${count}ch;`;
        sheld.append(probe);
        const width = probe.getBoundingClientRect().width;
        probe.remove();
        return width;
    }, n);
}

/**
 * The part of the screen beside a bar at `side`, in px.
 * @param {'left'|'right'} side
 * @param {number} size The bar's thickness.
 */
function spaceBeside(side, size) {
    return side === 'left'
        ? { left: size, right: VIEWPORT.width, width: VIEWPORT.width - size }
        : { left: 0, right: VIEWPORT.width - size, width: VIEWPORT.width - size };
}

/**
 * Opens a top-bar drawer by its icon, waits until it has finished opening, and returns its rect.
 * @param {import('@playwright/test').Page} page
 * @param {string} iconSelector
 * @param {string} drawerSelector
 */
async function openByIcon(page, iconSelector, drawerSelector) {
    await page.locator(iconSelector).click();
    await expect(page.locator(drawerSelector)).toHaveClass(/openDrawer/);
    return openedRect(page, drawerSelector);
}

/**
 * Closes a top-bar drawer by its icon.
 * @param {import('@playwright/test').Page} page
 * @param {string} iconSelector
 * @param {string} drawerSelector
 */
async function closeByIcon(page, iconSelector, drawerSelector) {
    await page.locator(iconSelector).click();
    await expect(page.locator(drawerSelector)).not.toHaveClass(/openDrawer/);
    await expect(page.locator(drawerSelector)).toBeHidden();
}

for (const side of /** @type {const} */ (['left', 'right'])) {
    test.describe(`Drawer bar position, ${side}`, () => {
        test.use({ viewport: VIEWPORT });

        test.beforeEach(testSetup.awaitST);

        test.beforeEach(async ({ page }) => {
            await awaitAppReady(page);
            await setDrawerBarPosition(page, side);
        });

        // The data root is shared by the worker's later tests, which expect the defaults.
        test.afterEach(async ({ page }) => {
            await setForceMobileView(page, false);
            await setCharInfoFullscreen(page, false);
            await setSettingInput(page, '#chat_width_max', 'chat_width_max', 120);
            if (await page.locator('#lm_button_panel_pin').isChecked()) {
                await page.locator('#lm_button_panel_pin').evaluate(el => el.click());
            }
            await setStackedDrawers(page, false);
            await setDrawerBarPosition(page, 'top');
        });

        test(`${side}: the bar runs the full height of the ${side} screen edge, its icons centered over no more than the chat's width`, async ({ page }) => {
            const size = await barSize(page);
            const sheld = await rect(page, '#sheld');
            for (const selector of ['#top-bar', '#top-settings-holder']) {
                const bar = await rect(page, selector);
                if (side === 'left') {
                    expect(bar.left).toBeCloseTo(0, 1);
                } else {
                    expect(bar.left + bar.width).toBeCloseTo(VIEWPORT.width, 1);
                }
                expect(bar.width).toBeCloseTo(size, 1);
                expect(bar.top).toBeCloseTo(0, 1);
                expect(bar.height).toBeCloseTo(VIEWPORT.height, 1);
            }

            // The window is taller than the chat is wide, so the icons spread over exactly the chat's width.
            expect(sheld.width).toBeLessThan(VIEWPORT.height);
            const group = await page.locator('#top-settings-holder > .drawer').evaluateAll(drawers => ({
                top: drawers[0].getBoundingClientRect().top,
                bottom: drawers[drawers.length - 1].getBoundingClientRect().bottom,
            }));
            expect(group.bottom - group.top).toBeCloseTo(sheld.width, 0);
            expect((group.top + group.bottom) / 2).toBeCloseTo(VIEWPORT.height / 2, 0);

            // Nothing in the bar sticks out past the screen edge, which would let the page scroll sideways.
            expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(VIEWPORT.width);
        });

        test(`${side}: the chat starts at the top edge, centered beside the bar at Chat Width % of that space, capped by Chat Width Max`, async ({ page }) => {
            const size = await barSize(page);
            const space = spaceBeside(side, size);
            const { chat_width: chatWidth, chat_width_max: chatWidthMax } = await page.evaluate(() => window['SillyTavern'].getContext().powerUserSettings);

            const expectCentered = async (width) => {
                const sheld = await rect(page, '#sheld');
                expect(sheld.width).toBeCloseTo(width, 0);
                expect(sheld.left - space.left).toBeCloseTo(space.right - (sheld.left + sheld.width), 0);
                expect(sheld.top).toBeCloseTo(0, 1);
                expect(sheld.bottom).toBeCloseTo(VIEWPORT.height - 1, 1);
            };

            await expectCentered(Math.min(space.width * chatWidth / 100, await chWidthInSheld(page, chatWidthMax)));

            // Chat Width Max raised past the space: the chat is exactly Chat Width % of the space beside the bar.
            await setSettingInput(page, '#chat_width_max', 'chat_width_max', 500);
            await expectCentered(space.width * chatWidth / 100);

            // Lowered below it: the cap.
            await setSettingInput(page, '#chat_width_max', 'chat_width_max', 40);
            await expectCentered(await chWidthInSheld(page, 40));
        });

        test(`${side}: the sidebars are equally wide and fill the space beside the bar either side of the chat`, async ({ page }) => {
            const size = await barSize(page);
            const space = spaceBeside(side, size);
            const bar = await rect(page, '#top-bar');
            const sheld = await rect(page, '#sheld');

            const left = await openByIcon(page, '#leftNavDrawerIcon', '#left-nav-panel');
            await closeByIcon(page, '#leftNavDrawerIcon', '#left-nav-panel');
            const right = await openByIcon(page, '#charInfoDrawerIcon', '#char-info-panel');
            await closeByIcon(page, '#charInfoDrawerIcon', '#char-info-panel');

            expect(left.left).toBeCloseTo(space.left, 1);
            expect(right.left + right.width).toBeCloseTo(space.right, 1);
            // The sidebar on the bar's side starts at the bar's inner edge.
            if (side === 'left') {
                expect(left.left).toBeCloseTo(bar.left + bar.width, 1);
            } else {
                expect(right.left + right.width).toBeCloseTo(bar.left, 1);
            }
            expect(left.width).toBeCloseTo(right.width, 1);
            expect(left.width).toBeCloseTo((space.width - sheld.width - 2) / 2, 1);
            expect(left.left + left.width).toBeCloseTo(sheld.left - 1, 1);
            expect(right.left).toBeCloseTo(sheld.left + sheld.width + 1, 1);
        });

        test(`${side}: a drawer opens from the top edge in line with the chat, and its icon opens and closes it`, async ({ page }) => {
            const sheld = await rect(page, '#sheld');
            const drawer = await openByIcon(page, '#user-settings-button .drawer-icon', '#user-settings-block');
            expect(drawer.top).toBeCloseTo(0, 1);
            expect(drawer.left).toBeCloseTo(sheld.left, 1);
            expect(drawer.width).toBeCloseTo(sheld.width, 1);
            await closeByIcon(page, '#user-settings-button .drawer-icon', '#user-settings-block');
        });

        test(`${side}: fullscreen character management fills the space beside the bar`, async ({ page }) => {
            const space = spaceBeside(side, await barSize(page));
            await expect(page.locator('#right-nav-panel')).toHaveClass(/galleryFullscreen/);
            const panel = await openByIcon(page, '#rightNavDrawerIcon', '#right-nav-panel');
            expect(panel.left).toBeCloseTo(space.left, 1);
            expect(panel.width).toBeCloseTo(space.width, 1);
            expect(panel.top).toBeCloseTo(0, 1);
            expect(panel.bottom).toBeCloseTo(VIEWPORT.height, 1);
            await closeByIcon(page, '#rightNavDrawerIcon', '#right-nav-panel');
        });

        test(`${side}: fullscreen character info fills the space beside the bar when Chat Width Max is wider, and covers the sidebars only when it reaches them`, async ({ page }) => {
            const space = spaceBeside(side, await barSize(page));
            await setStackedDrawers(page, true);
            await setCharInfoFullscreen(page, true);
            await openByIcon(page, '#leftNavDrawerIcon', '#left-nav-panel');
            await page.locator('#lm_button_panel_pin').evaluate(el => el.click());
            await expect(page.locator('#lm_button_panel_pin')).toBeChecked();

            await setSettingInput(page, '#chat_width_max', 'chat_width_max', 500);
            let panel = await openByIcon(page, '#charInfoDrawerIcon', '#char-info-panel');
            expect(panel.left).toBeCloseTo(space.left, 1);
            expect(panel.width).toBeCloseTo(space.width, 1);
            expect(panel.top).toBeCloseTo(0, 1);
            expect(panel.bottom).toBeCloseTo(VIEWPORT.height, 1);
            await expect(page.locator('#char-info-panel')).toHaveAttribute('data-drawer-zones', 'left center right');
            await expect(page.locator('#left-nav-panel')).toBeHidden();
            await expect(page.locator('#left-nav-panel')).toHaveClass(/openDrawer/);

            // Capped well below the chat's Chat Width %: the panel is centered beside the bar, off the sidebars, and the
            // pinned sidebar shows again.
            await setSettingInput(page, '#chat_width_max', 'chat_width_max', 40);
            await expect(page.locator('#char-info-panel')).toHaveAttribute('data-drawer-zones', 'center');
            await expect(page.locator('#left-nav-panel')).toBeVisible();
            panel = await rect(page, '#char-info-panel');
            expect(panel.left - space.left).toBeCloseTo(space.right - (panel.left + panel.width), 0);
        });

        test(`${side} survives a reload`, async ({ page }) => {
            await page.reload();
            await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
            const bodyClass = side === 'left' ? 'drawerBarLeft' : 'drawerBarRight';
            await expect(page.locator('body')).toHaveClass(new RegExp(`\\b${bodyClass}\\b`));
            await expect(page.locator('#drawer_bar_position')).toHaveValue(side);
            const bar = await rect(page, '#top-settings-holder');
            expect(side === 'left' ? bar.left : bar.left + bar.width).toBeCloseTo(side === 'left' ? 0 : VIEWPORT.width, 1);
            expect(bar.height).toBeCloseTo(VIEWPORT.height, 1);
        });

        test(`${side} has no effect with Force Mobile View`, async ({ page }) => {
            await setForceMobileView(page, true);
            await expect(page.locator('body')).toHaveClass(new RegExp(`\\bdrawerBar${side === 'left' ? 'Left' : 'Right'}\\b`));
            await expectBarAtTop(page);
        });
    });
}

const MOBILE_VIEWPORT = { width: 412, height: 915 };

/**
 * An element's corner radii in px: top left, top right, bottom right, bottom left.
 * @param {import('@playwright/test').Page} page
 * @param {string} selector
 */
function cornerRadii(page, selector) {
    return page.locator(selector).evaluate(el => {
        const style = getComputedStyle(el);
        return [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius]
            .map(radius => parseFloat(radius));
    });
}

/** The mobile bar at the bottom edge, the full window width, and the chat from the top edge to the bar. */
async function expectMobileBarAtBottom(page, viewport) {
    const size = await barSize(page);
    const holder = await rect(page, '#top-settings-holder');
    const bar = await rect(page, '#top-bar');
    for (const r of [holder, bar]) {
        expect(r.bottom).toBeCloseTo(viewport.height, 1);
        expect(r.left).toBeCloseTo(0, 1);
        expect(r.width).toBeCloseTo(viewport.width, 1);
    }
    expect(holder.height).toBeCloseTo(size, 1);
    const sheld = await rect(page, '#sheld');
    expect(sheld.top).toBeCloseTo(0, 1);
    expect(sheld.bottom).toBeLessThanOrEqual(holder.top);
    expect(sheld.width).toBeCloseTo(viewport.width, 1);
}

/**
 * With the mobile bar at the bottom: User Settings and the character management and AI Response Configuration panels
 * open from the top edge, end at or above the bar, the panels rounded at the top, and their icons open and close them.
 */
async function expectMobileBottomDrawers(page) {
    const holder = await rect(page, '#top-settings-holder');

    const drawer = await openByIcon(page, '#user-settings-button .drawer-icon', '#user-settings-block');
    expect(drawer.top).toBeCloseTo(0, 1);
    expect(drawer.bottom).toBeLessThanOrEqual(holder.top + 0.5);
    await closeByIcon(page, '#user-settings-button .drawer-icon', '#user-settings-block');

    for (const [icon, selector] of [['#rightNavDrawerIcon', '#right-nav-panel'], ['#leftNavDrawerIcon', '#left-nav-panel']]) {
        const panel = await openByIcon(page, icon, selector);
        expect(panel.top).toBeCloseTo(0, 1);
        expect(panel.bottom).toBeLessThanOrEqual(holder.top + 0.5);
        expect(await cornerRadii(page, selector)).toEqual([20, 20, 0, 0]);
        await closeByIcon(page, icon, selector);
    }
}

test.describe('Drawer bar position, mobile', () => {
    test.use({ viewport: MOBILE_VIEWPORT });

    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
    });

    // The data root is shared by the worker's later tests, which expect the defaults.
    test.afterEach(async ({ page }) => {
        await setDrawerBarMobilePosition(page, 'top');
        await setDrawerBarPosition(page, 'top');
    });

    for (const [position, bodyClass] of [['bottom', 'drawerBarBottom'], ['left', 'drawerBarLeft'], ['right', 'drawerBarRight']]) {
        test(`${position} has no effect in the mobile layout`, async ({ page }) => {
            await setDrawerBarPosition(page, position);
            await expect(page.locator('body')).toHaveClass(new RegExp(`\\b${bodyClass}\\b`));
            await expectBarAtTop(page);
        });
    }

    test('mobile top: the bar at the top edge, the full window width, drawers and panels below it, panels rounded at the bottom', async ({ page }) => {
        await setDrawerBarMobilePosition(page, 'top');
        const size = await barSize(page);
        await expectBarAtTop(page);
        for (const selector of ['#top-settings-holder', '#top-bar']) {
            const bar = await rect(page, selector);
            expect(bar.left).toBeCloseTo(0, 1);
            expect(bar.width).toBeCloseTo(MOBILE_VIEWPORT.width, 1);
        }
        expect((await rect(page, '#sheld')).bottom).toBeCloseTo(MOBILE_VIEWPORT.height - 1, 1);

        const drawer = await openByIcon(page, '#user-settings-button .drawer-icon', '#user-settings-block');
        expect(drawer.top).toBeCloseTo(size, 1);
        await closeByIcon(page, '#user-settings-button .drawer-icon', '#user-settings-block');

        for (const [icon, selector] of [['#rightNavDrawerIcon', '#right-nav-panel'], ['#leftNavDrawerIcon', '#left-nav-panel']]) {
            const panel = await openByIcon(page, icon, selector);
            expect(panel.top).toBeCloseTo(size, 1);
            expect(await cornerRadii(page, selector)).toEqual([0, 0, 20, 20]);
            await closeByIcon(page, icon, selector);
        }
    });

    test('mobile bottom: the bar at the bottom edge, the full window width, the chat from the top edge to the bar', async ({ page }) => {
        await setDrawerBarMobilePosition(page, 'bottom');
        await expect(page.locator('body')).toHaveClass(/\bdrawerBarMobileBottom\b/);
        await expectMobileBarAtBottom(page, MOBILE_VIEWPORT);
    });

    test('mobile bottom: drawers and panels open from the top edge down to the bar, panels rounded at the top, by their icons', async ({ page }) => {
        await setDrawerBarMobilePosition(page, 'bottom');
        await expect(page.locator('body')).toHaveClass(/\bdrawerBarMobileBottom\b/);
        await expectMobileBottomDrawers(page);
    });

    for (const position of ['bottom', 'left', 'right']) {
        test(`mobile bottom with the desktop bar at the ${position}: only the mobile setting applies`, async ({ page }) => {
            await setDrawerBarPosition(page, position);
            await setDrawerBarMobilePosition(page, 'bottom');
            await expect(page.locator('body')).toHaveClass(/\bdrawerBarMobileBottom\b/);
            await expectMobileBarAtBottom(page, MOBILE_VIEWPORT);
        });
    }

    test('mobile bottom survives a reload', async ({ page }) => {
        await setDrawerBarMobilePosition(page, 'bottom');
        await page.reload();
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
        await expect(page.locator('body')).toHaveClass(/\bdrawerBarMobileBottom\b/);
        await expect(page.locator('#drawer_bar_position_mobile')).toHaveValue('bottom');
        await expectMobileBarAtBottom(page, MOBILE_VIEWPORT);
    });
});

test.describe('Drawer bar position, mobile setting on a wide window', () => {
    test.use({ viewport: VIEWPORT });

    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
    });

    // The data root is shared by the worker's later tests, which expect the defaults.
    test.afterEach(async ({ page }) => {
        await setForceMobileView(page, false);
        await setDrawerBarMobilePosition(page, 'top');
        await setDrawerBarPosition(page, 'top');
    });

    test('mobile bottom with Force Mobile View: the bar at the bottom edge, drawers and panels from the top edge down to it', async ({ page }) => {
        await setDrawerBarMobilePosition(page, 'bottom');
        await setForceMobileView(page, true);
        await expectMobileBarAtBottom(page, VIEWPORT);
        await expectMobileBottomDrawers(page);
        await expect(page.locator('body')).toHaveClass(/\bdrawerBarMobileBottom\b/);
    });

    test('mobile bottom with Force Mobile View and the desktop bar at the left: only the mobile setting applies', async ({ page }) => {
        await setDrawerBarPosition(page, 'left');
        await setDrawerBarMobilePosition(page, 'bottom');
        await setForceMobileView(page, true);
        await expect(page.locator('body')).toHaveClass(/\bdrawerBarMobileBottom\b/);
        await expectMobileBarAtBottom(page, VIEWPORT);
    });

    test('mobile bottom has no effect on desktop', async ({ page }) => {
        await setDrawerBarMobilePosition(page, 'bottom');
        await expectBarAtTop(page);
        const holder = await rect(page, '#top-settings-holder');
        const sheld = await rect(page, '#sheld');
        expect(holder.left).toBeCloseTo(sheld.left, 1);
        expect(holder.width).toBeCloseTo(sheld.width, 1);
    });

    test('mobile bottom has no effect on desktop with the desktop bar at the left', async ({ page }) => {
        await setDrawerBarPosition(page, 'left');
        await setDrawerBarMobilePosition(page, 'bottom');
        const size = await barSize(page);
        for (const selector of ['#top-bar', '#top-settings-holder']) {
            const bar = await rect(page, selector);
            expect(bar.left).toBeCloseTo(0, 1);
            expect(bar.width).toBeCloseTo(size, 1);
            expect(bar.top).toBeCloseTo(0, 1);
            expect(bar.height).toBeCloseTo(VIEWPORT.height, 1);
        }
        expect((await rect(page, '#sheld')).top).toBeCloseTo(0, 1);
    });
});

/**
 * Sets Visual Novel Mode through its own checkbox, and waits until it is saved.
 * @param {import('@playwright/test').Page} page
 * @param {boolean} on
 */
async function setVisualNovelMode(page, on) {
    const checkbox = page.locator('#waifuMode');
    if (await checkbox.isChecked() === on) return;
    const saved = page.waitForResponse(response => response.url().endsWith('/api/settings/save-partial')
        && response.ok()
        && (response.request().postData() ?? '').includes('waifuMode'));
    await checkbox.evaluate(el => el.click());
    await saved;
    await page.waitForFunction(expected => document.body.classList.contains('waifuMode') === expected, on);
}

/**
 * Shows an expression sprite the way the expressions extension does: a character's in #expression-wrapper, or with
 * `group` a group member's, a copy of #expression-holder in #visual-novel-wrapper (Visual Novel Mode in a group chat).
 * @param {import('@playwright/test').Page} page
 * @param {boolean} group
 * @returns {Promise<string>} The sprite's selector.
 */
async function showSprite(page, group) {
    await page.evaluate(inGroup => {
        const wrapper = document.getElementById('expression-wrapper');
        const vnWrapper = document.getElementById('visual-novel-wrapper');
        const holder = document.getElementById('expression-holder');
        if (!inGroup) {
            vnWrapper.style.display = 'none';
            wrapper.style.display = '';
            holder.style.display = '';
            return;
        }
        wrapper.style.display = 'none';
        vnWrapper.style.display = '';
        const member = /** @type {HTMLElement} */ (holder.cloneNode(true));
        member.id = 'expression-e2e-member.png';
        member.dataset.avatar = 'e2e-member.png';
        member.style.display = '';
        member.style.left = '0px';
        vnWrapper.append(member);
    }, group);
    return group ? '#visual-novel-wrapper .expression-holder' : '#expression-holder';
}

/** Hides the sprites {@link showSprite} showed. */
function hideSprites(page) {
    return page.evaluate(() => {
        document.getElementById('visual-novel-wrapper').replaceChildren();
        document.getElementById('visual-novel-wrapper').style.display = 'none';
        document.getElementById('expression-wrapper').style.display = '';
        document.getElementById('expression-holder').style.display = 'none';
    });
}

// `before`: the sprite's rect with the bar at the top, measured with the CSS before the sprite followed the bar.
const SPRITE_CASES = /** @type {const} */ ([
    { name: 'a character\'s sprite', vnMode: false, group: false, before: { top: 800, bottom: 900, left: 0, width: 350, height: 100 } },
    { name: 'a character\'s sprite in Visual Novel Mode', vnMode: true, group: false, before: { top: 90, bottom: 900, left: 650, width: 100, height: 810 } },
    { name: 'a group member\'s sprite in Visual Novel Mode', vnMode: true, group: true, before: { top: 90, bottom: 900, left: 0, width: 100, height: 810 } },
]);

/** Expects `actual` to be `expected` in every edge and size, to 0.05px. */
function expectSameRect(actual, expected) {
    for (const key of /** @type {const} */ (['top', 'bottom', 'left', 'width', 'height'])) {
        expect(actual[key], key).toBeCloseTo(expected[key], 1);
    }
}

test.describe('Drawer bar position, expression sprite', () => {
    test.use({ viewport: VIEWPORT });

    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
    });

    // The data root is shared by the worker's later tests, which expect the defaults.
    test.afterEach(async ({ page }) => {
        await hideSprites(page);
        await setVisualNovelMode(page, false);
        await setDrawerBarPosition(page, 'top');
    });

    for (const { name, vnMode, group, before } of SPRITE_CASES) {
        test(`top: ${name} sits where it did before, at the bottom edge`, async ({ page }) => {
            await setVisualNovelMode(page, vnMode);
            const sprite = await rect(page, await showSprite(page, group));
            expectSameRect(sprite, before);
            expect(sprite.bottom).toBeCloseTo(VIEWPORT.height, 1);
        });

        test(`bottom: ${name} ends at or above the bar`, async ({ page }) => {
            await setDrawerBarPosition(page, 'bottom');
            await setVisualNovelMode(page, vnMode);
            const sprite = await rect(page, await showSprite(page, group));
            const holder = await rect(page, '#top-settings-holder');
            expect(sprite.height).toBeGreaterThan(0);
            expect(sprite.bottom).toBeLessThanOrEqual(holder.top + 0.5);
            expect(sprite.bottom).toBeCloseTo(holder.top, 0);
        });
    }
});

test.describe('Drawer bar position, mobile, expression sprite', () => {
    test.use({ viewport: MOBILE_VIEWPORT });

    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
    });

    // The data root is shared by the worker's later tests, which expect the defaults.
    test.afterEach(async ({ page }) => {
        await hideSprites(page);
        await setVisualNovelMode(page, false);
        await setDrawerBarMobilePosition(page, 'top');
    });

    test('mobile top: in Visual Novel Mode the sprite sits where it did before, at the bottom edge', async ({ page }) => {
        await setVisualNovelMode(page, true);
        const sprite = await rect(page, await showSprite(page, false));
        // Measured with the CSS before the sprite followed the bar.
        expectSameRect(sprite, { top: 91.5, bottom: 915, left: 156, width: 100, height: 823.5 });
        expect(sprite.bottom).toBeCloseTo(MOBILE_VIEWPORT.height, 1);
    });

    test('mobile bottom: in Visual Novel Mode the sprite ends at or above the bar', async ({ page }) => {
        await setDrawerBarMobilePosition(page, 'bottom');
        await setVisualNovelMode(page, true);
        const sprite = await rect(page, await showSprite(page, false));
        const holder = await rect(page, '#top-settings-holder');
        expect(sprite.height).toBeGreaterThan(0);
        expect(sprite.bottom).toBeLessThanOrEqual(holder.top + 0.5);
        expect(sprite.bottom).toBeCloseTo(holder.top, 0);
    });

    for (const position of ['top', 'bottom']) {
        test(`mobile ${position}: without Visual Novel Mode the sprite is not shown`, async ({ page }) => {
            await setDrawerBarMobilePosition(page, position);
            await setVisualNovelMode(page, false);
            await expect(page.locator(await showSprite(page, false))).toBeHidden();
        });
    }
});

/** The rects of the bar, the holder and the chat, and the chat's padding-bottom. */
async function barLayout(page) {
    return {
        bar: await rect(page, '#top-bar'),
        holder: await rect(page, '#top-settings-holder'),
        sheld: await rect(page, '#sheld'),
        sheldPaddingBottom: await page.locator('#sheld').evaluate(el => getComputedStyle(el).paddingBottom),
    };
}

/** Sets body.PWA, as script.js does when the page runs as a home-screen app. */
function setPwa(page, on) {
    return page.evaluate(value => document.body.classList.toggle('PWA', value), on);
}

// The home-indicator safe area moves from #sheld to a bottom bar only in the iOS-only CSS, which Chromium doesn't
// apply: here a home-screen app lays out exactly as the page does in a browser tab.
for (const [layout, viewport, setPosition] of /** @type {const} */ ([
    ['desktop', VIEWPORT, setDrawerBarPosition],
    ['mobile', MOBILE_VIEWPORT, setDrawerBarMobilePosition],
])) {
    test.describe(`Drawer bar position, ${layout}, home-screen app outside iOS`, () => {
        test.use({ viewport });

        test.beforeEach(testSetup.awaitST);

        test.beforeEach(async ({ page }) => {
            await awaitAppReady(page);
        });

        // The data root is shared by the worker's later tests, which expect the defaults.
        test.afterEach(async ({ page }) => {
            await setPwa(page, false);
            await setPosition(page, 'top');
        });

        for (const position of ['top', 'bottom']) {
            test(`${layout} ${position}: the bar, its icons and the chat are where they are in a browser tab`, async ({ page }) => {
                await setPosition(page, position);
                const inTab = await barLayout(page);
                await setPwa(page, true);
                const inApp = await barLayout(page);
                for (const key of /** @type {const} */ (['bar', 'holder', 'sheld'])) {
                    expectSameRect(inApp[key], inTab[key]);
                }
                expect(inApp.sheldPaddingBottom).toBe(inTab.sheldPaddingBottom);
            });
        }
    });
}

/**
 * Serves mobile-styles.css with its iOS-only block applying, as on iOS: Chromium doesn't match its condition,
 * `@supports (-webkit-touch-callout: none)`. Takes effect from the next page load.
 * @param {import('@playwright/test').Page} page
 */
function forceIosCss(page) {
    return page.route('**/css/mobile-styles.css', async route => {
        const response = await route.fetch();
        const css = (await response.text()).replace('@supports (-webkit-touch-callout: none)', '@supports (display: block)');
        await route.fulfill({ response, body: css });
    });
}

/** Whether the iOS-only CSS applies (it alone sets --pwaSafeAreaBottom). */
function iosCssApplies(page) {
    return page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pwaSafeAreaBottom') !== '');
}

async function reloadST(page) {
    await page.reload();
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
    await awaitAppReady(page);
}

/** The drawers {@link iosLayout} opens, by their icons. */
const IOS_DRAWERS = /** @type {const} */ ([
    ['#user-settings-button .drawer-icon', '#user-settings-block'],
    ['#leftNavDrawerIcon', '#left-nav-panel'],
    ['#charInfoDrawerIcon', '#char-info-panel'],
    ['#rightNavDrawerIcon', '#right-nav-panel'],
]);

/**
 * The rects of the bar, the holder, the chat, and of User Settings, both sidebars and character management, each
 * opened and closed again by its icon.
 * @param {import('@playwright/test').Page} page
 * @param {boolean} pointer Whether to click the icons with the pointer. On iOS with the bar at the top an opened
 * sidebar covers the bar, so there the icons are clicked by script.
 */
async function iosLayout(page, pointer) {
    const layout = {};
    for (const selector of ['#top-bar', '#top-settings-holder', '#sheld']) {
        layout[selector] = await rect(page, selector);
    }
    for (const [icon, drawer] of IOS_DRAWERS) {
        if (pointer) {
            layout[drawer] = await openByIcon(page, icon, drawer);
            await closeByIcon(page, icon, drawer);
            continue;
        }
        await page.locator(icon).evaluate(el => el.click());
        await expect(page.locator(drawer)).toHaveClass(/openDrawer/);
        layout[drawer] = await openedRect(page, drawer);
        await page.locator(icon).evaluate(el => el.click());
        await expect(page.locator(drawer)).toBeHidden();
    }
    return layout;
}

/** Expects each rect in `actual` to be the same one in `expected`. */
function expectSameLayout(actual, expected) {
    expect(Object.keys(actual)).toEqual(Object.keys(expected));
    for (const [selector, r] of Object.entries(expected)) {
        for (const key of /** @type {const} */ (['top', 'bottom', 'left', 'width', 'height'])) {
            expect(actual[selector][key], `${selector} ${key}`).toBeCloseTo(r[key], 1);
        }
    }
}

const IPAD_VIEWPORT = { width: 1180, height: 820 };

// Measured with the iOS-only CSS before it followed the Drawer Bar setting.
const IOS_BEFORE = {
    desktopTop: {
        '#top-bar': { top: 0, bottom: 34.5, left: 0, width: 1180, height: 34.5 },
        '#top-settings-holder': { top: 0, bottom: 35, left: 295, width: 590, height: 35 },
        '#sheld': { top: 35, bottom: 819, left: 0, width: 1180, height: 784 },
        '#user-settings-block': { top: 36, bottom: 786, left: 295, width: 1175, height: 750 },
        '#left-nav-panel': { top: 0, bottom: 750, left: 2.5, width: 1175, height: 750 },
        '#char-info-panel': { top: 36, bottom: 786, left: 2.5, width: 1175, height: 750 },
        '#right-nav-panel': { top: 35, bottom: 820, left: 0, width: 1180, height: 785 },
    },
    forceMobileViewTop: {
        '#top-bar': { top: 0, bottom: 34.5, left: 0, width: 1180, height: 34.5 },
        '#top-settings-holder': { top: 0, bottom: 35, left: 0, width: 1180, height: 35 },
        '#sheld': { top: 35, bottom: 819, left: 0, width: 1180, height: 784 },
        '#user-settings-block': { top: 35, bottom: 810, left: 0, width: 1180, height: 775 },
        '#left-nav-panel': { top: 35, bottom: 785, left: 0, width: 1180, height: 750 },
        '#char-info-panel': { top: 35, bottom: 810, left: 0, width: 1180, height: 775 },
        '#right-nav-panel': { top: 35, bottom: 820, left: 0, width: 1180, height: 785 },
    },
    mobileTop: {
        '#top-bar': { top: 0, bottom: 34.5, left: 0, width: 412, height: 34.5 },
        '#top-settings-holder': { top: 0, bottom: 35, left: 0, width: 412, height: 35 },
        '#sheld': { top: 35, bottom: 914, left: 0, width: 412, height: 879 },
        '#user-settings-block': { top: 36, bottom: 881, left: 2.5, width: 407, height: 845 },
        '#left-nav-panel': { top: 35, bottom: 880, left: 0, width: 412, height: 845 },
        '#char-info-panel': { top: 71, bottom: 916, left: 0, width: 412, height: 845 },
        '#right-nav-panel': { top: 35, bottom: 915, left: 0, width: 412, height: 880 },
    },
    mobileBottom: {
        '#top-bar': { top: 880.5, bottom: 915, left: 0, width: 412, height: 34.5 },
        '#top-settings-holder': { top: 880, bottom: 915, left: 0, width: 412, height: 35 },
        '#sheld': { top: 0, bottom: 880, left: 0, width: 412, height: 880 },
        '#user-settings-block': { top: 0, bottom: 846, left: 2.5, width: 407, height: 846 },
        '#left-nav-panel': { top: 0, bottom: 846, left: 0, width: 412, height: 846 },
        '#char-info-panel': { top: 0, bottom: 846, left: 0, width: 412, height: 846 },
        '#right-nav-panel': { top: 0, bottom: 880, left: 0, width: 412, height: 880 },
    },
};

/**
 * Expects each of the chat and the drawers in `layout` to be on screen, from the top edge, and clear of a bar at
 * `position`.
 * @param {Record<string, { top: number, bottom: number, left: number, width: number, height: number }>} layout
 * @param {'bottom'|'left'|'right'} position
 */
function expectClearOfBar(layout, position) {
    const bar = layout['#top-settings-holder'];
    for (const selector of ['#sheld', ...IOS_DRAWERS.map(([, drawer]) => drawer)]) {
        const r = layout[selector];
        expect(r.height, selector).toBeGreaterThan(0);
        expect(r.top, selector).toBeCloseTo(0, 1);
        expect(r.left, selector).toBeGreaterThanOrEqual(0);
        expect(r.left + r.width, selector).toBeLessThanOrEqual(IPAD_VIEWPORT.width + 0.5);
        expect(r.bottom, selector).toBeLessThanOrEqual(IPAD_VIEWPORT.height + 0.5);
        if (position === 'bottom') expect(r.bottom, selector).toBeLessThanOrEqual(bar.top + 0.5);
        if (position === 'left') expect(r.left, selector).toBeGreaterThanOrEqual(bar.left + bar.width - 0.5);
        if (position === 'right') expect(r.left + r.width, selector).toBeLessThanOrEqual(bar.left + 0.5);
    }
}

test.describe('Drawer bar position, iOS, desktop layout', () => {
    test.use({ viewport: IPAD_VIEWPORT });

    test.beforeEach(async ({ page }) => {
        await forceIosCss(page);
    });

    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
        expect(await iosCssApplies(page)).toBe(true);
    });

    // The data root is shared by the worker's later tests, which expect the defaults.
    test.afterEach(async ({ page }) => {
        await setPwa(page, false);
        await setForceMobileView(page, false);
        await setDrawerBarPosition(page, 'top');
    });

    test('top: the bar, the chat, User Settings, the sidebars and character management are where they were', async ({ page }) => {
        await setDrawerBarPosition(page, 'top');
        expectSameLayout(await iosLayout(page, false), IOS_BEFORE.desktopTop);
    });

    for (const position of /** @type {const} */ (['bottom', 'left', 'right'])) {
        test(`${position}: the bar, the chat, User Settings, the sidebars and character management are where they are outside iOS`, async ({ page }) => {
            await setDrawerBarPosition(page, position);
            const onIos = await iosLayout(page, true);
            expectClearOfBar(onIos, position);

            await page.unroute('**/css/mobile-styles.css');
            await reloadST(page);
            expect(await iosCssApplies(page)).toBe(false);
            expectSameLayout(onIos, await iosLayout(page, true));
        });
    }

    for (const position of /** @type {const} */ (['top', 'left', 'right'])) {
        test(`${position}, home-screen app: the chat keeps its bottom padding clear of the home indicator, in the same place`, async ({ page }) => {
            await setDrawerBarPosition(page, position);
            const inTab = await barLayout(page);
            await setPwa(page, true);
            const inApp = await barLayout(page);
            for (const key of /** @type {const} */ (['bar', 'holder', 'sheld'])) {
                expectSameRect(inApp[key], inTab[key]);
            }
            expect(inApp.sheldPaddingBottom).toBe('15px');
        });
    }

    test('bottom, home-screen app: the bar keeps clear of the home indicator, the chat and User Settings end at the bar', async ({ page }) => {
        await setDrawerBarPosition(page, 'bottom');
        const inTab = await barLayout(page);
        await setPwa(page, true);
        const { bar, holder, sheld, sheldPaddingBottom } = await barLayout(page);
        // --pwaSafeAreaBottom is 15px where there is no safe area.
        expect(bar.bottom).toBeCloseTo(IPAD_VIEWPORT.height, 1);
        expect(bar.height).toBeCloseTo(inTab.bar.height + 15, 1);
        expect(holder.bottom).toBeCloseTo(IPAD_VIEWPORT.height - 15, 1);
        expect(holder.left).toBeCloseTo(inTab.holder.left, 1);
        expect(holder.width).toBeCloseTo(inTab.holder.width, 1);
        expect(sheld.top).toBeCloseTo(0, 1);
        expect(sheld.bottom).toBeCloseTo(holder.top - 1, 1);
        expect(sheldPaddingBottom).toBe('0px');
        const drawer = await openByIcon(page, '#user-settings-button .drawer-icon', '#user-settings-block');
        expect(drawer.top).toBeCloseTo(0, 1);
        expect(drawer.bottom).toBeLessThanOrEqual(holder.top + 0.5);
        await closeByIcon(page, '#user-settings-button .drawer-icon', '#user-settings-block');
    });

    test('Force Mobile View: the Drawer Bar at the bottom, left or right leaves the layout where it was with the bar at the top', async ({ page }) => {
        await setForceMobileView(page, true);
        for (const position of ['top', 'bottom', 'left', 'right']) {
            await setDrawerBarPosition(page, position);
            await test.step(position, async () => {
                expectSameLayout(await iosLayout(page, false), IOS_BEFORE.forceMobileViewTop);
            });
        }
    });
});

test.describe('Drawer bar position, iOS, mobile layout', () => {
    test.use({ viewport: MOBILE_VIEWPORT });

    test.beforeEach(async ({ page }) => {
        await forceIosCss(page);
    });

    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
        expect(await iosCssApplies(page)).toBe(true);
    });

    // The data root is shared by the worker's later tests, which expect the defaults.
    test.afterEach(async ({ page }) => {
        await setDrawerBarMobilePosition(page, 'top');
        await setDrawerBarPosition(page, 'top');
    });

    for (const [mobilePosition, before] of /** @type {const} */ ([['top', IOS_BEFORE.mobileTop], ['bottom', IOS_BEFORE.mobileBottom]])) {
        test(`mobile ${mobilePosition}: the bar, the chat, User Settings and the panels are where they were, whatever the desktop Drawer Bar`, async ({ page }) => {
            await setDrawerBarMobilePosition(page, mobilePosition);
            for (const position of ['top', 'bottom', 'left', 'right']) {
                await setDrawerBarPosition(page, position);
                await test.step(position, async () => {
                    expectSameLayout(await iosLayout(page, false), before);
                });
            }
        });
    }
});
