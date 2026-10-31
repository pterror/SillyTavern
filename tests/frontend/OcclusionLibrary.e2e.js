import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string[]} policies
 */
async function sandbox(page, policies = []) {
    await page.evaluate(async (policies) => {
        const lib = await import('/ui/entry.js');
        const root = document.createElement('div');
        root.id = 'occlusionRoot';
        root.style.cssText = 'position:fixed;inset:0;z-index:100000;pointer-events:none';
        const win = (id, css) => {
            const el = document.createElement('div');
            el.id = id;
            el.style.cssText = `position:absolute;background:rgba(0,0,0,0.3);${css}`;
            root.append(el);
            return el;
        };
        const a = win('winA', 'left:100px;top:100px;width:300px;height:200px');
        const b = win('winB', 'left:300px;top:150px;width:200px;height:100px;border-radius:10px');
        const order = new Map([[a, 1], [b, 2]]);
        document.body.append(root);
        const all = () => true;
        const made = {
            exempt: lib.exempt(all),
            squareCorners: lib.squareCorners(all),
            hideWhenCovered: lib.hideWhenCovered(all),
            hideWhenSplit: lib.hideWhenSplit(all),
        };
        window.__occlusion = lib.createOcclusion({
            root,
            stack: { members: () => [a, b], compare: (x, y) => (order.get(x) ?? 0) - (order.get(y) ?? 0) },
            policies: [lib.coversBox(el => el === a || el === b), ...policies.map(name => made[name])],
        });
        window.__order = order;
        window.__occlusion.setEnabled(true);
    }, policies);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 */
const stateOf = (page, id) => page.evaluate(id => window.__occlusion.stateOf(document.getElementById(id)), id);

test.describe('occlusion library', () => {
    test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: 1000, height: 700 });
        await testSetup.awaitST({ page });
    });

    test.afterEach(async ({ page }) => {
        await page.evaluate(() => {
            window.__occlusion?.dispose();
            document.getElementById('occlusionRoot')?.remove();
        });
    });

    test('the window behind is cut where the one in front covers it, with its rounded corners; nothing else is cut', async ({ page }) => {
        await sandbox(page);
        expect(await stateOf(page, 'winA')).toBe('cut');
        expect(await stateOf(page, 'winB')).toBe(null);
        const clip = await page.evaluate(() => document.getElementById('winA').style.clipPath);
        expect(clip).toMatch(/^polygon\(evenodd/);
        expect(clip.split(',').length).toBeGreaterThan(12);
    });

    test('the order is the stack\'s: brought forward, the other one is cut', async ({ page }) => {
        await sandbox(page);
        await page.evaluate(() => {
            window.__order.set(document.getElementById('winA'), 3);
            window.__occlusion.update();
        });
        expect(await stateOf(page, 'winA')).toBe(null);
        expect(await stateOf(page, 'winB')).toBe('cut');
    });

    test('an element added later and painting over a window cuts it, found from the mutation alone', async ({ page }) => {
        await sandbox(page);
        await page.evaluate(() => {
            const tip = document.createElement('div');
            tip.id = 'tip';
            tip.textContent = 'tip';
            tip.style.cssText = 'position:fixed;left:520px;top:120px;width:80px;height:40px;z-index:5';
            document.getElementById('winB').append(tip);
        });
        await expect.poll(() => page.evaluate(() => window.__occlusion.overlays().map(el => el.id))).toContain('tip');
        await page.evaluate(() => {
            const sticky = document.createElement('div');
            sticky.id = 'line';
            sticky.textContent = 'a line over the content';
            sticky.style.cssText = 'position:absolute;left:10px;top:10px;width:100px;height:20px';
            const content = document.createElement('div');
            content.id = 'content';
            content.style.cssText = 'height:100px;background:blue';
            const a = document.getElementById('winA');
            a.append(content, sticky);
        });
        await page.waitForTimeout(100);
        expect(await page.evaluate(() => window.__occlusion.overlays().map(el => el.id))).not.toContain('line');
        await page.evaluate(() => { Object.assign(document.getElementById('line').style, { position: 'sticky', marginTop: '-50px' }); });
        await expect.poll(() => stateOf(page, 'content')).toBe('cut');
    });

    test('exempt: never cut', async ({ page }) => {
        await sandbox(page, ['exempt']);
        expect(await stateOf(page, 'winA')).toBe(null);
    });

    test('hide when covered: hidden whole once nothing shows, and it covers nothing then', async ({ page }) => {
        await sandbox(page, ['hideWhenCovered']);
        await page.evaluate(() => {
            Object.assign(document.getElementById('winB').style, { left: '50px', top: '50px', width: '500px', height: '400px' });
        });
        await expect.poll(() => stateOf(page, 'winA')).toBe('hidden');
        expect(await page.evaluate(() => getComputedStyle(document.getElementById('winA')).visibility)).toBe('hidden');
    });

    test('hide when split: one cover leaving it in two pieces hides it whole', async ({ page }) => {
        await sandbox(page, ['hideWhenSplit']);
        expect(await stateOf(page, 'winA')).toBe('cut');
        await page.evaluate(() => {
            Object.assign(document.getElementById('winB').style, { left: '200px', top: '50px', width: '80px', height: '400px' });
        });
        await expect.poll(() => stateOf(page, 'winA')).toBe('hidden');
    });

    test('square corners: the holes keep no rounding', async ({ page }) => {
        await sandbox(page, ['squareCorners']);
        const clip = await page.evaluate(() => document.getElementById('winA').style.clipPath);
        expect(clip.split(',').length).toBeLessThanOrEqual(12);
    });

    test('turned off, everything is put back', async ({ page }) => {
        await sandbox(page, ['hideWhenCovered']);
        expect(await stateOf(page, 'winA')).toBe('cut');
        await page.evaluate(() => window.__occlusion.setEnabled(false));
        expect(await page.evaluate(() => {
            const a = document.getElementById('winA');
            return [a.style.clipPath, a.getAttribute('data-occluded')];
        })).toEqual(['', null]);
    });
});
