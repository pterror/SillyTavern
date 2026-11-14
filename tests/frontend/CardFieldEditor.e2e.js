import { test, expect } from './fixtures.js';
import { testSetup, openInfoTab, pasteInto } from './frontent-test-utils.js';

/**
 * @param {import('@playwright/test').Page} page
 * @param {Record<string, string>} values
 * @returns {Promise<string>}
 */
async function createAndOpen(page, values) {
    const avatar = await page.evaluate(async (values) => {
        // @ts-ignore
        const ctx = stTest.context();
        const form = new FormData();
        form.append('ch_name', `LiveCard-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
        form.append('first_mes', 'Greeting');
        for (const [key, value] of Object.entries(values)) form.append(key, value);
        const headers = ctx.getRequestHeaders();
        delete headers['Content-Type'];
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        return (await response.text()).trim();
    }, values);
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        await stTest.context().selectCharacterById(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar);
    return avatar;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function stored(page, avatar) {
    return page.evaluate(async (avatar) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders();
        const response = await fetch('/api/characters/get', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar }) });
        return (await response.json()).data;
    }, avatar);
}

test.describe('card fields edit in the editor', () => {
    test.beforeEach(testSetup.awaitST);

    test('the pencil opens the editor on the field; typing and ✓ save, and the preview shows the result', async ({ page }) => {
        const avatar = await createAndOpen(page, { description: 'Old *text*.' });
        await openInfoTab(page, 'description');
        await page.locator('.field_edit_toggle[data-for="description_textarea"]').click();
        const editor = page.locator('#charInfoTab_description .cm-editor');
        await expect(editor).toBeVisible();
        await expect(page.locator('#description_textarea')).toBeHidden();
        await expect(page.locator('.field_preview[data-for="description_textarea"]')).toBeHidden();
        await page.keyboard.press('Control+End');
        await page.keyboard.type(' New **bold**.');
        await page.locator('.field_edit_done[data-for="description_textarea"]').click();
        await expect(editor).toHaveCount(0);
        await expect(page.locator('.field_preview[data-for="description_textarea"] strong')).toHaveText('bold');
        await expect.poll(async () => (await stored(page, avatar)).description).toBe('Old *text*. New **bold**.');
    });

    test('double-clicking a word in the preview starts the edit in that word, past markup and list numbers', async ({ page }) => {
        const description = '1. First *item* here\n2. Second **item** with the target word\n\n> the target again';
        await createAndOpen(page, { description });
        await openInfoTab(page, 'description');
        const preview = page.locator('.field_preview[data-for="description_textarea"]');
        await expect(preview.locator('li')).toHaveCount(2);
        await expect(preview.locator('li').nth(1)).toBeVisible();
        const top = () => preview.evaluate(el => Math.round(el.getBoundingClientRect().top));
        const seen = [];
        await expect.poll(async () => {
            seen.push(await top());
            return seen.length >= 3 && seen.slice(-3).every(v => v === seen.at(-1));
        }, { intervals: [250], timeout: 15000 }).toBe(true);
        for (const k of [0, 1]) {
            const point = await preview.evaluate((el, k) => {
                const found = [];
                const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
                for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                    let i = -1;
                    while ((i = String(n.textContent).indexOf('target', i + 1)) >= 0) found.push({ n, i });
                }
                const range = document.createRange();
                range.setStart(found[k].n, found[k].i + 3);
                range.setEnd(found[k].n, found[k].i + 4);
                const b = range.getBoundingClientRect();
                return { x: b.left + 1, y: b.top + b.height / 2 };
            }, k);
            await page.mouse.dblclick(point.x, point.y);
            const editor = page.locator('#charInfoTab_description .cm-editor');
            await expect(editor).toBeVisible();
            const head = await page.evaluate(async () => {
                const lib = await import('/live-editor-lib.js');
                const view = lib.view.EditorView.findFromDOM(/** @type {HTMLElement} */ (document.querySelector('#charInfoTab_description .cm-editor')));
                return view?.state.selection.main.head;
            });
            expect(head).toBe([...description.matchAll(/target/g)][k].index + 3);
            await page.locator('.field_edit_cancel[data-for="description_textarea"]').click();
            await expect(editor).toHaveCount(0);
        }
    });

    test('Escape with the macro suggestions open closes them and keeps editing', async ({ page }) => {
        await createAndOpen(page, { scenario: 'x' });
        await openInfoTab(page, 'scenario');
        await page.locator('.field_edit_toggle[data-for="scenario_pole"]').click();
        await expect(page.locator('#charInfoTab_scenario .cm-editor')).toBeVisible();
        await page.keyboard.press('Control+End');
        await page.keyboard.type(' {{cha');
        await expect(page.locator('#charInfoTab_scenario .cm-tooltip-autocomplete')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator('#charInfoTab_scenario .cm-tooltip-autocomplete')).toHaveCount(0);
        await expect(page.locator('#charInfoTab_scenario .cm-editor')).toBeVisible();
        await page.locator('.field_edit_cancel[data-for="scenario_pole"]').click();
    });

    test('Ctrl+Enter saves without adding a line', async ({ page }) => {
        const avatar = await createAndOpen(page, { personality: 'kind' });
        await openInfoTab(page, 'personality');
        await page.locator('.field_edit_toggle[data-for="personality_textarea"]').click();
        await expect(page.locator('#charInfoTab_personality .cm-editor')).toBeVisible();
        await page.keyboard.press('Control+End');
        await page.keyboard.type(' and brave');
        await page.keyboard.press('Control+Enter');
        await expect(page.locator('#charInfoTab_personality .cm-editor')).toHaveCount(0);
        await expect.poll(async () => (await stored(page, avatar)).personality).toBe('kind and brave');
    });

    test('a macro is a pill showing its value, deleted whole by Backspace; {{ suggests macros', async ({ page }) => {
        const avatar = await createAndOpen(page, { scenario: 'Meet {{char}}' });
        await openInfoTab(page, 'scenario');
        await page.locator('.field_edit_toggle[data-for="scenario_pole"]').click();
        const editor = page.locator('#charInfoTab_scenario .chat-editor');
        const name = await page.locator('#character_name_pole').inputValue();
        await expect(editor.locator('.macro-pill')).toHaveText(name);
        await page.keyboard.press('Control+End');
        await page.keyboard.press('Backspace');
        await expect(page.locator('#scenario_pole')).toHaveValue('Meet ');
        await page.keyboard.type('{{us');
        await expect(editor.locator('.cm-tooltip-autocomplete')).toBeVisible();
        await page.locator('.field_edit_cancel[data-for="scenario_pole"]').click();
        await expect.poll(async () => (await stored(page, avatar)).scenario).toBe('Meet {{char}}');
    });

    test('the markdown keys format the text when they are on, and do nothing when off', async ({ page }) => {
        await createAndOpen(page, { personality: 'kind' });
        await openInfoTab(page, 'personality');
        const setKeys = (/** @type {boolean} */ on) => page.evaluate(async (on) => {
            const { power_user } = await import('/scripts/power-user.js');
            const was = power_user.enable_md_hotkeys;
            power_user.enable_md_hotkeys = on;
            return was;
        }, on);
        const was = await setKeys(true);
        try {
            await page.locator('.field_edit_toggle[data-for="personality_textarea"]').click();
            await expect(page.locator('#charInfoTab_personality .cm-content')).toBeFocused();
            await page.keyboard.press('Control+a');
            await page.keyboard.press('Control+b');
            await expect(page.locator('#personality_textarea')).toHaveValue('**kind**');
            await page.keyboard.press('Control+b');
            await expect(page.locator('#personality_textarea')).toHaveValue('kind');
            await setKeys(false);
            await page.keyboard.press('Control+b');
            await expect(page.locator('#personality_textarea')).toHaveValue('kind');
            await page.locator('.field_edit_cancel[data-for="personality_textarea"]').click();
        } finally {
            await setKeys(was);
        }
    });

    test.describe('a paste', () => {
        const HTML = '<p>Hello <b>bold</b> and <i>it</i>.</p>';
        const PLAIN = 'Hello bold and it.';
        const MARKDOWN = 'Hello **bold** and *it*.';

        /** @param {import('@playwright/test').Page} page */
        async function editPersonality(page) {
            await createAndOpen(page, { personality: 'Before' });
            await openInfoTab(page, 'personality');
            await page.locator('.field_edit_toggle[data-for="personality_textarea"]').click();
            await expect(page.locator('#charInfoTab_personality .cm-content')).toBeFocused();
            await page.keyboard.press('Control+End');
            await page.keyboard.type(' ');
            return page.locator('#charInfoTab_personality .cm-content');
        }
        const value = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#personality_textarea').inputValue();

        test('shows how it went in, beside the cursor; each way replaces exactly the paste', async ({ page }) => {
            const content = await editPersonality(page);
            await pasteInto(content, { 'text/html': HTML, 'text/plain': PLAIN });
            expect(await value(page)).toBe(`Before ${MARKDOWN}`);
            const picker = page.locator('#charInfoTab_personality .paste-picker');
            await expect(picker.locator('.paste-picker-toggle')).toContainText('Keep formatting');
            const end = await page.evaluate(async () => {
                const lib = await import('/live-editor-lib.js');
                const view = lib.view.EditorView.findFromDOM(/** @type {HTMLElement} */ (document.querySelector('#charInfoTab_personality .cm-editor')));
                return view?.coordsAtPos(view.state.doc.length)?.top;
            });
            expect(Math.abs(((await picker.boundingBox())?.y ?? 0) - (end ?? 0))).toBeLessThan(80);

            await picker.locator('.paste-picker-toggle').click();
            await expect(picker.locator('.paste-picker-item')).toHaveText(['Text only', 'Keep formatting', 'Keep as HTML']);
            await picker.locator('.paste-picker-item[data-mode="html"]').click();
            expect(await value(page)).toBe(`Before ${HTML}`);
            await expect(content).toBeFocused();
            await page.locator('.field_edit_cancel[data-for="personality_textarea"]').click();
        });

        test('Ctrl+Alt+V cycles the ways, one undo goes back one way, Escape dismisses the picker', async ({ page }) => {
            const content = await editPersonality(page);
            await pasteInto(content, { 'text/html': HTML, 'text/plain': PLAIN });
            const toggle = page.locator('#charInfoTab_personality .paste-picker-toggle');
            await page.keyboard.press('Control+Alt+v');
            expect(await value(page)).toBe(`Before ${HTML}`);
            await page.keyboard.press('Control+Alt+v');
            expect(await value(page)).toBe(`Before ${PLAIN}`);
            await expect(toggle).toContainText('Text only');
            await page.keyboard.press('Control+z');
            expect(await value(page)).toBe(`Before ${HTML}`);
            await expect(toggle).toContainText('Keep as HTML');
            await page.keyboard.press('Escape');
            await expect(toggle).toHaveCount(0);
            await expect(content).toBeFocused();
            await page.locator('.field_edit_cancel[data-for="personality_textarea"]').click();
        });

        test('typing after it takes the picker away', async ({ page }) => {
            const content = await editPersonality(page);
            await pasteInto(content, { 'text/html': HTML, 'text/plain': PLAIN });
            await expect(page.locator('#charInfoTab_personality .paste-picker')).toBeVisible();
            await page.keyboard.type('!');
            await expect(page.locator('#charInfoTab_personality .paste-picker')).toHaveCount(0);
            await page.locator('.field_edit_cancel[data-for="personality_textarea"]').click();
        });

        test('an address pasted over selected text makes it a link, which the picker can put back as the address', async ({ page }) => {
            const content = await editPersonality(page);
            await page.keyboard.type('the docs');
            await page.keyboard.press('Control+Shift+ArrowLeft');
            await page.keyboard.press('Control+Shift+ArrowLeft');
            await pasteInto(content, { 'text/plain': 'https://example.com/a_(b)' });
            expect(await value(page)).toBe('Before [the docs](https://example.com/a_%28b%29)');
            await page.keyboard.press('Control+Alt+v');
            expect(await value(page)).toBe('Before https://example.com/a_(b)');
            await page.locator('.field_edit_cancel[data-for="personality_textarea"]').click();
        });

        test('an address pasted with nothing selected goes in as it is', async ({ page }) => {
            const content = await editPersonality(page);
            await pasteInto(content, { 'text/plain': 'https://example.com/' });
            expect(await value(page)).toBe('Before https://example.com/');
            await expect(page.locator('#charInfoTab_personality .paste-picker')).toHaveCount(0);
            await page.locator('.field_edit_cancel[data-for="personality_textarea"]').click();
        });
    });

    test('its toolbar holds every formatting command and find and replace when none are chosen', async ({ page }) => {
        await createAndOpen(page, { personality: 'kind' });
        await openInfoTab(page, 'personality');
        await page.locator('.field_edit_toggle[data-for="personality_textarea"]').click();
        const tools = page.locator('#charInfoTab_personality .chat-editor-toolbar button');
        await expect(tools).toHaveCount(12);
        await expect(tools.last()).toHaveAttribute('data-tool', 'find');
        await expect(page.locator('#charInfoTab_personality .chat-editor-toolbar button[data-tool="presets"]')).toHaveCount(0);
        await page.locator('#charInfoTab_personality .chat-editor-toolbar button[data-tool="find"]').click();
        await expect(page.locator('#charInfoTab_personality .cm-search')).toBeVisible();
        await page.locator('.field_edit_cancel[data-for="personality_textarea"]').click();
    });
});
