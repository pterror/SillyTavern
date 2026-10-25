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

    test('each macro is a pill holding what is sent in its place, wherever the cursor is; its braces are never on screen', async ({ page }) => {
        await mountWithMacros(page, 'Hello {{char}} and {{random::a::b}} and {{//note}}.');
        const pills = page.locator('#liveEditorTestHost .cm-line .macro-pill');
        for (const anchor of [0, 9, 30]) {
            await page.evaluate((anchor) => {
                // @ts-ignore
                window.liveEditorTest.editor.view.dispatch({ selection: { anchor } });
            }, anchor);
            // A name is a mention of who it is; one worked out only when sent, or sending nothing, says what it is.
            await expect(pills).toHaveText(['@Testchar', 'random · a · b', '//note']);
            expect(await pills.evaluateAll(els => els.map(el => el.className))).toEqual(['macro-pill macro-pill-mention', 'macro-pill macro-pill-later', 'macro-pill macro-pill-empty']);
            expect(await page.locator('#liveEditorTestHost .cm-content').textContent()).not.toContain('{{');
        }
        await expect(page.locator('#liveEditorTestTextarea')).toHaveValue('Hello {{char}} and {{random::a::b}} and {{//note}}.');
    });

    test('a pill is one step for the cursor and one Backspace; beside it, a tooltip above it shows its source', async ({ page }) => {
        await mountWithMacros(page, 'Hello {{char}} there.');
        const view = () => page.evaluate(() => {
            // @ts-ignore
            const { view } = window.liveEditorTest.editor;
            return { head: view.state.selection.main.head, doc: view.state.doc.toString() };
        });
        await page.locator('#liveEditorTestHost .cm-content').click();
        await page.keyboard.press('Home');
        const tooltip = page.locator('#liveEditorTestHost .live-macro-tooltip');
        // Where the user put the cursor: not where it was placed for them.
        await expect(tooltip).toHaveCount(0);
        for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
        await expect(tooltip.locator('code')).toHaveText('{{char}}');
        await expect(tooltip).toContainText('replaced by “Testchar”');
        // Above the pill.
        const pill = await page.locator('#liveEditorTestHost .macro-pill').boundingBox();
        expect((await tooltip.boundingBox()).y + (await tooltip.boundingBox()).height).toBeLessThanOrEqual(pill.y + 1);
        await page.keyboard.press('ArrowRight');
        expect((await view()).head).toBe(14);
        await page.keyboard.press('ArrowRight');
        await expect(tooltip).toHaveCount(0);
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('Backspace');
        expect(await view()).toEqual({ head: 6, doc: 'Hello  there.' });
    });

    test('a double click opens a pill\'s source for editing until the cursor leaves it; Ctrl+Shift+M shows every macro as written', async ({ page }) => {
        await mountWithMacros(page, 'Hello {{char}} there, {{user}}.');
        await page.locator('#liveEditorTestHost .macro-pill').first().dblclick();
        await expect(page.locator('#liveEditorTestHost .macro-source')).toHaveText(['{{char}}']);
        await expect(page.locator('#liveEditorTestHost .macro-pill')).toHaveCount(1);
        await page.keyboard.type('!');
        await expect(page.locator('#liveEditorTestTextarea')).toHaveValue('Hello {{char!}} there, {{user}}.');
        await page.keyboard.press('Backspace');
        await page.keyboard.press('End');
        await expect(page.locator('#liveEditorTestHost .macro-source')).toHaveCount(0);
        await expect(page.locator('#liveEditorTestHost .macro-pill')).toHaveText(['@Testchar', /^@/]);
        await page.keyboard.press('Control+Shift+M');
        await expect(page.locator('#liveEditorTestHost .macro-source')).toHaveText(['{{char}}', '{{user}}']);
        await expect(page.locator('#liveEditorTestHost .macro-pill')).toHaveCount(0);
        await page.keyboard.press('Control+Shift+M');
        await expect(page.locator('#liveEditorTestHost .macro-pill')).toHaveCount(2);
    });

    test('a click at the start of a paragraph\'s last line puts the cursor on that line, wherever a pill falls', async ({ page }) => {
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
                // Clicks along the start of the paragraph's last line, where a pill lands when the line wraps at it.
                for (const dx of [3, 20, 40, 60]) {
                    const pos = view.posAtCoords({ x: left + dx, y: last.top + 5 });
                    const caret = view.coordsAtPos(pos, 1);
                    // Beside a pill the cursor takes the pill's box, a pixel off the text's: the same line within half a line.
                    if (Math.abs(caret.top - last.top) > 8) out.push(`line ${n} +${dx}: cursor at ${Math.round(caret.top)}, clicked ${Math.round(last.top)}`);
                }
            }
            return [out.length, out.slice(0, 5)];
        });
        expect(misses).toEqual([0, []]);
    });

    test('each category of macro has its own color, the same in the editor and in a preview', async ({ page }) => {
        const macros = ['{{user}}', '{{char}}', '{{description}}', '{{lastMessageId}}', '{{time}}', '{{random::a::b}}', '{{getvar::x}}'];
        await mountWithMacros(page, macros.join(' '));
        const pills = page.locator('#liveEditorTestHost .cm-line .macro-pill');
        await expect(pills).toHaveCount(macros.length);
        const editor = await pills.evaluateAll(els => els.map(el => [el.dataset.macroCategory ?? null, getComputedStyle(el).color]));
        expect(editor.map(([category]) => category)).toEqual(['names', 'names', 'character', 'chat', 'time', 'random', 'variable']);
        const colors = editor.map(([, color]) => color);
        // Names have the theme's macro color; every other category its own.
        const macroColor = await page.evaluate(() => {
            const probe = document.createElement('span');
            probe.style.color = 'var(--SmartThemeMacroColor)';
            document.body.append(probe);
            const color = getComputedStyle(probe).color;
            probe.remove();
            return color;
        });
        expect(colors[0]).toBe(macroColor);
        expect(colors[1]).toBe(macroColor);
        expect(new Set(colors.slice(1)).size).toBe(6);
        // A preview draws the same pills, so they have the same colors.
        const preview = await page.evaluate(async () => {
            const { substituteSafeMacros } = await import('/scripts/safe-macros.js');
            const { insertMacroPills } = await import('/scripts/macro-pill.js');
            const { t } = await import('/scripts/i18n.js');
            const { substituteParams } = await import('/script.js');
            const { text, macros } = substituteSafeMacros('{{user}} {{description}} {{time}} {{getvar::x}} {{random::a::b}}', substituteParams);
            const holder = document.createElement('div');
            holder.className = 'macro_preview_content';
            holder.innerHTML = insertMacroPills(text, macros, t);
            document.body.append(holder);
            const found = [...holder.querySelectorAll('.macro-pill')].map(el => [/** @type {HTMLElement} */ (el).dataset.macroCategory ?? null, getComputedStyle(el).color]);
            holder.remove();
            return found;
        });
        expect(preview).toEqual([['names', colors[0]], ['character', colors[2]], ['time', colors[4]], ['variable', colors[6]], ['random', colors[5]]]);
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
