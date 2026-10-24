import { test, expect } from './fixtures.js';
import { awaitLoaderGone, testSetup, openInfoTab } from './frontent-test-utils.js';

// Reported problems with the live editor, each named by its report id.

/**
 * Mounts an editor in a test host, rendering with the app's markdown and filling in macros as a field does, focused
 * at the end.
 * @param {import('@playwright/test').Page} page
 * @param {string} value
 * @param {{ textareaStyle?: string, contentClass?: string, className?: string, placeholder?: string }} [options]
 */
async function mount(page, value, options = {}) {
    await page.evaluate(async ({ value, options }) => {
        const registry = await import('/scripts/live-editor/registry.js');
        const { renderMarkdown } = await import('/scripts/marked-processor.js');
        const { substituteParams } = await import('/script.js');
        const { evaluateSafeMacro } = await import('/scripts/safe-macros.js');
        const host = document.createElement('div');
        host.id = 'liveEditorTestHost';
        host.style.cssText = 'position:fixed;top:60px;left:60px;width:500px;z-index:100000;background:#000;color:#fff';
        const textarea = document.createElement('textarea');
        textarea.id = 'liveEditorTestTextarea';
        textarea.className = options.className ?? '';
        textarea.value = value;
        if (options.textareaStyle) textarea.style.cssText = options.textareaStyle;
        if (options.placeholder) textarea.placeholder = options.placeholder;
        host.append(textarea);
        document.body.append(host);
        const editor = await registry.mountLiveEditor(textarea, {
            render: renderMarkdown,
            contentClass: options.contentClass ?? 'mes_text',
            macros: { evaluate: (/** @type {string} */ text) => evaluateSafeMacro(text, substituteParams, { name2Override: 'Testchar' }) },
        });
        editor.view.focus();
        editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
        // @ts-ignore
        window.liveEditorTest = { editor, textarea };
    }, { value, options });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} anchor
 * @param {number} [head]
 */
async function select(page, anchor, head = anchor) {
    await page.evaluate(({ anchor, head }) => {
        // @ts-ignore
        const { view } = window.liveEditorTest.editor;
        view.focus();
        view.dispatch({ selection: { anchor, head } });
    }, { anchor, head });
}

/**
 * A computed style of an element made from `html` and put in the page for a moment: what the app's own CSS gives it.
 * @param {import('@playwright/test').Page} page
 * @param {string} html
 * @param {string} selector The element inside `html` to read.
 * @param {string} property
 */
async function probeStyle(page, html, selector, property) {
    return page.evaluate(({ html, selector, property }) => {
        const holder = document.createElement('div');
        holder.innerHTML = html;
        document.body.append(holder);
        const value = getComputedStyle(/** @type {Element} */ (holder.querySelector(selector))).getPropertyValue(property);
        holder.remove();
        return value;
    }, { html, selector, property });
}

/** @param {import('@playwright/test').Locator} locator @param {string} property @param {string} [pseudo] */
const styleOf = (locator, property, pseudo) => locator.evaluate((el, { property, pseudo }) => getComputedStyle(el, pseudo).getPropertyValue(property), { property, pseudo });

const value = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#liveEditorTestTextarea').inputValue();

/**
 * @param {import('@playwright/test').Page} page
 * @param {Record<string, string>} values
 */
