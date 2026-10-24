import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

/**
 * Mounts an editor that renders with the app's markdown, as a field's preview does.
 * @param {import('@playwright/test').Page} page
 * @param {string} value
 */
async function mountRendered(page, value) {
    await page.evaluate(async (value) => {
        const registry = await import('/scripts/live-editor/registry.js');
        const { renderMarkdown } = await import('/scripts/marked-processor.js');
        const host = document.createElement('div');
        host.id = 'liveEditorTestHost';
        host.style.cssText = 'position:fixed;top:60px;left:60px;width:500px;z-index:100000;background:#000;color:#fff';
        const textarea = document.createElement('textarea');
        textarea.id = 'liveEditorTestTextarea';
        textarea.value = value;
        host.append(textarea);
        const outside = document.createElement('button');
        outside.id = 'liveEditorTestOutside';
        outside.textContent = 'outside';
        host.append(outside);
        document.body.append(host);
        const editor = await registry.mountLiveEditor(textarea, { render: renderMarkdown, contentClass: 'mes_text' });
        // @ts-ignore
        window.liveEditorTest = { editor, textarea, renderMarkdown };
    }, value);
}

test.describe('live editor rendering', () => {
    test.beforeEach(testSetup.awaitST);
    test.afterEach(async ({ page }) => {
        await page.evaluate(() => {
            // @ts-ignore
            window.liveEditorTest?.editor.destroy();
            document.getElementById('liveEditorTestHost')?.remove();
        });
    });

    test('the text is shown as written, styled as chat: the markup stays, dimmed, focused or not', async ({ page }) => {
        await mountRendered(page, '# Title\n\nSome *em* and **strong**.\n\n- a\n- b\n\n> quoted');
        const lines = page.locator('#liveEditorTestHost .cm-line');
        await expect(lines).toHaveCount(8);
        await expect(lines.nth(0)).toHaveText('# Title');
        await expect(lines.nth(0)).toHaveClass(/live-heading1/);
        await expect(page.locator('#liveEditorTestHost .cm-line em')).toHaveText('*em*');
        await expect(page.locator('#liveEditorTestHost .cm-line strong')).toHaveText('**strong**');
        const syntax = page.locator('#liveEditorTestHost .live-syntax');
        const shown = () => syntax.evaluateAll(els => els.map(el => getComputedStyle(el).display !== 'none' && Number(getComputedStyle(el).opacity) < 1));
        const unfocused = await shown();
        expect(unfocused.length).toBeGreaterThan(4);
        expect(unfocused.every(Boolean)).toBe(true);
        await page.locator('#liveEditorTestHost .cm-line').nth(2).click();
        expect(await shown()).toEqual(unfocused);
    });

    test('focusing and moving the cursor moves nothing on screen', async ({ page }) => {
        await mountRendered(page, 'First paragraph.\n\nSecond with *em* here.\nNext line **b**.\n\n1. one\n2. two');
        const tops = () => page.locator('#liveEditorTestHost .cm-line').evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().top)));
        const before = await tops();
        for (const n of [0, 2, 3, 5]) {
            await page.locator('#liveEditorTestHost .cm-line').nth(n).click();
            expect(await tops()).toEqual(before);
        }
    });

    test('a click puts the cursor where it lands in the text', async ({ page }) => {
        const text = '1. first item\n2. second item with the target word\n> quoted *target* too\nHello **there**, the target again';
        await mountRendered(page, text);
        const points = await page.evaluate(() => {
            const content = document.querySelector('#liveEditorTestHost .cm-content');
            const out = [];
            const walker = document.createTreeWalker(/** @type {Node} */ (content), NodeFilter.SHOW_TEXT);
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                let i = -1;
                while ((i = String(n.textContent).indexOf('target', i + 1)) >= 0) {
                    const range = document.createRange();
                    range.setStart(n, i + 3);
                    range.setEnd(n, i + 4);
                    const b = range.getBoundingClientRect();
                    out.push({ x: b.left + 1, y: b.top + b.height / 2 });
                }
            }
            return out;
        });
        expect(points.length).toBe(3);
        const expected = [...text.matchAll(/target/g)].map(m => /** @type {number} */ (m.index) + 3);
        for (const [k, point] of points.entries()) {
            await page.locator('#liveEditorTestOutside').click();
            await page.mouse.click(point.x, point.y);
            // @ts-ignore
            expect(await page.evaluate(() => window.liveEditorTest.editor.view.state.selection.main.toJSON())).toEqual({ anchor: expected[k], head: expected[k] });
        }
    });

    test('typing updates the field as written', async ({ page }) => {
        await mountRendered(page, 'One.\n\nTwo.');
        await page.locator('#liveEditorTestHost .cm-line').nth(2).click();
        await page.keyboard.press('End');
        await page.keyboard.type(' *new*');
        await expect(page.locator('#liveEditorTestTextarea')).toHaveValue('One.\n\nTwo. *new*');
        await expect(page.locator('#liveEditorTestHost .cm-line em')).toHaveText('*new*');
    });
});
