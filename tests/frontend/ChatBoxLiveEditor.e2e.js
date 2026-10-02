import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// The chat box gets the live editor once the page is idle after loading, only while it doesn't have focus, and its
// toolbar shows only while the user is in it.

/** @param {import('@playwright/test').Page} page */
async function openChat(page) {
    await page.evaluate(async () => {
        // @ts-ignore
        await SillyTavern.getContext().executeSlashCommandsWithOptions('/go Seraphina');
    });
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
}

/** @param {import('@playwright/test').Page} page */
function chatBoxEditor(page) {
    return page.locator('#send_form .cm-editor');
}

/** @param {import('@playwright/test').Page} page */
async function clearChatBox(page) {
    await page.evaluate(() => {
        // @ts-ignore
        $('#send_textarea').val('').trigger('input');
    });
}

/** @param {import('@playwright/test').Page} page */
function chatBoxValue(page) {
    return page.evaluate(() => /** @type {HTMLTextAreaElement} */ (document.getElementById('send_textarea')).value);
}

/**
 * Holds back the editor's code until `release()` is called, so a test can act before the editor is ready.
 * @param {import('@playwright/test').Page} page
 */
async function holdEditorCode(page) {
    /** @type {() => void} */
    let release = () => {};
    const released = new Promise(resolve => { release = () => resolve(undefined); });
    await page.route('**/live-editor-lib.js*', async (route) => {
        await released;
        await route.continue();
    });
    return release;
}

