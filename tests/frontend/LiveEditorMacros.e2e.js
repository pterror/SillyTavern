import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

/**
 * Mounts an editor that fills in macros the way a field does.
 * @param {import('@playwright/test').Page} page
 * @param {string} value
 */
async function mountWithMacros(page, value) {
    await page.evaluate(async (value) => {
        const registry = await import('/scripts/live-editor/registry.js');
        const { renderMarkdown } = await import('/scripts/marked-processor.js');
        const { substituteParams } = await import('/script.js');
        const { evaluateSafeMacro } = await import('/scripts/safe-macros.js');
        const host = document.createElement('div');
        host.id = 'liveEditorTestHost';
        host.style.cssText = 'position:fixed;top:60px;left:60px;width:500px;z-index:100000;background:#000;color:#fff';
        const textarea = document.createElement('textarea');
        textarea.id = 'liveEditorTestTextarea';
        textarea.value = value;
        host.append(textarea);
        document.body.append(host);
        const editor = await registry.mountLiveEditor(textarea, {
            render: renderMarkdown,
            macros: { evaluate: (/** @type {string} */ text) => evaluateSafeMacro(text, substituteParams, { name2Override: 'Testchar' }) },
        });
        // @ts-ignore
        window.liveEditorTest = { editor, textarea };
    }, value);
}

test.describe('live editor macros', () => {
    test.beforeEach(testSetup.awaitST);
    test.afterEach(async ({ page }) => {
        await page.evaluate(() => {
            // @ts-ignore
            window.liveEditorTest?.editor.destroy();
            document.getElementById('liveEditorTestHost')?.remove();
        });
    });

    test('each macro shows as written with what is sent beside it, wherever the cursor is; one that only runs when sent says so', async ({ page }) => {
        await mountWithMacros(page, 'Hello {{char}} and {{random::a::b}}.');
        const sources = page.locator('#liveEditorTestHost .cm-line .macro-source');
        for (const anchor of [0, 9, 30]) {
            await page.evaluate((anchor) => {
                // @ts-ignore
                window.liveEditorTest.editor.view.dispatch({ selection: { anchor } });
            }, anchor);
            await expect(sources).toHaveText(['{{char}}', '{{random::a::b}}']);
            expect(await sources.evaluateAll(els => els.map(el => getComputedStyle(el, '::after').content))).toEqual(['"⁠sent as Testchar"', '"⁠filled in when sent"']);
        }
        // What is sent beside a macro isn't part of the text.
        await expect(page.locator('#liveEditorTestTextarea')).toHaveValue('Hello {{char}} and {{random::a::b}}.');
    });

    test('a drag held between a macro\'s end and its value\'s end changes nothing on the line', async ({ page }) => {
        await mountWithMacros(page, 'Hello {{char}} and more text after it.');
        const source = await page.locator('#liveEditorTestHost .macro-source').boundingBox();
        const y = source.y + source.height / 2;
        await page.evaluate(() => {
            // @ts-ignore
            window.__lineChanges = 0;
            // @ts-ignore
            new MutationObserver(records => { window.__lineChanges += records.length; })
                .observe(document.querySelector('#liveEditorTestHost .cm-content'), { childList: true, subtree: true, characterData: true });
        });
        await page.mouse.move(source.x - 20, y);
        await page.mouse.down();
        await page.mouse.move(source.x + source.width + 2, y, { steps: 5 });
        // Onto what is sent, drawn at the end of the macro's span.
        await page.mouse.move(source.x + source.width - 5, y, { steps: 5 });
        await page.waitForTimeout(300);
        await page.mouse.up();
        // @ts-ignore
        expect(await page.evaluate(() => window.__lineChanges)).toBe(0);
        await expect(page.locator('#liveEditorTestHost .macro-source')).toHaveText('{{char}}');
    });

    test('a macro and what is sent beside it stay on one line, and a click on it puts the cursor on that line', async ({ page }) => {
        // The macro at every offset across the editor's width, so one of them falls where a line wraps.
        const lines = Array.from({ length: 60 }, (_, i) => `${'w'.repeat(i)} ${'word '.repeat(9)}{{char}} at the end.`);
        await mountWithMacros(page, lines.join('\n\n'));
        const misses = await page.evaluate(async () => {
            // @ts-ignore
            const { view } = window.liveEditorTest.editor;
            const out = [];
            const left = view.contentDOM.getBoundingClientRect().left;
            for (let n = 1; n <= view.state.doc.lines; n += 2) {
                const line = view.state.doc.line(n);
                view.dispatch({ effects: view.constructor.scrollIntoView(line.to, { y: 'center' }) });
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const last = view.coordsAtPos(line.to, -1);
                // Clicks along the start of the paragraph's last line, where what is sent lands when the line wraps
                // right after the macro.
                for (const dx of [3, 20, 40, 60]) {
                    const pos = view.posAtCoords({ x: left + dx, y: last.top + 5 });
                    const caret = view.coordsAtPos(pos, 1);
                    if (caret.top !== last.top) out.push(`line ${n} +${dx}: cursor at ${Math.round(caret.top)}, clicked ${Math.round(last.top)}`);
                }
            }
            return [out.length, out.slice(0, 5)];
        });
        expect(misses).toEqual([0, []]);
    });

    test('typing a macro shows the app\'s macro suggestions with the highlighted one\'s current value', async ({ page }) => {
        await mountWithMacros(page, 'x');
        await page.locator('#liveEditorTestHost .cm-line').first().click();
        await page.keyboard.press('End');
        await page.keyboard.type(' {{cha');
        const list = page.locator('#liveEditorTestHost .cm-tooltip-autocomplete');
        await expect(list).toBeVisible();
        await expect(list.locator('li[aria-selected="true"]')).toContainText('char');
        await expect(page.locator('#liveEditorTestHost .live-macro-value')).toHaveText('Now: Testchar');
        await page.keyboard.press('Enter');
        await expect(page.locator('#liveEditorTestTextarea')).toHaveValue('x {{char}}');
    });
});
