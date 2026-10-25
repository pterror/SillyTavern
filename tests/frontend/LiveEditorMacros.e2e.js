import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

/**
 * Mounts an editor that fills in macros the way a field does.
 * @param {import('@playwright/test').Page} page
 * @param {string} value
 */
async function mountWithMacros(page, value, { person = false } = {}) {
    await page.evaluate(async ({ value, person }) => {
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
            macros: {
                evaluate: (/** @type {string} */ text) => evaluateSafeMacro(text, substituteParams, { name2Override: 'Testchar' }),
                person: person ? (/** @type {string} */ name) => ({ name: `Person ${name}`, avatarUrl: '/img/ai4.png', about: `About ${name}.` }) : undefined,
            },
        });
        // @ts-ignore
        window.liveEditorTest = { editor, textarea };
    }, { value, person });
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
            // A name is the name alone; one worked out only when sent, or sending nothing, says what it is.
            await expect(pills).toHaveText(['Testchar', 'random · a · b', '//note']);
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
        // Away from the pills, so no hover tooltip shows.
        await page.mouse.move(0, 0);
        await page.keyboard.press('Home');
        const tooltip = page.locator('.macro-tooltip:popover-open');
        // Where the user put the cursor: not where it was placed for them.
        await expect(tooltip).toHaveCount(0);
        for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
        // Just the source: the pill says the rest.
        await expect(tooltip).toHaveText('{{char}}');
        // Above the pill, centered on it.
        const pill = await page.locator('#liveEditorTestHost .macro-pill').boundingBox();
        const box = await tooltip.boundingBox();
        expect(box.y + box.height).toBeLessThanOrEqual(pill.y + 1);
        // Within the editor's border: CodeMirror places a tooltip from the editor's inside.
        expect(Math.abs((box.x + box.width / 2) - (pill.x + pill.width / 2))).toBeLessThan(3);
        await page.keyboard.press('ArrowRight');
        expect((await view()).head).toBe(14);
        await page.keyboard.press('ArrowRight');
        await expect(tooltip).toHaveCount(0);
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('Backspace');
        expect(await view()).toEqual({ head: 6, doc: 'Hello  there.' });
    });

    test('a mention\'s tooltip is a card of who it names; another macro\'s adds a note only when the pill doesn\'t say it all', async ({ page }) => {
        await mountWithMacros(page, 'A {{char}} b {{random::x::y}} c {{//note}} d', { person: true });
        const tooltip = page.locator('.macro-tooltip:popover-open');
        await page.locator('#liveEditorTestHost .cm-content').click();
        // Away from the pills, so no hover tooltip shows.
        await page.mouse.move(0, 0);
        await page.keyboard.press('Home');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await expect(tooltip.locator('.macro-person-name')).toHaveText('Person char');
        await expect(tooltip.locator('.macro-person-about')).toHaveText('About char.');
        await expect(tooltip.locator('code')).toHaveText('{{char}}');
        await expect(tooltip.locator('.macro-person-avatar')).toHaveAttribute('src', '/img/ai4.png');
        for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
        await expect(tooltip).toHaveText('{{random::x::y}}Filled in when sent');
        for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
        await expect(tooltip).toHaveText('{{//note}}Sends nothing');
    });

    test('a pill\'s tooltip near the editor\'s right edge stays in the window', async ({ page }) => {
        await page.setViewportSize({ width: 640, height: 600 });
        await mountWithMacros(page, `${'word '.repeat(13)}{{random::a long first choice::a long second choice}}`);
        await page.locator('#liveEditorTestHost .cm-content').click();
        await page.keyboard.press('End');
        const tooltip = page.locator('.macro-tooltip:popover-open');
        await expect(tooltip).toBeVisible();
        const box = await tooltip.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(640);
    });

    test('a pill in rendered text and one in the editor show the same tooltip on hover, in the top layer', async ({ page }) => {
        await mountWithMacros(page, 'In the editor {{char}} and {{random::x::y}}.', { person: true });
        await page.evaluate(async () => {
            const { insertMacroPills } = await import('/scripts/macro-pill.js');
            const { substituteSafeMacros } = await import('/scripts/safe-macros.js');
            const { substituteParams } = await import('/script.js');
            const { text, macros } = substituteSafeMacros('Rendered {{char}} and {{random::x::y}}.', substituteParams, { name2Override: 'Testchar' });
            const preview = document.createElement('div');
            preview.id = 'renderedPillTest';
            // Clipped by what holds it, as a drawer clips its preview: the tooltip isn't.
            preview.style.cssText = 'overflow:hidden;height:1.6em;margin-top:220px';
            preview.innerHTML = insertMacroPills(text, macros, s => s.join(''),
                name => ({ name: `Person ${name}`, avatarUrl: '/img/ai4.png', about: `About ${name}.` }));
            document.getElementById('liveEditorTestHost').append(preview);
        });
        const tooltip = page.locator('.macro-tooltip:popover-open');
        const shown = async (/** @type {import('@playwright/test').Locator} */ pill) => {
            await pill.hover();
            await expect(tooltip).toBeVisible();
            const box = await tooltip.boundingBox();
            const pillBox = await pill.boundingBox();
            expect(box.y + box.height).toBeLessThanOrEqual(pillBox.y + 1);
            const content = await tooltip.evaluate(el => el.innerHTML);
            await page.mouse.move(0, 0);
            await expect(tooltip).toHaveCount(0);
            return content;
        };
        const editor = page.locator('#liveEditorTestHost .cm-content .macro-pill');
        const rendered = page.locator('#renderedPillTest .macro-pill');
        expect(await shown(rendered.nth(0))).toEqual(await shown(editor.nth(0)));
        expect(await shown(rendered.nth(1))).toEqual(await shown(editor.nth(1)));
        await rendered.nth(1).hover();
        await expect(tooltip).toHaveText('{{random::x::y}}Filled in when sent');
        expect(await rendered.nth(1).getAttribute('title')).toBeNull();
    });

    test('"@" offers who can be mentioned by name, and picking one puts in its macro', async ({ page }) => {
        await mountWithMacros(page, 'Hi', { person: true });
        await page.locator('#liveEditorTestHost .cm-content').click();
        await page.keyboard.press('End');
        await page.keyboard.type(' @');
        const list = page.locator('#liveEditorTestHost .cm-tooltip-autocomplete li');
        await expect(list).toHaveText(['Person user{{user}}', 'Person char{{char}}']);
        // Each with its avatar, as a mention list shows them.
        await expect(list.locator('img.live-mention-avatar')).toHaveCount(2);
        await expect(list.first().locator('img.live-mention-avatar')).toHaveAttribute('src', '/img/ai4.png');
        await page.keyboard.type('ch');
        await expect(list).toHaveText(['Person char{{char}}']);
        await page.keyboard.press('Enter');
        await expect(page.locator('#liveEditorTestTextarea')).toHaveValue('Hi {{char}}');
        await expect(page.locator('#liveEditorTestHost .macro-pill')).toHaveText(['Testchar']);
        // Inside a word (an address), "@" is only a character.
        await page.keyboard.type(' a@');
        await page.waitForTimeout(300);
        await expect(list).toHaveCount(0);
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
        await expect(page.locator('#liveEditorTestHost .macro-pill')).toHaveText(['Testchar', /./]);
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

    test('each macro has its own color, as light as the text, the same in the editor and in a preview', async ({ page }) => {
        const macros = ['{{user}}', '{{char}}', '{{description}}', '{{lastMessageId}}', '{{time}}', '{{random::a::b}}', '{{getvar::x}}'];
        await mountWithMacros(page, macros.join(' '));
        const pills = page.locator('#liveEditorTestHost .cm-line .macro-pill');
        await expect(pills).toHaveCount(macros.length);
        const colors = await pills.evaluateAll(els => els.map(el => getComputedStyle(el).color));
        expect(new Set(colors).size).toBe(macros.length);
        // Every one has the text color's lightness.
        const textLightness = await page.evaluate(() => {
            const probe = document.createElement('span');
            probe.style.color = 'oklch(from var(--SmartThemeBodyColor) l 0 0)';
            document.body.append(probe);
            const color = getComputedStyle(probe).color;
            probe.remove();
            return color.match(/oklch\(([\d.]+)/)?.[1];
        });
        expect(colors.map(color => color.match(/oklch\(([\d.]+)/)?.[1])).toEqual(Array(macros.length).fill(textLightness));
        // {{user}} and {{char}} far apart.
        const hue = (/** @type {string} */ color) => Number(color.match(/oklch\([\d.]+ [\d.]+ ([\d.]+)/)?.[1]);
        const apart = Math.abs(hue(colors[0]) - hue(colors[1]));
        expect(Math.min(apart, 360 - apart)).toBeGreaterThan(90);
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
            const found = [...holder.querySelectorAll('.macro-pill')].map(el => getComputedStyle(el).color);
            holder.remove();
            return found;
        });
        expect(preview).toEqual([colors[0], colors[2], colors[4], colors[6], colors[5]]);
    });

    test('the macro colors editor sets the scheme, the chroma and a macro\'s own color, applied at once and saved', async ({ page }) => {
        await mountWithMacros(page, '{{user}} and {{char}}');
        const pills = page.locator('#liveEditorTestHost .cm-line .macro-pill');
        await expect(pills).toHaveCount(2);
        const colorsOf = () => pills.evaluateAll(els => els.map(el => getComputedStyle(el).color));
        const before = await colorsOf();
        await page.locator('#macro_colors_button').evaluate(el => /** @type {HTMLElement} */ (el).click());
        const editor = page.locator('.macro-colors-editor');
        await expect(editor).toBeVisible();
        await expect(editor.locator('.macro-colors-row .macro-pill[data-macro-name="char"]')).toBeVisible();
        // A macro's own color.
        const charRow = editor.locator('.macro-colors-row').filter({ has: page.locator('.macro-pill[data-macro-name="char"]') });
        await charRow.locator('input[type="color"]').evaluate(el => {
            const input = /** @type {HTMLInputElement} */ (el);
            input.value = '#ff0000';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await expect.poll(async () => (await colorsOf())[1]).toBe('rgb(255, 0, 0)');
        expect((await colorsOf())[0]).toBe(before[0]);
        // The chroma for all.
        await editor.locator('input[aria-label="Colorfulness"]').evaluate(el => {
            const input = /** @type {HTMLInputElement} */ (el);
            input.value = '0';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await expect.poll(async () => (await colorsOf())[0]).toMatch(/^oklch\([\d.]+ 0 /);
        const saved = await page.evaluate(async () => {
            const { power_user, getThemeObject } = await import('/scripts/power-user.js');
            return [power_user.macro_colors, getThemeObject('x').macro_colors];
        });
        expect(saved[0]).toMatchObject({ chroma: 0, overrides: { char: { color: '#ff0000' } } });
        expect(saved[1]).toEqual(saved[0]);
        // Back to the default.
        await editor.getByRole('button', { name: 'Reset all' }).click();
        await expect.poll(colorsOf).toEqual(before);
        await page.keyboard.press('Escape');
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
