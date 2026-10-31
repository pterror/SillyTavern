import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, setStackedDrawers } from './frontent-test-utils.js';

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
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 * @returns {Promise<number>}
 */
function pointsHitting(page, id) {
    return page.evaluate((id) => {
        const layer = document.getElementById(id);
        let hits = 0;
        for (let x = 5; x < innerWidth; x += 20) {
            for (let y = 40; y < innerHeight; y += 20) {
                if (layer.contains(document.elementFromPoint(x, y))) hits++;
            }
        }
        return hits;
    }, id);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 * @returns {Promise<string[]>}
 */
function layersUnder(page, id) {
    return page.evaluate((id) => {
        const top = document.getElementById(id);
        const box = top.getBoundingClientRect();
        const stack = document.elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        if (!top.contains(stack[0])) return [`not on top: ${stack[0]?.id || stack[0]?.className}`];
        return [...new Set(stack.map(el => el.closest('#sheld, .drawer-content')).filter(el => el && el !== top).map(el => el.id))];
    }, id);
}

for (const { layout, width, height } of [
    { layout: 'desktop', width: 1400, height: 900 },
    { layout: 'mobile', width: 450, height: 850 },
]) {
    test.describe(`${layout}`, () => {
        test.beforeEach(async ({ page }) => {
            await page.setViewportSize({ width, height });
            await loadApp(page);
            await setStackedDrawers(page, true);
        });

        test('picking a character from character management hides it as the chat icon does', async ({ page }) => {
            await openCharacterManagementDrawer(page);
            await page.locator('#rm_print_characters_block .character_select').first().click();
            await expect(page.locator('#chatDrawerIcon')).toHaveClass(/stackFront/);
            await page.waitForTimeout(600);
            expect(await pointsHitting(page, 'right-nav-panel')).toBe(0);

            await page.locator('#rightNavDrawerIcon').click();
            await page.locator('#chatDrawerIcon').click();
            await page.waitForTimeout(600);
            expect(await pointsHitting(page, 'right-nav-panel')).toBe(0);
        });

        test('a drawer outside the drawer bar (the prompt manager popup) occludes the chat under it', async ({ page }) => {
            await page.locator('#chatDrawerIcon').click();
            await page.evaluate(() => {
                document.getElementById('completion_prompt_manager_popup_inspect').style.display = 'flex';
                window['$']('#completion_prompt_manager_popup').slideDown(200, 'swing').addClass('openDrawer');
            });
            await page.waitForTimeout(600);
            expect(await layersUnder(page, 'completion_prompt_manager_popup')).toEqual([]);
        });

        test('a drawer an extension adds anywhere and opens itself occludes the chat under it', async ({ page }) => {
            await page.locator('#chatDrawerIcon').click();
            await page.evaluate(() => {
                const drawer = document.createElement('div');
                drawer.id = 'extensionDrawer';
                drawer.className = 'drawer-content closedDrawer';
                drawer.style.cssText = 'position:fixed;left:0;right:0;top:100px;height:300px;margin:0 auto;z-index:3500';
                drawer.textContent = 'extension drawer';
                document.getElementById('sheld').before(drawer);
                drawer.classList.replace('closedDrawer', 'openDrawer');
            });
            await page.waitForTimeout(600);
            expect(await layersUnder(page, 'extensionDrawer')).toEqual([]);
        });
    });
}
