import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// After a paste that could have gone in more than one way, a small button at the end of the paste shows how it went
// in and switches it: keep formatting (markdown), keep as HTML, text only.

const HTML = '<p>Hello <b>bold</b> and <i>it</i>.</p>';
const PLAIN = 'Hello bold and it.';
const MARKDOWN = 'Hello **bold** and *it*.';

/** @param {import('@playwright/test').Page} page @param {string} [value] */
async function mount(page, value = '') {
    await page.evaluate(async (value) => {
        const registry = await import('/scripts/live-editor/registry.js');
        const host = document.createElement('div');
        host.id = 'liveEditorTestHost';
        host.style.cssText = 'position:fixed;top:60px;left:60px;width:500px;z-index:100000;background:#000;color:#fff';
        const textarea = document.createElement('textarea');
        textarea.id = 'liveEditorTestTextarea';
        textarea.value = value;
        host.append(textarea);
        document.body.append(host);
        const editor = await registry.mountLiveEditor(textarea, { formatting: false });
        editor.view.focus();
        editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
        // @ts-ignore
        window.liveEditorTest = { editor, textarea };
    }, value);
}

/**
 * Pastes as the browser would, into the focused editor's content.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} editor
 * @param {Record<string, string>} data
 */
async function paste(page, editor, data) {
    await editor.locator('.cm-content').evaluate((content, data) => {
        const transfer = new DataTransfer();
        for (const [type, value] of Object.entries(data)) transfer.setData(type, value);
        content.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    }, data);
}

const testEditor = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#liveEditorTestHost .cm-editor');

/**
 * Puts focus back in the test editor, where it was, before keys are pressed: the app can move focus (to the chat box)
 * on its own while it finishes loading.
 * @param {import('@playwright/test').Page} page
 */
async function refocus(page) {
    await page.evaluate(() => {
        // @ts-ignore
        window.liveEditorTest.editor.view.focus();
    });
}
const value = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#liveEditorTestTextarea').inputValue();

