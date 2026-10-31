import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

/** @param {import('@playwright/test').Page} page */
async function mountEmpty(page) {
    await page.evaluate(async () => {
        const registry = await import('/scripts/live-editor/registry.js');
        const host = document.createElement('div');
        host.id = 'liveEditorTestHost';
        host.style.cssText = 'position:fixed;top:60px;left:60px;width:500px;z-index:100000;background:#000;color:#fff';
        const textarea = document.createElement('textarea');
        textarea.id = 'liveEditorTestTextarea';
        host.append(textarea);
        document.body.append(host);
        const editor = await registry.mountLiveEditor(textarea, { formatting: false });
        editor.view.focus();
        // @ts-ignore
        window.liveEditorTest = { editor, textarea };
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {Record<string, string>} data
 */
async function paste(page, data) {
    await page.evaluate((data) => {
        const transfer = new DataTransfer();
        for (const [type, value] of Object.entries(data)) transfer.setData(type, value);
        // @ts-ignore
        window.liveEditorTest.editor.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    }, data);
}

const value = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#liveEditorTestTextarea').inputValue();

/**
 * @param {import('@playwright/test').Page} page
 * @param {'markdown'|'html'|'plain'} mode
 */
async function switchPaste(page, mode) {
    const picker = page.locator('#liveEditorTestHost .live-paste-picker');
    await picker.locator('.live-paste-picker-toggle').click();
    await picker.locator(`.live-paste-picker-item[data-mode="${mode}"]`).click();
}

test.describe('live editor paste', () => {
    test.beforeEach(testSetup.awaitST);
    test.beforeEach(async ({ page }) => mountEmpty(page));
    test.afterEach(async ({ page }) => {
        await page.evaluate(() => {
            // @ts-ignore
            window.liveEditorTest?.editor.destroy();
            document.getElementById('liveEditorTestHost')?.remove();
        });
    });

    test('copied HTML comes in as text, and as markdown when picked', async ({ page }) => {
        await paste(page, {
            'text/html': '<h2>Title</h2><p>Hello <b>bold</b> and <i>it</i>, a <a href="https://x.com/a">link</a>.</p><ul><li>one</li><li>two</li></ul><blockquote><p>quoted</p></blockquote>',
            'text/plain': 'Title Hello bold and it, a link. one two quoted',
        });
        expect(await value(page)).toBe('Title Hello bold and it, a link. one two quoted');
        await switchPaste(page, 'markdown');
        expect(await value(page)).toBe('## Title\n\nHello **bold** and *it*, a [link](https://x.com/a).\n\n- one\n- two\n\n> quoted');
    });

    test('what markdown can\'t say stays as HTML; markdown characters in text are escaped', async ({ page }) => {
        await paste(page, {
            'text/html': '<p>x <u>under</u> 2*3</p><table><tr><td>a</td></tr></table>',
            'text/plain': 'x under 2*3 a',
        });
        await switchPaste(page, 'markdown');
        const text = await value(page);
        expect(text).toContain('x <u>under</u> 2\\*3');
        expect(text).toContain('<table>');
    });

    test('plain text with no HTML is pasted as it is, and one undo takes the paste away', async ({ page }) => {
        await paste(page, { 'text/plain': 'just *text*' });
        expect(await value(page)).toBe('just *text*');
        await page.keyboard.press('Control+z');
        expect(await value(page)).toBe('');
    });

    test('a bare URL goes in as it is, and as an autolink when picked', async ({ page }) => {
        await paste(page, { 'text/plain': 'https://example.com/a_b', 'text/html': '<a href="https://example.com/a_b">https://example.com/a_b</a>' });
        expect(await value(page)).toBe('https://example.com/a_b');
        await switchPaste(page, 'markdown');
        expect(await value(page)).toBe('<https://example.com/a_b>');
    });
});