test.describe('the chat box with the live editor', () => {
    test('it has the editor while unfocused, its toolbar only shows while the user is in it, and typing reaches the text box', async ({ page }) => {
        await testSetup.awaitST({ page });
        await openChat(page);
        const editor = chatBoxEditor(page);
        await expect(editor).toHaveCount(1, { timeout: 10000 });
        await expect(page.locator('#send_textarea')).toHaveClass(/live-editor-textarea/);
        await expect(editor.locator('.live-toolbar')).toBeHidden();
        await editor.locator('.cm-content').click();
        await expect(editor.locator('.live-toolbar')).toBeVisible();
        await page.keyboard.type('Hello *there*');
        expect(await chatBoxValue(page)).toBe('Hello *there*');
        await page.locator('#chat .mes[mesid="0"] .mes_text').click();
        await expect(editor.locator('.live-toolbar')).toBeHidden();
        await expect(editor).toHaveCount(1);
        expect(await chatBoxValue(page)).toBe('Hello *there*');
        await clearChatBox(page);
    });

    test('keys typed before the editor is ready all land, and the editor goes on only once the chat box loses focus', async ({ page }) => {
        const release = await holdEditorCode(page);
        await testSetup.awaitST({ page });
        await openChat(page);
        await expect(chatBoxEditor(page)).toHaveCount(0);
        await page.locator('#send_textarea').click();
        const first = 'typed in the plain box ';
        await page.keyboard.type(first);
        release();
        // The editor's code arrives while the user is typing: it waits, and every key keeps landing in the box.
        await page.evaluate(() => import('/scripts/live-editor/mount.js'));
        const second = 'and still typing after it loaded';
        await page.keyboard.type(second);
        expect(await chatBoxValue(page)).toBe(first + second);
        await expect(chatBoxEditor(page)).toHaveCount(0);
        await expect(page.locator('#send_textarea')).toBeFocused();
        // Put the cursor in the middle, then leave: the editor goes on with the text and the cursor where they were.
        await page.evaluate(() => {
            const box = /** @type {HTMLTextAreaElement} */ (document.getElementById('send_textarea'));
            box.setSelectionRange(5, 10);
        });
        await page.locator('#chat .mes[mesid="0"] .mes_text').click();
        await expect(chatBoxEditor(page)).toHaveCount(1);
        expect(await chatBoxValue(page)).toBe(first + second);
        await expect(chatBoxEditor(page).locator('.cm-content')).toHaveText(first + second);
        expect(await page.evaluate(() => {
            const box = /** @type {HTMLTextAreaElement} */ (document.getElementById('send_textarea'));
            return [box.selectionStart, box.selectionEnd];
        })).toEqual([5, 10]);
        await clearChatBox(page);
    });

    test('typing right after clicking into the chat box loses nothing', async ({ page }) => {
        await testSetup.awaitST({ page });
        await openChat(page);
        const editor = chatBoxEditor(page);
        await expect(editor).toHaveCount(1, { timeout: 10000 });
        for (let round = 0; round < 3; round++) {
            const text = `round ${round}: the quick brown fox jumps over the lazy dog`;
            await editor.locator('.cm-content').click();
            await page.keyboard.type(text);
            expect(await chatBoxValue(page)).toBe(text);
            await page.locator('#chat .mes[mesid="0"] .mes_text').click();
            await clearChatBox(page);
        }
    });

    test('Enter sends the message, as in the plain chat box', async ({ page }) => {
        await testSetup.awaitST({ page });
        await openChat(page);
        await expect(chatBoxEditor(page)).toHaveCount(1, { timeout: 10000 });
        await page.evaluate(async () => {
            const { power_user } = await import('/scripts/power-user.js');
            power_user.send_on_enter = 1;
        });
        await chatBoxEditor(page).locator('.cm-content').click();
        await page.keyboard.type('sent from the editor');
        await page.keyboard.press('Enter');
        await expect.poll(() => page.evaluate(() => {
            // @ts-ignore
            return SillyTavern.getContext().chat.some(m => m.is_user && m.mes === 'sent from the editor');
        })).toBe(true);
        await expect.poll(() => chatBoxValue(page)).toBe('');
        // Empty again: the editor shows the chat box's placeholder.
        await expect(chatBoxEditor(page).locator('.cm-placeholder')).toBeVisible();
        await page.evaluate(() => {
            // @ts-ignore
            SillyTavern.getContext().stopGeneration?.();
        });
    });

    test('Shift+Enter adds a line instead of sending', async ({ page }) => {
        await testSetup.awaitST({ page });
        await openChat(page);
        await expect(chatBoxEditor(page)).toHaveCount(1, { timeout: 10000 });
        await chatBoxEditor(page).locator('.cm-content').click();
        await page.keyboard.type('one');
        await page.keyboard.press('Shift+Enter');
        await page.keyboard.type('two');
        expect(await chatBoxValue(page)).toBe('one\ntwo');
        await clearChatBox(page);
    });

    test('code writing the chat box shows in the editor, and reads give the text', async ({ page }) => {
        await testSetup.awaitST({ page });
        await openChat(page);
        await expect(chatBoxEditor(page)).toHaveCount(1, { timeout: 10000 });
        await chatBoxEditor(page).locator('.cm-content').click();
        await page.keyboard.type('typed');
        await page.evaluate(() => {
            // @ts-ignore
            $('#send_textarea').val('written by code').trigger('input');
        });
        await expect(chatBoxEditor(page).locator('.cm-content')).toHaveText('written by code');
        expect(await chatBoxValue(page)).toBe('written by code');
        await clearChatBox(page);
    });

    test('the slash command suggestions show above the editor and take their keys', async ({ page }) => {
        await testSetup.awaitST({ page });
        await openChat(page);
        const editor = chatBoxEditor(page);
        await expect(editor).toHaveCount(1, { timeout: 10000 });
        await editor.locator('.cm-content').click();
        await page.keyboard.type('/sen');
        const list = page.locator('.autoComplete-wrap');
        await expect(list).toBeVisible();
        const editorTop = (await editor.boundingBox()).y;
        const listBox = await list.boundingBox();
        expect(listBox.y + listBox.height).toBeLessThanOrEqual(editorTop + 2);
        expect(listBox.y + listBox.height).toBeGreaterThan(editorTop - 40);
        await page.keyboard.press('Tab');
        await expect.poll(() => chatBoxValue(page)).toMatch(/^\/sen\S+/);
        await clearChatBox(page);
    });

    test('a macro away from the cursor shows its value', async ({ page }) => {
        await testSetup.awaitST({ page });
        await openChat(page);
        const user = await page.evaluate(() => {
            // @ts-ignore
            return SillyTavern.getContext().name1;
        });
        await expect(chatBoxEditor(page)).toHaveCount(1, { timeout: 10000 });
        await chatBoxEditor(page).locator('.cm-content').click();
        await page.keyboard.type('Hi {{user}}');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Shift+Enter');
        await page.keyboard.type('next');
        await expect(chatBoxEditor(page).locator('.macro-substituted')).toHaveText(user);
        await clearChatBox(page);
    });

    test('text composed with an IME lands whole, and the rest of the box renders again once it ends', async ({ page }) => {
        await testSetup.awaitST({ page });
        await openChat(page);
        const user = await page.evaluate(() => {
            // @ts-ignore
            return SillyTavern.getContext().name1;
        });
        const errors = [];
        page.on('pageerror', error => errors.push(error));
        await expect(chatBoxEditor(page)).toHaveCount(1, { timeout: 10000 });
        await chatBoxEditor(page).locator('.cm-content').click();
        await page.keyboard.type('Hi {{user}}');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Shift+Enter');
        await page.keyboard.type('*said* ');
        const client = await page.context().newCDPSession(page);
        await client.send('Input.imeSetComposition', { text: 'n', selectionStart: 1, selectionEnd: 1 });
        await client.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
        await client.send('Input.imeSetComposition', { text: 'nihao', selectionStart: 5, selectionEnd: 5 });
        await client.send('Input.insertText', { text: '你好' });
        await expect.poll(() => chatBoxValue(page)).toBe('Hi {{user}}\n*said* 你好');
        await page.keyboard.type('!');
        await expect.poll(() => chatBoxValue(page)).toBe('Hi {{user}}\n*said* 你好!');
        await expect(chatBoxEditor(page).locator('.macro-substituted')).toHaveText(user);
        expect(errors).toEqual([]);
        await clearChatBox(page);
    });
});