test.describe('the paste picker', () => {
    test.beforeEach(testSetup.awaitST);
    test.afterEach(async ({ page }) => {
        await page.evaluate(() => {
            // @ts-ignore
            window.liveEditorTest?.editor.destroy();
            document.getElementById('liveEditorTestHost')?.remove();
        });
    });

    test('a button at the end of the paste shows how it went in, and each way replaces exactly the paste', async ({ page }) => {
        await mount(page, 'Before ');
        const editor = testEditor(page);
        await paste(page, editor, { 'text/html': HTML, 'text/plain': PLAIN });
        await refocus(page);
        expect(await value(page)).toBe('Before ' + MARKDOWN);
        const picker = editor.locator('.live-paste-picker');
        await expect(picker).toBeVisible();
        await expect(picker.locator('.live-paste-picker-toggle')).toContainText('Keep formatting');
        // It sits below the end of the paste.
        const end = await page.evaluate(() => {
            // @ts-ignore
            const { view } = window.liveEditorTest.editor;
            return view.coordsAtPos(view.state.doc.length);
        });
        const box = await picker.boundingBox();
        expect(box.y).toBeGreaterThanOrEqual(end.top);

        await picker.locator('.live-paste-picker-toggle').click();
        await expect(picker.locator('.live-paste-picker-item')).toHaveText(['Keep formatting', 'Keep as HTML', 'Text only']);
        await picker.locator('.live-paste-picker-item[data-mode="plain"]').click();
        expect(await value(page)).toBe('Before ' + PLAIN);
        await expect(picker.locator('.live-paste-picker-toggle')).toContainText('Text only');

        await picker.locator('.live-paste-picker-toggle').click();
        await picker.locator('.live-paste-picker-item[data-mode="html"]').click();
        const html = await value(page);
        expect(html.startsWith('Before <p>Hello <b>bold</b>')).toBe(true);
        expect(html.endsWith('</p>')).toBe(true);
        // Focus stayed in the editor through the clicks.
        expect(await page.evaluate(() => document.activeElement?.closest('.cm-editor') !== null)).toBe(true);
    });

    test('Ctrl+Alt+V cycles the ways, and one undo goes back one way', async ({ page }) => {
        await mount(page);
        const editor = testEditor(page);
        await paste(page, editor, { 'text/html': HTML, 'text/plain': PLAIN });
        await refocus(page);
        await page.keyboard.press('Control+Alt+v');
        expect(await value(page)).toContain('<b>bold</b>');
        await page.keyboard.press('Control+Alt+v');
        expect(await value(page)).toBe(PLAIN);
        await page.keyboard.press('Control+Alt+v');
        expect(await value(page)).toBe(MARKDOWN);
        await expect(editor.locator('.live-paste-picker-toggle')).toContainText('Keep formatting');

        await page.keyboard.press('Control+z');
        expect(await value(page)).toBe(PLAIN);
        await expect(editor.locator('.live-paste-picker-toggle')).toContainText('Text only');
        await page.keyboard.press('Control+z');
        expect(await value(page)).toContain('<b>bold</b>');
        await expect(editor.locator('.live-paste-picker-toggle')).toContainText('Keep as HTML');
        await page.keyboard.press('Control+y');
        expect(await value(page)).toBe(PLAIN);
    });

    test('Escape closes the list, then puts the picker away; the paste stays', async ({ page }) => {
        await mount(page);
        const editor = testEditor(page);
        await paste(page, editor, { 'text/html': HTML, 'text/plain': PLAIN });
        await refocus(page);
        await editor.locator('.live-paste-picker-toggle').click();
        await expect(editor.locator('.live-paste-picker-menu')).toBeVisible();
        await refocus(page);
        await page.keyboard.press('Escape');
        await expect(editor.locator('.live-paste-picker-menu')).toHaveCount(0);
        await expect(editor.locator('.live-paste-picker')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(editor.locator('.live-paste-picker')).toHaveCount(0);
        expect(await value(page)).toBe(MARKDOWN);
        // Undo after putting it away still takes the paste back, not the picker.
        await page.keyboard.press('Control+z');
        expect(await value(page)).toBe('');
    });

    test('typing after a paste goes in as typed and puts the picker away', async ({ page }) => {
        await mount(page);
        const editor = testEditor(page);
        await paste(page, editor, { 'text/html': HTML, 'text/plain': PLAIN });
        await refocus(page);
        await page.keyboard.type(' more');
        expect(await value(page)).toBe(MARKDOWN + ' more');
        await expect(editor.locator('.live-paste-picker')).toHaveCount(0);
    });

    test('an edit somewhere else puts it away', async ({ page }) => {
        await mount(page, 'Start. ');
        const editor = testEditor(page);
        await paste(page, editor, { 'text/html': HTML, 'text/plain': PLAIN });
        await refocus(page);
        await page.evaluate(() => {
            // @ts-ignore
            window.liveEditorTest.editor.view.dispatch({ selection: { anchor: 0 } });
        });
        await expect(editor.locator('.live-paste-picker')).toBeVisible();
        await refocus(page);
        await page.keyboard.type('X');
        expect(await value(page)).toBe('XStart. ' + MARKDOWN);
        await expect(editor.locator('.live-paste-picker')).toHaveCount(0);
    });

    test('a paste that could only go in one way shows no picker', async ({ page }) => {
        await mount(page);
        const editor = testEditor(page);
        await paste(page, editor, { 'text/plain': 'just text' });
        await refocus(page);
        expect(await value(page)).toBe('just text');
        await expect(editor.locator('.live-paste-picker')).toHaveCount(0);
    });

    test('a pasted link can go in as a link or as text', async ({ page }) => {
        await mount(page);
        const editor = testEditor(page);
        await paste(page, editor, { 'text/plain': 'https://example.com/a', 'text/html': '<a href="https://example.com/a">https://example.com/a</a>' });
        await refocus(page);
        expect(await value(page)).toBe('<https://example.com/a>');
        await page.keyboard.press('Control+Alt+v');
        expect(await value(page)).toBe('https://example.com/a');
    });
});

test.describe('the paste picker in the app', () => {
    test.beforeEach(testSetup.awaitST);

    test('in the chat box: switching works, and Escape puts the picker away without anything else', async ({ page }) => {
        await page.evaluate(async () => {
            // @ts-ignore
            await SillyTavern.getContext().executeSlashCommandsWithOptions('/go Seraphina');
        });
        const editor = page.locator('#send_form .cm-editor');
        await expect(editor).toHaveCount(1, { timeout: 10000 });
        await editor.locator('.cm-content').click();
        await paste(page, editor, { 'text/html': HTML, 'text/plain': PLAIN });
        const read = () => page.evaluate(() => /** @type {HTMLTextAreaElement} */ (document.getElementById('send_textarea')).value);
        expect(await read()).toBe(MARKDOWN);
        await page.keyboard.press('Control+Alt+v');
        expect(await read()).toContain('<b>bold</b>');
        await page.keyboard.press('Escape');
        await expect(editor.locator('.live-paste-picker')).toHaveCount(0);
        expect(await read()).toContain('<b>bold</b>');
        await page.evaluate(() => {
            // @ts-ignore
            $('#send_textarea').val('').trigger('input');
        });
    });

    test('in a message edit: switching works, and the first Escape only puts the picker away', async ({ page }) => {
        await page.evaluate(async () => {
            const { power_user } = await import('/scripts/power-user.js');
            power_user.auto_save_msg_edits = false;
            // @ts-ignore
            const ctx = SillyTavern.getContext();
            await ctx.executeSlashCommandsWithOptions('/go Seraphina');
        });
        await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
        const id = await page.evaluate(async () => {
            // @ts-ignore
            const ctx = SillyTavern.getContext();
            await ctx.SlashCommandParser.commands['send'].callback({}, 'Edit me.');
            return ctx.chat.length - 1;
        });
        const mes = page.locator(`#chat .mes[mesid="${id}"]`);
        await mes.locator('.mes_edit').click();
        const editor = mes.locator('.cm-editor');
        await expect(editor).toBeVisible();
        await page.keyboard.press('Control+End');
        await paste(page, editor, { 'text/html': HTML, 'text/plain': PLAIN });
        const read = () => page.locator('#curEditTextarea').inputValue();
        expect(await read()).toBe('Edit me.' + MARKDOWN);
        await page.keyboard.press('Control+Alt+v');
        await page.keyboard.press('Control+Alt+v');
        expect(await read()).toBe('Edit me.' + PLAIN);
        await page.keyboard.press('Escape');
        await expect(editor.locator('.live-paste-picker')).toHaveCount(0);
        // The edit is still open: that Escape was the picker's.
        await expect(editor).toBeVisible();
        await mes.locator('.mes_edit_cancel').click();
    });
});
