import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

/**
 * Puts a textarea in the page, with listeners that record what reaches it and the document, and mounts an editor.
 * @param {import('@playwright/test').Page} page
 * @param {string} value
 * @param {string} [style] Inline style for the textarea.
 */
async function mountOnTestTextarea(page, value, style = '') {
    await page.evaluate(async ({ value, style }) => {
        const registry = await import('/scripts/live-editor/registry.js');
        const host = document.createElement('div');
        host.id = 'liveEditorTestHost';
        host.style.cssText = 'position:fixed;top:60px;left:60px;width:400px;z-index:100000;background:#000';
        const textarea = document.createElement('textarea');
        textarea.id = 'liveEditorTestTextarea';
        textarea.value = value;
        textarea.setAttribute('style', style);
        host.append(textarea);
        document.body.append(host);
        const log = { input: [], keydownOnTextarea: [], keydownOnDocument: [], focus: 0, blur: 0 };
        textarea.addEventListener('input', e => log.input.push({ value: textarea.value, user: registry.isUserEvent(e) }));
        textarea.addEventListener('keydown', e => {
            log.keydownOnTextarea.push(e.key);
            if (e.key === 'q') e.preventDefault();
        });
        textarea.addEventListener('focus', () => log.focus++);
        textarea.addEventListener('blur', () => log.blur++);
        document.addEventListener('keydown', e => {
            if (document.getElementById('liveEditorTestHost')?.contains(/** @type {Node} */ (e.target))) {
                log.keydownOnDocument.push(/** @type {Element} */ (e.target).id || /** @type {Element} */ (e.target).className);
            }
        });
        // @ts-ignore
        window.liveEditorTest = { log, registry, editor: await registry.mountLiveEditor(textarea), textarea };
    }, { value, style });
}

/** @param {import('@playwright/test').Page} page */
async function readLog(page) {
    // @ts-ignore
    return page.evaluate(() => structuredClone(window.liveEditorTest.log));
}

test.describe('live editor mounted on a textarea', () => {
    test.beforeEach(testSetup.awaitST);
    test.afterEach(async ({ page }) => {
        await page.evaluate(() => {
            // @ts-ignore
            window.liveEditorTest?.editor.destroy();
            document.getElementById('liveEditorTestHost')?.remove();
        });
    });

    test('opening and closing without typing writes nothing, and the textarea comes back as it was', async ({ page }) => {
        await mountOnTestTextarea(page, 'line one\r\nline two');
        await expect(page.locator('#liveEditorTestHost .cm-editor')).toBeVisible();
        const before = await page.evaluate(() => {
            // @ts-ignore
            const { editor, textarea } = window.liveEditorTest;
            return { doc: editor.view.state.doc.toString(), value: textarea.value };
        });
        expect(before.doc).toBe(before.value);
        await page.evaluate(() => {
            // @ts-ignore
            window.liveEditorTest.editor.destroy();
        });
        const after = await page.evaluate(() => {
            // @ts-ignore
            const { textarea } = window.liveEditorTest;
            return { value: textarea.value, hasOwnValue: Object.hasOwn(textarea, 'value'), hidden: textarea.classList.contains('live-editor-textarea') };
        });
        expect(after).toEqual({ value: before.value, hasOwnValue: false, hidden: false });
        expect((await readLog(page)).input).toEqual([]);
        await expect(page.locator('#liveEditorTestHost .cm-editor')).toHaveCount(0);
    });

    test('typing updates the textarea and fires one input event the field editor counts as the user\'s', async ({ page }) => {
        await mountOnTestTextarea(page, 'ab');
        await page.locator('#liveEditorTestHost .cm-content').click();
        await page.keyboard.press('End');
        await page.keyboard.type('c');
        const log = await readLog(page);
        expect(log.input).toEqual([{ value: 'abc', user: true }]);
        expect(await page.locator('#liveEditorTestTextarea').inputValue()).toBe('abc');
    });

    test('a write from code (.val, .value, setRangeText) shows in the editor and fires nothing', async ({ page }) => {
        await mountOnTestTextarea(page, 'hello world');
        const result = await page.evaluate(() => {
            // @ts-ignore
            const { editor, textarea } = window.liveEditorTest;
            $(textarea).val('hello there world');
            const afterVal = editor.view.state.doc.toString();
            textarea.value = 'set directly';
            const afterValue = editor.view.state.doc.toString();
            textarea.setRangeText('SET', 0, 3, 'select');
            return { afterVal, afterValue, afterRange: editor.view.state.doc.toString(), read: $(textarea).val(), selection: [textarea.selectionStart, textarea.selectionEnd] };
        });
        expect(result).toEqual({ afterVal: 'hello there world', afterValue: 'set directly', afterRange: 'SET directly', read: 'SET directly', selection: [0, 3] });
        expect((await readLog(page)).input).toEqual([]);
    });

    test('setSelectionRange then focus() puts the cursor where the code asked, and focus reaches the textarea', async ({ page }) => {
        await mountOnTestTextarea(page, 'abcdef');
        await page.evaluate(() => {
            // @ts-ignore
            const { textarea } = window.liveEditorTest;
            textarea.setSelectionRange(2, 4);
            textarea.focus();
        });
        await page.keyboard.type('X');
        expect(await page.locator('#liveEditorTestTextarea').inputValue()).toBe('abXef');
        const log = await readLog(page);
        expect(log.focus).toBe(1);
        await page.evaluate(() => {
            // @ts-ignore
            window.liveEditorTest.textarea.blur();
        });
        expect((await readLog(page)).blur).toBe(1);
    });

    test('keys reach listeners on the textarea first, and once on the document; one they prevent isn\'t typed', async ({ page }) => {
        await mountOnTestTextarea(page, '');
        await page.locator('#liveEditorTestHost .cm-content').click();
        await page.keyboard.type('aqb');
        expect(await page.locator('#liveEditorTestTextarea').inputValue()).toBe('ab');
        const log = await readLog(page);
        expect(log.keydownOnTextarea).toEqual(['a', 'q', 'b']);
        expect(log.keydownOnDocument).toEqual(['liveEditorTestTextarea', 'liveEditorTestTextarea', 'liveEditorTestTextarea']);
    });

    test('the editor takes the textarea\'s font, also when an inline style changes later', async ({ page }) => {
        await mountOnTestTextarea(page, 'text', 'font-family: monospace; font-size: 21px');
        const read = () => page.locator('#liveEditorTestHost .cm-editor').evaluate(el => [getComputedStyle(el).fontFamily, getComputedStyle(el).fontSize]);
        expect(await read()).toEqual(['monospace', '21px']);
        await page.evaluate(() => {
            // @ts-ignore
            window.liveEditorTest.textarea.style.fontFamily = 'serif';
        });
        await expect.poll(read).toEqual(['serif', '21px']);
    });

    test('getFocusedField names the textarea while its editor has focus', async ({ page }) => {
        await mountOnTestTextarea(page, 'x');
        await page.locator('#liveEditorTestHost .cm-content').click();
        const id = await page.evaluate(async () => {
            const { getFocusedField } = await import('/scripts/live-editor/registry.js');
            return getFocusedField()?.id;
        });
        expect(id).toBe('liveEditorTestTextarea');
    });
});
