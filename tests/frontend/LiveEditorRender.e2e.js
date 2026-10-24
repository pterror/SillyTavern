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
        // Measured just before each click: a web font finishing its load moves the text.
        const pointOf = (/** @type {number} */ k) => page.evaluate((k) => {
            const content = document.querySelector('#liveEditorTestHost .cm-content');
            const found = [];
            const walker = document.createTreeWalker(/** @type {Node} */ (content), NodeFilter.SHOW_TEXT);
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                let i = -1;
                while ((i = String(n.textContent).indexOf('target', i + 1)) >= 0) found.push({ n, i });
            }
            if (k >= found.length) return null;
            const range = document.createRange();
            range.setStart(found[k].n, found[k].i + 3);
            range.setEnd(found[k].n, found[k].i + 4);
            const b = range.getBoundingClientRect();
            return { x: b.left + 1, y: b.top + b.height / 2 };
        }, k);
        const expected = [...text.matchAll(/target/g)].map(m => /** @type {number} */ (m.index) + 3);
        expect(expected.length).toBe(3);
        for (const [k, at] of expected.entries()) {
            await page.locator('#liveEditorTestOutside').click();
            const point = await pointOf(k);
            expect(point).not.toBeNull();
            await page.mouse.click(/** @type {{ x: number }} */ (point).x, /** @type {{ y: number }} */ (point).y);
            // @ts-ignore
            expect(await page.evaluate(() => window.liveEditorTest.editor.view.state.selection.main.toJSON())).toEqual({ anchor: at, head: at });
        }
    });

    test('an inline HTML element\'s look is on the text between its tags, as the app renders it; the tags stay, dimmed', async ({ page }) => {
        await mountRendered(page, 'Say <font color="red">hi</font> and <span style="color: rgb(0, 0, 255)" onclick="alert(1)">there</span> <!-- note -->');
        const font = page.locator('#liveEditorTestHost .cm-line font');
        await expect(font).toHaveText('hi');
        expect(await font.evaluate(el => getComputedStyle(el).color)).toBe('rgb(255, 0, 0)');
        const span = page.locator('#liveEditorTestHost .cm-line span[style]');
        await expect(span).toHaveText('there');
        expect(await span.evaluate(el => getComputedStyle(el).color)).toBe('rgb(0, 0, 255)');
        expect(await span.getAttribute('onclick')).toBeNull();
        await expect(page.locator('#liveEditorTestHost .cm-line')).toHaveText('Say <font color="red">hi</font> and <span style="color: rgb(0, 0, 255)" onclick="alert(1)">there</span> <!-- note -->');
        const dimmed = await page.locator('#liveEditorTestHost .live-html').evaluateAll(els => els.map(el => el.textContent));
        expect(dimmed).toEqual(['<font color="red">', '</font>', '<span style="color: rgb(0, 0, 255)" onclick="alert(1)">', '</span>', '<!-- note -->']);
    });

    test('an HTML block is drawn under its source, takes no clicks, and moves nothing on focus', async ({ page }) => {
        await mountRendered(page, 'Before.\n\n<div style="color: rgb(0, 128, 0)">\nInside the block\n</div>\n\nAfter.');
        const drawn = page.locator('#liveEditorTestHost .live-html-render');
        await expect(drawn).toHaveCount(1);
        await expect(drawn.locator('div')).toHaveText('Inside the block');
        expect(await drawn.locator('div').evaluate(el => getComputedStyle(el).color)).toBe('rgb(0, 128, 0)');
        await expect(page.locator('#liveEditorTestHost .cm-line').filter({ hasText: '<div' })).toHaveCount(1);
        const tops = () => page.locator('#liveEditorTestHost .cm-line').evaluateAll(els => els.map(el => Math.round(el.getBoundingClientRect().top)));
        const before = await tops();
        await page.locator('#liveEditorTestHost .cm-line').first().click();
        // @ts-ignore
        const selection = () => page.evaluate(() => window.liveEditorTest.editor.view.state.selection.main.toJSON());
        const at = await selection();
        await drawn.click();
        expect(await selection()).toEqual(at);
        expect(await tops()).toEqual(before);
    });

    test('an <img> shows its image, self-closing or not, in a line or on its own, and the tag stays, dimmed', async ({ page }) => {
        const tags = ['<img src="/img/ai4.png" width="20" alt="a">', '<img src="/img/ai4.png" width="20" alt="b"/>', '<img src="/img/ai4.png" width="20" alt="c" />', '<img src="/img/ai4.png" width="20" alt="d" onerror="alert(1)">'];
        await mountRendered(page, `in ${tags[0]} a line\n\n${tags[1]}\n\nalso ${tags[2]} in one\n\n${tags[3]}`);
        const shown = page.locator('#liveEditorTestHost :is(.live-image, .live-html-render) img');
        await expect(shown).toHaveCount(4);
        expect(await shown.evaluateAll(els => els.map(el => el.getAttribute('alt')).sort())).toEqual(['a', 'b', 'c', 'd']);
        expect(await shown.evaluateAll(els => els.some(el => el.hasAttribute('onerror')))).toBe(false);
        const dimmed = await page.locator('#liveEditorTestHost .live-html').evaluateAll(els => els.map(el => el.textContent));
        expect(dimmed).toEqual(tags);
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
