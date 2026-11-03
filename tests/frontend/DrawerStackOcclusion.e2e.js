import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, setStackedDrawers, stackMismatches } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/** @param {import('@playwright/test').Page} page */
async function loadApp(page) {
    await testSetup.awaitST({ page });
    await page.evaluate(() => {
        window['__appReady'] = false;
        const { eventSource, eventTypes } = window['stTest'].context();
        eventSource.once(eventTypes.APP_READY, () => { window['__appReady'] = true; });
    });
    await page.waitForFunction(() => window['__appReady'], null, { timeout: 60000 });
}

/** @param {import('@playwright/test').Page} page */
async function openAliceChat(page) {
    await openCharacterManagementDrawer(page);
    await page.locator('.character_select', { hasText: 'Alice' }).first().click();
    await expect(page.locator('#chatDrawerIcon')).toHaveClass(/stackFront/);
}

const settle = (/** @type {import('@playwright/test').Page} */ page) => page.waitForTimeout(700);

for (const { layout, width, height } of [
    { layout: 'desktop', width: 1400, height: 900 },
    { layout: 'mobile', width: 450, height: 850 },
]) {
    test.describe(`${layout}`, () => {
        test.beforeEach(async ({ page }) => {
            await page.setViewportSize({ width, height });
            await loadApp(page);
            await setStackedDrawers(page, true);
            await openAliceChat(page);
        });

        test('each top-bar drawer over the chat: each shows exactly where nothing above it covers it', async ({ page }) => {
            test.setTimeout(90000);
            const drawers = await page.evaluate(() => [...document.querySelectorAll('#top-settings-holder > .drawer:not(#chat-button)')]
                .filter(el => el.checkVisibility()).map(el => el.id));
            const wrong = {};
            for (const id of drawers) {
                await page.locator('#chatDrawerIcon').click();
                await page.locator(`#${id} > .drawer-toggle`).click();
                await settle(page);
                const mismatches = await stackMismatches(page);
                if (mismatches.length) wrong[id] = mismatches.slice(0, 3);
            }
            expect(wrong).toEqual({});
        });

        test('a drawer whose content changes its height cuts the chat to its new size', async ({ page }) => {
            await page.locator('#chatDrawerIcon').click();
            await page.locator('#sys-settings-button > .drawer-toggle').click();
            await settle(page);
            const heights = [];
            for (const api of ['kobold', 'openai', 'novel']) {
                await page.locator('#main_api').selectOption(api);
                await settle(page);
                heights.push(await page.locator('#rm_api_block').evaluate(el => el.getBoundingClientRect().height));
                expect(await stackMismatches(page)).toEqual([]);
            }
            expect(heights[1]).toBeGreaterThan(heights[0]);
            expect(heights[2]).toBeLessThan(heights[1]);
        });
    });
}

test.describe('desktop', () => {
    test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: 1400, height: 900 });
        await loadApp(page);
        await setStackedDrawers(page, true);
    });

    test('the chat shows in the rounded corners of a drawer over it, and takes clicks there', async ({ page }) => {
        await openAliceChat(page);
        await page.locator('#sys-settings-button > .drawer-toggle').click();
        await settle(page);
        const owners = await page.locator('#rm_api_block').evaluate(drawer => {
            const box = drawer.getBoundingClientRect();
            const radius = parseFloat(getComputedStyle(drawer).borderBottomLeftRadius);
            const owner = (x, y) => document.elementFromPoint(x, y)?.closest('#sheld, #rm_api_block')?.id;
            return {
                radius,
                outsideLeft: owner(box.left + 2, box.bottom - 2),
                outsideRight: owner(box.right - 2, box.bottom - 2),
                insideLeft: owner(box.left + radius / 2, box.bottom - radius / 2),
            };
        });
        expect(owners).toEqual({ radius: 10, outsideLeft: 'sheld', outsideRight: 'sheld', insideLeft: 'rm_api_block' });
    });

    test('a layer hidden whole shows none of its parts, even one still fading its own visibility', async ({ page }) => {
        await openCharacterManagementDrawer(page);
        await expect(page.locator('#right-nav-panel')).toHaveClass(/galleryFullscreen/);
        await page.locator('#right-nav-panel .right_menu_button').first().evaluate(el => { el.style.transition = 'all 10s'; });
        await page.locator('#chatDrawerIcon').click();
        await expect(page.locator('#right-nav-panel')).toHaveClass(/stackCovered/);
        const hits = await page.evaluate(() => {
            const panel = document.getElementById('right-nav-panel');
            const out = [];
            for (let x = 3; x < innerWidth; x += 7) {
                for (let y = 3; y < innerHeight; y += 7) {
                    const el = document.elementFromPoint(x, y);
                    if (panel.contains(el)) out.push(`${x},${y}: ${el.className}`);
                }
            }
            return out.slice(0, 5);
        });
        expect(hits).toEqual([]);
    });

    test('a zoomed avatar that appears over a shown drawer comes in front of it', async ({ page }) => {
        await openAliceChat(page);
        await page.locator('#rightNavDrawerIcon').click();
        await settle(page);
        await expect(page.locator('#right-nav-panel')).toHaveClass(/galleryFullscreen/);
        await expect(page.locator('#right-nav-panel')).not.toHaveClass(/stackCovered/);
        await page.locator('#chat .mes[is_user="true"] .avatar img').first().evaluate(el => el.click());
        const zoom = page.locator('body > .zoomed_avatar.draggable');
        await expect(zoom).toBeVisible();
        await settle(page);
        const front = await zoom.evaluate(el => {
            const box = el.getBoundingClientRect();
            return el.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
        });
        expect(front).toBe(true);
    });
});
