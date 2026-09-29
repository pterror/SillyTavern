import { test, expect } from './fixtures.js';
import { testSetup, setDrawerBarPosition, setStackedDrawers } from './frontent-test-utils.js';

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

test.describe('Drawer bar position, mobile', () => {
    test.use({ viewport: { width: 412, height: 915 } });

    test.beforeEach(testSetup.awaitST);

    test.beforeEach(async ({ page }) => {
        await awaitAppReady(page);
    });

    test.afterEach(async ({ page }) => {
        await setDrawerBarPosition(page, 'top');
    });

    for (const [position, bodyClass] of [['bottom', 'drawerBarBottom'], ['left', 'drawerBarLeft'], ['right', 'drawerBarRight']]) {
        test(`${position} has no effect in the mobile layout`, async ({ page }) => {
            await setDrawerBarPosition(page, position);
            await expect(page.locator('body')).toHaveClass(new RegExp(`\\b${bodyClass}\\b`));
            await expectBarAtTop(page);
        });
    }
});
