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

/**
 * The editor's rendered blocks as HTML, without the hidden tails, and the app's render of the whole text, both with
 * whitespace between tags removed.
 * @param {import('@playwright/test').Page} page
 */
async function renderedAndExpected(page) {
    return page.evaluate(() => {
        const normalize = (/** @type {string} */ html) => html.replace(/>\s+</g, '><').trim();
        // @ts-ignore
        const { textarea, renderMarkdown } = window.liveEditorTest;
        const units = [...document.querySelectorAll('#liveEditorTestHost .live-unit')].map(el => {
            const copy = /** @type {HTMLElement} */ (el.cloneNode(true));
            copy.querySelectorAll('.live-unit-tail').forEach(t => t.remove());
            return normalize(copy.innerHTML);
        });
        return { units, expected: normalize(renderMarkdown(textarea.value)) };
    });
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

    test('unfocused, every block is the app\'s own render, so it looks like the preview', async ({ page }) => {
        await mountRendered(page, '# Title\n\nSome *em* and **strong**.\n\n- a\n- b\n\n> quoted');
        const { units, expected } = await renderedAndExpected(page);
        expect(units.length).toBe(4);
        expect(units.join('')).toBe(expected);
        await expect(page.locator('#liveEditorTestHost .cm-line')).toHaveCount(0);
    });

    test('clicking a block makes it editable source, styled as chat; the other blocks stay rendered', async ({ page }) => {
        await mountRendered(page, 'First paragraph.\n\nSecond with *em* here.\nNext line **b**.');
        await page.locator('#liveEditorTestHost .live-unit').nth(1).click();
        const lines = page.locator('#liveEditorTestHost .cm-line');
        await expect(lines).toHaveCount(2);
        await expect(page.locator('#liveEditorTestHost .live-unit')).toHaveCount(1);
        await expect(page.locator('#liveEditorTestHost .cm-line em')).toHaveText('*em*');
        await expect(page.locator('#liveEditorTestHost .cm-line strong')).toHaveText('**b**');
        // Syntax shows on the line being typed on and is hidden on the block's other line.
        const syntaxShown = await page.evaluate(() => [...document.querySelectorAll('#liveEditorTestHost .cm-line')].map(line => [...line.querySelectorAll('.live-syntax')].map(el => getComputedStyle(el).display !== 'none')));
        const cursorLine = await page.evaluate(() => [...document.querySelectorAll('#liveEditorTestHost .cm-line')].findIndex(l => l.classList.contains('live-cursor-line')));
        expect(cursorLine).toBeGreaterThanOrEqual(0);
        syntaxShown.forEach((shown, i) => expect(shown.every(s => s === (i === cursorLine))).toBe(true));
    });

    test('typing in the block being edited updates the field, and leaving the editor renders it again', async ({ page }) => {
        await mountRendered(page, 'One.\n\nTwo.');
        await page.locator('#liveEditorTestHost .live-unit').nth(1).click();
        await page.keyboard.press('End');
        await page.keyboard.type(' *new*');
        await expect(page.locator('#liveEditorTestTextarea')).toHaveValue('One.\n\nTwo. *new*');
        await page.locator('#liveEditorTestOutside').click();
        await expect(page.locator('#liveEditorTestHost .cm-line')).toHaveCount(0);
        const { units, expected } = await renderedAndExpected(page);
        expect(units.join('')).toBe(expected);
        expect(units[1]).toContain('<em>new</em>');
    });

    test('blocks that only render right together are one block', async ({ page }) => {
        await mountRendered(page, 'See [the site][r].\n\nMiddle.\n\n[r]: https://example.com');
        const { units, expected } = await renderedAndExpected(page);
        expect(units.join('')).toBe(expected);
        expect(units.join('')).toContain('href="https://example.com"');
        expect(units.length).toBeLessThan(3);
    });
});
