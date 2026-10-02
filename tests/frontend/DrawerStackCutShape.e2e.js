import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, setStackedDrawers } from './frontent-test-utils.js';

// A layer's cut is exactly the union of the boxes above it (with several holes, nothing between them is cut too),
// and once nothing moves, nothing is recomputed or rewritten.

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

test.describe('stacked drawers', () => {
    test('two holes cut only their own rectangles', async ({ page }) => {
        await loadApp(page);
        const hits = await page.evaluate(async () => {
            const { setHoles } = await import('./scripts/util/underlay-clip.js');
            const el = document.createElement('div');
            el.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:400px;z-index:99999;background:red';
            document.body.append(el);
            setHoles(el, 'test', [
                { top: 200, left: 50, bottom: 250, right: 100 },
                { top: 50, left: 250, bottom: 100, right: 300 },
            ]);
            await new Promise(r => requestAnimationFrame(r));
            const at = (x, y) => document.elementFromPoint(x, y) === el;
            const result = {
                inFirst: at(75, 225),
                inSecond: at(275, 75),
                // Inside the triangle between the corner and the two holes' first points, which a polygon linking
                // the holes directly would cut.
                betweenHoles: at(100, 83),
                belowFirst: at(75, 300),
                rightOfSecond: at(350, 75),
                corner: at(5, 5),
            };
            el.remove();
            return result;
        });
        expect(hits).toEqual({ inFirst: false, inSecond: false, betweenHoles: true, belowFirst: true, rightOfSecond: true, corner: true });
    });

    test('character management, then character info, then the chat: each point shows the topmost layer there', async ({ page }) => {
        await page.setViewportSize({ width: 1400, height: 900 });
        await loadApp(page);
        await setStackedDrawers(page, true);
        await openCharacterManagementDrawer(page);
        await page.locator('#rm_print_characters_block .character_select').first().click();
        await expect(page.locator('#char-info-panel')).toHaveClass(/openDrawer/);
        await page.locator('[data-stack-front-of="sheld"]').click();
        await page.waitForTimeout(600);
        const wrong = await page.evaluate(async () => {
            const { drawerOrder } = await import('./scripts/drawer-stack.js');
            const layers = [...document.querySelectorAll('#sheld, #top-settings-holder > .drawer > .drawer-content')]
                .filter(el => el.checkVisibility() && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0)
                .sort((a, b) => drawerOrder(a) - drawerOrder(b) || Number(b.id === 'sheld') - Number(a.id === 'sheld'));
            const out = [];
            for (let x = 5; x < innerWidth; x += 23) {
                for (let y = 40; y < innerHeight; y += 23) {
                    const containing = layers.filter(el => {
                        const r = el.getBoundingClientRect();
                        return x > r.left + 1 && x < r.right - 1 && y > r.top + 1 && y < r.bottom - 1;
                    });
                    const top = containing.at(-1);
                    if (!top) continue;
                    const hit = document.elementFromPoint(x, y);
                    const owner = layers.find(el => el.contains(hit));
                    // Something inside the top layer (or above every layer, like the drawer bar) is fine; a lower
                    // layer showing through is not.
                    if (owner && owner !== top) out.push(`${x},${y}: ${owner.id} instead of ${top.id}`);
                }
            }
            return out.slice(0, 10);
        });
        expect(wrong).toEqual([]);
    });

    test('once nothing moves, the stack stops: no layer is rewritten while the page is idle', async ({ page }) => {
        await page.setViewportSize({ width: 1400, height: 900 });
        await loadApp(page);
        await setStackedDrawers(page, true);
        await openCharacterManagementDrawer(page);
        await page.locator('#rm_print_characters_block .character_select').first().click();
        await expect(page.locator('#char-info-panel')).toHaveClass(/openDrawer/);
        await page.waitForTimeout(800);
        const rewrites = await page.evaluate(async () => {
            const layers = [...document.querySelectorAll('#sheld, #top-settings-holder > .drawer > .drawer-content')];
            const records = [];
            const observer = new MutationObserver(list => records.push(...list.map(m => `${m.target.id}.${m.attributeName}`)));
            for (const el of layers) observer.observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
            await new Promise(r => setTimeout(r, 500));
            observer.disconnect();
            return records;
        });
        expect(rewrites).toEqual([]);
    });
});