async function createAndOpen(page, values) {
    const avatar = await page.evaluate(async (values) => {
        // @ts-ignore
        const ctx = SillyTavern.getContext();
        const form = new FormData();
        form.append('ch_name', `Reported-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
        for (const [key, value] of Object.entries(values)) form.append(key, value);
        const headers = ctx.getRequestHeaders();
        delete headers['Content-Type'];
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        return (await response.text()).trim();
    }, values);
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        await SillyTavern.getContext().selectCharacterById(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar);
}

test.describe('live editor: reported problems', () => {
    test.beforeEach(testSetup.awaitST);
    test.beforeEach(({ page }) => awaitLoaderGone(page));
    test.afterEach(async ({ page }) => {
        await page.evaluate(async () => {
            // @ts-ignore
            window.liveEditorTest?.editor.destroy();
            document.getElementById('liveEditorTestHost')?.remove();
            const { power_user } = await import('/scripts/power-user.js');
            power_user.enable_md_hotkeys = true;
        });
    });

    test('ED5: the cursor has the text box\'s text color', async ({ page }) => {
        await mount(page, 'plain **bold**', { textareaStyle: 'color: rgb(10, 200, 30)' });
        await expect(page.locator('#liveEditorTestHost strong')).toBeVisible();
        await expect(page.locator('#liveEditorTestHost .cm-cursor')).toHaveCount(1);
        expect(await styleOf(page.locator('#liveEditorTestHost .cm-cursor'), 'border-left-color')).toBe('rgb(10, 200, 30)');
    });

    test('CH28: in an empty field the cursor is on the placeholder\'s line', async ({ page }) => {
        await mount(page, '', { placeholder: 'Type a message, or /? for help' });
        const cursor = page.locator('#liveEditorTestHost .cm-cursor');
        await expect(cursor).toHaveCount(1);
        // Read in the blink's shown half: hidden, it has no box.
        await expect(cursor).toBeVisible();
        const line = await page.locator('#liveEditorTestHost .cm-line').boundingBox();
        const drawn = await cursor.boundingBox();
        expect(Math.abs(drawn.y - line.y)).toBeLessThanOrEqual(2);
        expect(drawn.y + drawn.height).toBeLessThanOrEqual(line.y + line.height + 2);
    });

    test('ED9: list items sit without gaps', async ({ page }) => {
        await mount(page, '- one\n- two\n- three\n\nAfter');
        await select(page, 0);
        await page.locator('#liveEditorTestHost .cm-content').evaluate(el => /** @type {HTMLElement} */ (el).blur());
        const items = page.locator('#liveEditorTestHost .cm-line').filter({ hasText: /^- / });
        await expect(items).toHaveCount(3);
        const boxes = await items.evaluateAll(els => els.map(el => el.getBoundingClientRect()).map(r => ({ top: r.top, bottom: r.bottom })));
        expect(boxes[1].top - boxes[0].bottom).toBeLessThan(1);
        expect(boxes[2].top - boxes[1].bottom).toBeLessThan(1);
    });

    test('ED6: in the chat box, quotes look as in chat: the quote color and no added quote marks', async ({ page }) => {
        await page.evaluate(async () => {
            // @ts-ignore
            await SillyTavern.getContext().executeSlashCommandsWithOptions('/go Seraphina');
        });
        const editor = page.locator('#send_form .cm-editor');
        await expect(editor).toHaveCount(1, { timeout: 10000 });
        await page.evaluate(() => {
            // @ts-ignore
            $('#send_textarea').val('She said "hi" to me.').trigger('input');
            /** @type {HTMLElement} */ (document.activeElement)?.blur();
        });
        const quoteColor = await probeStyle(page, '<div class="mes_text"><q>x</q></div>', 'q', 'color');
        const expectChatQuote = async () => {
            const quote = editor.locator('q');
            await expect(quote).toHaveCount(1);
            // Polled: the block is drawn again as focus moves, and a style read off the old element is empty.
            await expect.poll(() => styleOf(quote, 'color')).toBe(quoteColor);
            await expect.poll(() => styleOf(quote, 'content', '::before')).toBe('""');
            await expect.poll(() => styleOf(quote, 'content', '::after')).toBe('""');
        };
        // Away from the chat box, its text is drawn as chat draws it; in it, the text is styled the same.
        await expectChatQuote();
        await editor.locator('.cm-content').focus();
        await expectChatQuote();
        await page.evaluate(() => {
            // @ts-ignore
            $('#send_textarea').val('').trigger('input');
        });
    });

    test('ED10: find and replace has the app\'s look: themed buttons, each checkbox on the line of its label', async ({ page }) => {
        await mount(page, 'a cat');
        await select(page, 0);
        await page.keyboard.press('Control+f');
        const search = page.locator('#liveEditorTestHost .cm-search');
        await expect(search).toBeVisible();
        const buttonBackground = await probeStyle(page, '<div class="menu_button">x</div>', '.menu_button', 'background-color');
        expect(await styleOf(search.locator('button[name="next"]'), 'background-color')).toBe(buttonBackground);
        const label = search.locator('label', { has: page.locator('input[name="case"]') });
        const [box, text] = await label.evaluate((el) => {
            const range = document.createRange();
            range.selectNodeContents(/** @type {Node} */ ([...el.childNodes].find(n => n.nodeType === Node.TEXT_NODE)));
            const box = /** @type {Element} */ (el.querySelector('input')).getBoundingClientRect();
            const text = range.getBoundingClientRect();
            return [{ top: box.top, bottom: box.bottom }, { top: text.top, bottom: text.bottom }];
        });
        expect(box.bottom).toBeGreaterThan(text.top);
        expect(box.top).toBeLessThan(text.bottom);
    });

    test('ED13: Ctrl+I on italic text takes the italics away', async ({ page }) => {
        await page.evaluate(async () => {
            const { power_user } = await import('/scripts/power-user.js');
            power_user.enable_md_hotkeys = true;
        });
        await mount(page, 'one *two* three', { className: 'mdHotkeys' });
        // The italic text with its marks selected.
        await select(page, 4, 9);
        await page.keyboard.press('Control+i');
        expect(await value(page)).toBe('one two three');
        // The cursor in a word of an italic phrase.
        await page.evaluate(() => {
            // @ts-ignore
            window.liveEditorTest.textarea.value = 'a *b c* d';
        });
        await select(page, 5);
        await page.keyboard.press('Control+i');
        expect(await value(page)).toBe('a b c d');
        // Underscores are italics too.
        await page.evaluate(() => {
            // @ts-ignore
            window.liveEditorTest.textarea.value = 'x _y_ z';
        });
        await select(page, 3, 4);
        await page.keyboard.press('Control+i');
        expect(await value(page)).toBe('x y z');
        // Bold text is made bold italic, not unbolded.
        await page.evaluate(() => {
            // @ts-ignore
            window.liveEditorTest.textarea.value = 'p **q** r';
        });
        await select(page, 4, 5);
        await page.keyboard.press('Control+i');
        expect(await value(page)).toBe('p ***q*** r');
    });

    test('ED16: a paste goes in as plain text; the picker still offers the formatted ways', async ({ page }) => {
        await mount(page, '');
        await page.locator('#liveEditorTestHost .cm-content').evaluate((content) => {
            const transfer = new DataTransfer();
            transfer.setData('text/html', '<p>Hello <b>bold</b>.</p>');
            transfer.setData('text/plain', 'Hello bold.');
            content.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
        });
        expect(await value(page)).toBe('Hello bold.');
        const picker = page.locator('#liveEditorTestHost .live-paste-picker');
        await expect(picker.locator('.live-paste-picker-toggle')).toContainText('Text only');
        await picker.locator('.live-paste-picker-toggle').click();
        await picker.locator('.live-paste-picker-item[data-mode="markdown"]').click();
        expect(await value(page)).toBe('Hello **bold**.');
    });

    test('ED20: every macro shows its value and is highlighted the same, in code and HTML too, as in the preview', async ({ page }) => {
        await mount(page, 'a {{char}} `{{char}}` <b>{{char}}</b>\n\n<div>{{char}}</div>\n\n```\n{{char}}\n```\n\nend');
        const sources = page.locator('#liveEditorTestHost .cm-line .macro-source');
        // Wherever the cursor is, every macro shows as written with its value beside it.
        for (const line of [1, 3, 9, 6]) {
            await page.evaluate((line) => {
                // @ts-ignore
                const { view } = window.liveEditorTest.editor;
                view.dispatch({ selection: { anchor: view.state.doc.line(line).from } });
            }, line);
            await expect(sources).toHaveCount(5);
            for (const source of await sources.all()) await expect(source).toHaveAttribute('data-sent-value', 'Testchar');
        }
        const macroColor = await probeStyle(page, '<div class="macro_preview_content"><span class="macro-substituted">x</span></div>', 'span', 'color');
        expect(await styleOf(sources.first(), 'color')).toBe(macroColor);
        expect(await sources.first().evaluate(el => getComputedStyle(el, '::after').color)).toBe(macroColor);
    });

    test('ED21: the macro suggestions have the look of the app\'s own suggestion list', async ({ page }) => {
        await mount(page, 'x');
        await select(page, 1);
        await page.keyboard.type(' {{cha');
        const list = page.locator('#liveEditorTestHost .cm-tooltip-autocomplete');
        await expect(list).toBeVisible();
        const appList = '<div class="autoComplete"><span class="probe" style="background-color: var(--ac-color-selectedBackground); color: var(--ac-color-selectedText)">x</span></div>';
        expect(await styleOf(list, 'background-color')).toBe(await probeStyle(page, appList, '.autoComplete', 'background-color'));
        expect(await styleOf(list, 'color')).toBe(await probeStyle(page, appList, '.autoComplete', 'color'));
        const selected = list.locator('li[aria-selected="true"]');
        expect(await styleOf(selected, 'background-color')).toBe(await probeStyle(page, appList, '.probe', 'background-color'));
        expect(await styleOf(selected, 'color')).toBe(await probeStyle(page, appList, '.probe', 'color'));
        const info = page.locator('#liveEditorTestHost .cm-completionInfo');
        await expect(info).toBeVisible();
        expect(await styleOf(info, 'background-color')).toBe(await probeStyle(page, appList, '.autoComplete', 'background-color'));
    });
});

test.describe('live editor in card fields: reported problems', () => {
    test.beforeEach(testSetup.awaitST);
    test.beforeEach(({ page }) => awaitLoaderGone(page));

    test('ED8: starting an edit keeps the clicked line in view with the cursor on it; the pencil keeps the top', async ({ page }) => {
        const lines = Array.from({ length: 120 }, (_, i) => `Line ${i + 1}`);
        await createAndOpen(page, { description: lines.join('\n\n') });
        await openInfoTab(page, 'description');
        const editorInfo = () => page.evaluate(async () => {
            const { view } = await import('/live-editor-lib.js');
            const v = view.EditorView.findFromDOM(/** @type {HTMLElement} */ (document.querySelector('#charInfoTab_description .cm-editor')));
            const head = v.state.selection.main.head;
            const coords = v.coordsAtPos(head);
            return { line: v.state.doc.lineAt(head).text, top: coords?.top ?? -1, focused: v.hasFocus };
        });

        const target = page.locator('.field_preview[data-for="description_textarea"] p', { hasText: /^Line 5$/ });
        await target.dblclick();
        await expect(page.locator('#charInfoTab_description .cm-editor')).toBeVisible();
        await expect.poll(async () => (await editorInfo()).focused).toBe(true);
        const clicked = await editorInfo();
        expect(clicked.line).toBe('Line 5');
        expect(clicked.top).toBeGreaterThanOrEqual(0);
        expect(clicked.top).toBeLessThan(page.viewportSize().height);
        await page.locator('.field_edit_cancel[data-for="description_textarea"]').click();

        await page.locator('.field_edit_toggle[data-for="description_textarea"]').click();
        await expect(page.locator('#charInfoTab_description .cm-editor')).toBeVisible();
        await expect.poll(async () => (await editorInfo()).focused).toBe(true);
        const top = await editorInfo();
        expect(top.line).toBe('Line 1');
        expect(top.top).toBeGreaterThanOrEqual(0);
        expect(top.top).toBeLessThan(page.viewportSize().height);
        await page.locator('.field_edit_cancel[data-for="description_textarea"]').click();
    });

    test('ED15: Shift+Delete deletes forward, or cuts the selection, as in a text box; it never clears the field', async ({ page }) => {
        await createAndOpen(page, { description: 'one two three' });
        await openInfoTab(page, 'description');
        await page.locator('.field_edit_toggle[data-for="description_textarea"]').click();
        await expect(page.locator('#charInfoTab_description .cm-editor')).toBeVisible();
        await page.keyboard.press('Control+Home');
        await page.keyboard.press('Shift+Delete');
        await expect(page.locator('#description_textarea')).toHaveValue('ne two three');
        await page.keyboard.press('Shift+End');
        await page.keyboard.press('Shift+Delete');
        await expect(page.locator('#description_textarea')).toHaveValue('');
        await page.locator('.field_edit_cancel[data-for="description_textarea"]').click();
    });

    test('ED24: a long field\'s preview scrolls with the drawer, not in a box of its own', async ({ page }) => {
        const lines = Array.from({ length: 120 }, (_, i) => `Line ${i + 1}`);
        await createAndOpen(page, { description: lines.join('\n\n') });
        await openInfoTab(page, 'description');
        const preview = page.locator('.field_preview[data-for="description_textarea"]');
        await expect(preview).toContainText('Line 120');
        expect(await styleOf(preview, 'max-height')).toBe('none');
        expect(await preview.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
    });
});
