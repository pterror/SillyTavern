import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// A message being edited, and a reasoning block being edited, edit in the live editor.

/**
 * Opens a chat with Seraphina and sends a user message; returns that message's id.
 * @param {import('@playwright/test').Page} page
 * @param {string} text
 */
async function chatWithUserMessage(page, text) {
    await page.evaluate(async () => {
        // @ts-ignore
        await SillyTavern.getContext().executeSlashCommandsWithOptions('/go Seraphina');
    });
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
    return page.evaluate(async (text) => {
        // @ts-ignore
        const ctx = SillyTavern.getContext();
        await ctx.SlashCommandParser.commands['send'].callback({}, text);
        return ctx.chat.length - 1;
    }, text);
}

/** @param {import('@playwright/test').Page} page @param {number} id */
async function storedMessage(page, id) {
    await page.waitForTimeout(300);
    return page.evaluate((id) => {
        // @ts-ignore
        return SillyTavern.getContext().chat[id];
    }, id);
}

/** @param {import('@playwright/test').Page} page @param {boolean} on */
async function setAutoSave(page, on) {
    await page.evaluate(async (on) => {
        const { power_user } = await import('/scripts/power-user.js');
        power_user.auto_save_msg_edits = on;
    }, on);
}

test.describe('message edits in the live editor', () => {
    test.beforeEach(testSetup.awaitST);

    test('editing a message opens the editor; typing and Done save, and the message shows the result', async ({ page }) => {
        await setAutoSave(page, false);
        const id = await chatWithUserMessage(page, 'Old *text*.');
        const mes = page.locator(`#chat .mes[mesid="${id}"]`);
        await mes.locator('.mes_edit').click();
        const editor = mes.locator('.cm-editor');
        await expect(editor).toBeVisible();
        await expect(page.locator('#curEditTextarea')).toHaveClass(/live-editor-textarea/);
        await page.keyboard.press('Control+End');
        await page.keyboard.type(' New **bold**.');
        await mes.locator('.mes_edit_done').click();
        await expect(page.locator('#chat .cm-editor')).toHaveCount(0);
        await expect(mes.locator('.mes_text strong')).toHaveText('bold');
        expect((await storedMessage(page, id)).mes).toBe('Old *text*. New **bold**.');
    });

    test('off the line being edited, the text is drawn as the message is', async ({ page }) => {
        await setAutoSave(page, false);
        const id = await chatWithUserMessage(page, 'First **strong** line.\n\nSecond line.');
        const mes = page.locator(`#chat .mes[mesid="${id}"]`);
        await mes.locator('.mes_edit').click();
        await expect(mes.locator('.cm-editor')).toBeVisible();
        await page.keyboard.press('Control+End');
        await expect(mes.locator('.cm-editor strong')).toHaveText('strong');
        await mes.locator('.mes_edit_cancel').click();
    });

    test('Cancel takes the editor away and keeps the stored text', async ({ page }) => {
        await setAutoSave(page, false);
        const id = await chatWithUserMessage(page, 'Keep me.');
        const mes = page.locator(`#chat .mes[mesid="${id}"]`);
        await mes.locator('.mes_edit').click();
        await expect(mes.locator('.cm-editor')).toBeVisible();
        await page.keyboard.type(' changed');
        await mes.locator('.mes_edit_cancel').click();
        await expect(page.locator('#chat .cm-editor')).toHaveCount(0);
        await expect(mes.locator('.mes_text')).toHaveText('Keep me.');
        expect((await storedMessage(page, id)).mes).toBe('Keep me.');
    });

    test('Ctrl+Enter accepts the edit without adding a line', async ({ page }) => {
        await setAutoSave(page, false);
        const id = await chatWithUserMessage(page, 'One');
        const mes = page.locator(`#chat .mes[mesid="${id}"]`);
        await mes.locator('.mes_edit').click();
        await expect(mes.locator('.cm-editor')).toBeVisible();
        await page.keyboard.press('Control+End');
        await page.keyboard.type(' two');
        await page.keyboard.press('Control+Enter');
        await expect(page.locator('#chat .cm-editor')).toHaveCount(0);
        expect((await storedMessage(page, id)).mes).toBe('One two');
    });

    test('with autosave on, typing in the editor saves the message', async ({ page }) => {
        await setAutoSave(page, true);
        const id = await chatWithUserMessage(page, 'Auto');
        const mes = page.locator(`#chat .mes[mesid="${id}"]`);
        await mes.locator('.mes_edit').click();
        await expect(mes.locator('.cm-editor')).toBeVisible();
        await page.keyboard.press('Control+End');
        await page.keyboard.type(' saved');
        await expect.poll(async () => (await storedMessage(page, id)).mes, { timeout: 5000 }).toBe('Auto saved');
        await mes.locator('.mes_edit_done').click();
        await expect(page.locator('#chat .cm-editor')).toHaveCount(0);
        await setAutoSave(page, false);
    });

    test('a reasoning block being edited opens the editor; Done saves the reasoning', async ({ page }) => {
        await setAutoSave(page, false);
        const id = await chatWithUserMessage(page, 'Message');
        const mes = page.locator(`#chat .mes[mesid="${id}"]`);
        await mes.locator('.mes_edit').click();
        await expect(mes.locator('#curEditTextarea')).toHaveCount(1);
        await mes.locator('.mes_edit_add_reasoning').click();
        const reasoningEditor = mes.locator('.reasoning_edit_textarea + .cm-editor');
        await expect(reasoningEditor).toBeVisible();
        await reasoningEditor.locator('.cm-content').click();
        await page.keyboard.type('Thinking *hard*');
        // While the message is being edited, its Done also accepts the reasoning edit.
        await mes.locator('.mes_edit_done').click();
        await expect(page.locator('#chat .reasoning_edit_textarea')).toHaveCount(0);
        await expect(page.locator('#chat .cm-editor')).toHaveCount(0);
        await expect.poll(async () => (await storedMessage(page, id)).extra?.reasoning).toBe('Thinking *hard*');
    });
});
