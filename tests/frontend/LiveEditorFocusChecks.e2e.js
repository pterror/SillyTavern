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

    test('a message being edited in an editor keeps the chat where it was as it grows', async ({ page }) => {
        await page.evaluate(async () => {
            // @ts-ignore
            const ctx = stTest.context();
            await ctx.executeSlashCommandsWithOptions('/go Seraphina');
        });
        await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
        await page.evaluate(async () => {
            // @ts-ignore
            const ctx = stTest.context();
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
