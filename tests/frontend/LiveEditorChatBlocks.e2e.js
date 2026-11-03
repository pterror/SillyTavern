import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

const TEXT = [
    'First line',
    '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
    'After the blank lines :smile:',
    '',
    '# Heading',
    '',
    '> quoted *line*',
    '> second quoted',
    '',
    '> > nested',
    '',
    'Last line',
].join('\n');

/**
 * @param {import('@playwright/test').Page} page
 */
async function editedMessage(page) {
    await page.evaluate(async () => {
        // @ts-ignore
        const { power_user } = await import('/scripts/power-user.js');
        power_user.auto_save_msg_edits = false;
        // @ts-ignore
        await stTest.context().executeSlashCommandsWithOptions('/go Seraphina');
    });
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
    const id = await page.evaluate(async (text) => {
        // @ts-ignore
        const ctx = stTest.context();
        await ctx.SlashCommandParser.commands['send'].callback({}, text);
        return ctx.chat.length - 1;
    }, TEXT);
    const mes = page.locator(`#chat .mes[mesid="${id}"]`);
    await expect(mes.locator('.mes_text blockquote').first()).toBeVisible();
    const looks = (/** @type {import('@playwright/test').Locator} */ blocks) => blocks.evaluateAll(els => els.map((el) => {
        const s = getComputedStyle(el);
        return {
            tag: el.tagName,
            borderLeft: `${s.borderLeftWidth} ${s.borderLeftStyle} ${s.borderLeftColor}`,
            paddingLeft: s.paddingLeft,
            background: s.backgroundColor,
            fontSize: s.fontSize,
            fontWeight: s.fontWeight,
        };
    }));
    const rendered = await looks(mes.locator('.mes_text :is(blockquote, h1)'));
    expect(rendered.map(l => l.tag)).toEqual(['H1', 'BLOCKQUOTE', 'BLOCKQUOTE', 'BLOCKQUOTE']);
    await mes.locator('.mes_edit').click();
    await expect(mes.locator('.cm-editor')).toBeVisible();
    const edited = await looks(mes.locator('.cm-content :is(blockquote, h1)'));
    return { mes, rendered, edited };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} selector
 */
function lineLayout(page, selector) {
    return page.evaluate(async (selector) => {
        const lib = await import('/live-editor-lib.js');
        const dom = /** @type {HTMLElement} */ (document.querySelector(selector));
        const view = /** @type {import('@codemirror/view').EditorView} */ (lib.view.EditorView.findFromDOM(dom));
        return [...dom.querySelectorAll('.cm-line')].map((line) => {
            const box = line.getBoundingClientRect();
            const block = view.lineBlockAt(view.posAtDOM(line));
            return { text: view.state.doc.lineAt(block.from).text, top: box.top, height: box.height, mapTop: view.documentTop + block.top, mapHeight: block.height };
        });
    }, selector);
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function measureMessageEditor(page) {
    await testSetup.awaitST({ page });
    const { mes, rendered, edited } = await editedMessage(page);
    const nested = await mes.locator('.cm-content blockquote > blockquote > .cm-line').allTextContents();
    const editorSelector = `#chat .mes[mesid="${await mes.getAttribute('mesid')}"] .cm-editor`;
    await mes.locator('.cm-line').last().scrollIntoViewIfNeeded();
    const lines = await lineLayout(page, editorSelector);
    const target = lines.findIndex(l => l.text === '> quoted *line*');
    const targetBox = /** @type {{ x: number }} */ (await mes.locator('.cm-line').nth(target).boundingBox());
    await page.mouse.click(targetBox.x + 20, lines[target].top + lines[target].height / 2);
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+Home');
    const selection = await page.evaluate(async (selector) => {
        const lib = await import('/live-editor-lib.js');
        const view = /** @type {import('@codemirror/view').EditorView} */ (lib.view.EditorView.findFromDOM(/** @type {HTMLElement} */ (document.querySelector(selector))));
        const { from, to } = view.state.selection.main;
        return view.state.sliceDoc(from, to);
    }, editorSelector);
    await mes.locator('.mes_edit_cancel').click();
    return { rendered, edited, nested, lines, selection };
}

test('the live editor draws chat blocks as chat does, on lines CodeMirror measures, in Chromium and Firefox', async ({ page, playwright, baseURL }) => {
    const firefox = await playwright.firefox.launch();
    try {
        const firefoxPage = await (await firefox.newContext({ baseURL })).newPage();
        for (const [browser, browserPage] of /** @type {const} */ ([['Chromium', page], ['Firefox', firefoxPage]])) {
            const { rendered, edited, nested, lines, selection } = await measureMessageEditor(browserPage);
            expect.soft(edited, `${browser}: the editor's heading and quotes look as the message draws them`).toEqual(rendered);
            expect.soft(nested, `${browser}: a quote in a quote is a blockquote in a blockquote`).toEqual(['> > nested']);
            expect(lines.map(l => l.text), `${browser}: every line is drawn`).toEqual(TEXT.split('\n'));
            const lineHeight = lines[0].height;
            expect(lineHeight).toBeGreaterThan(10);
            for (const line of lines) {
                expect.soft(Math.abs(line.top - line.mapTop), `${browser}: "${line.text}" is where CodeMirror has it`).toBeLessThan(1);
                expect.soft(Math.abs(line.height - line.mapHeight), `${browser}: "${line.text}" is as tall as CodeMirror has it`).toBeLessThan(1);
            }
            for (const blank of lines.filter(l => l.text === '')) {
                expect.soft(Math.abs(blank.height - lineHeight), `${browser}: a blank line is one line tall`).toBeLessThan(1);
            }
            expect.soft(selection, `${browser}: a click on a line, End and Shift+Home select that line`).toBe('> quoted *line*');
        }
    } finally {
        await firefox.close();
    }
});
