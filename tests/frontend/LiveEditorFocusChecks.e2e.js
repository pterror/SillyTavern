import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

test.describe('focus checks with a live editor mounted', () => {
    test.beforeEach(testSetup.awaitST);
    test.afterEach(async ({ page }) => {
        await page.evaluate(() => {
            // @ts-ignore
            window.liveEditorTest?.editor.destroy();
        });
    });

    test('Enter in the chat box\'s editor does what it does in the plain chat box', async ({ page }) => {
        await expect(page.locator('#send_form .cm-editor')).toHaveCount(1, { timeout: 30000 });
        await page.evaluate(async () => {
            const { unmountChatEditor } = await import('/scripts/chat-live-editor.js');
            unmountChatEditor(/** @type {HTMLTextAreaElement} */ (document.getElementById('send_textarea')));
        });
        await expect(page.locator('#send_form .cm-editor')).toHaveCount(0);
        await page.evaluate(async () => {
            const { userInputGenerateMutex } = await import('/script.js');
            const send = userInputGenerateMutex.callback;
            window['__sendsStarted'] = [];
            userInputGenerateMutex.callback = (...args) => {
                window['__sendsStarted'].push(/** @type {HTMLTextAreaElement} */ (document.getElementById('send_textarea')).value);
                return send(...args);
            };
        });
        const pressEnterAfter = async (/** @type {boolean} */ withEditor) => {
            await page.evaluate(async (withEditor) => {
                const { power_user } = await import('/scripts/power-user.js');
                power_user.send_on_enter = 1;
                const textarea = /** @type {HTMLTextAreaElement} */ (document.getElementById('send_textarea'));
                textarea.value = '';
                window['__sendsStarted'] = [];
                if (withEditor) {
                    const registry = await import('/scripts/live-editor/registry.js');
                    const editor = await registry.mountLiveEditor(textarea, { formatting: false, search: false });
                    editor.view.focus();
                    // @ts-ignore
                    window.liveEditorTest = { editor };
                } else {
                    textarea.focus();
                }
            }, withEditor);
            await page.keyboard.type('hello');
            await page.keyboard.press('Enter');
            await expect.poll(() => page.evaluate(async () => (await import('/script.js')).userInputGenerateMutex.isBusy), { timeout: 30000 }).toBe(false);
            const sends = await page.evaluate(() => window['__sendsStarted']);
            await page.evaluate(() => {
                // @ts-ignore
                window.liveEditorTest?.editor.destroy();
                // @ts-ignore
                window.liveEditorTest = null;
            });
            return sends;
        };
        expect(await pressEnterAfter(false)).toEqual(['hello']);
        expect(await pressEnterAfter(true)).toEqual(['hello']);
    });

    test('a message being edited in an editor keeps the chat where it was as it grows', async ({ page }) => {
        await page.evaluate(async () => {
            // @ts-ignore
            const ctx = SillyTavern.getContext();
            await ctx.executeSlashCommandsWithOptions('/go Seraphina');
        });
        await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
        await page.evaluate(async () => {
            // @ts-ignore
            const ctx = SillyTavern.getContext();
            for (let i = 0; i < 6; i++) await ctx.SlashCommandParser.commands['send'].callback({}, `filler ${i}\n\n`.repeat(8));
        });
        const chat = page.locator('#chat');
        const firstMes = page.locator('#chat .mes[mesid="0"]');
        await firstMes.locator('.mes_edit').click();
        await expect(firstMes.locator('.cm-editor')).toBeVisible();
        await page.evaluate(() => {
            document.getElementById('chat').scrollTop = 0;
        });
        await firstMes.locator('.cm-content').click();
        await page.keyboard.press('Control+End');
        await page.evaluate(() => {
            document.getElementById('chat').scrollTop = 0;
        });
        const before = await chat.evaluate(el => el.scrollTop);
        for (let i = 0; i < 8; i++) await page.keyboard.press('Enter');
        await page.waitForTimeout(100);
        expect(await chat.evaluate(el => el.scrollTop)).toBe(before);
        await firstMes.locator('.mes_edit_cancel').click();
    });
});
