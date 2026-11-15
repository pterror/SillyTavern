import { test, expect } from './fixtures.js';
import { testSetup, chatBox } from './frontent-test-utils.js';
import { connectLlamaCpp, startLlamaCpp } from './llamacpp-mock.js';

test('a message sent with no model to reply is stored, once', async ({ page }) => {
    const model = await startLlamaCpp();
    try {
        await testSetup.awaitST({ page });
        await page.evaluate(async () => {
            // @ts-ignore
            await stTest.context().executeSlashCommandsWithOptions('/go Seraphina');
        });
        await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
        await connectLlamaCpp(page, model.url);
        model.state.failCompletion = true;
        const text = `sent with no reply ${Date.now()}`;
        await chatBox(page).click();
        await page.keyboard.type(text);
        const generate = page.waitForResponse(response => response.url().endsWith('/api/generation/generate'));
        await page.keyboard.press('Enter');
        await (await generate).finished();
        // @ts-ignore
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).userInputGenerateMutex.isBusy)).toBe(false);
        await expect(page.locator('.toast', { hasText: 'couldn\'t be saved' })).toHaveCount(0);

        await page.reload();
        await testSetup.awaitST({ page });
        await page.evaluate(async () => {
            // @ts-ignore
            await stTest.context().executeSlashCommandsWithOptions('/go Seraphina');
        });
        await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
        // @ts-ignore
        await expect.poll(() => page.evaluate(t => stTest.context().chat.filter(m => m.mes === t && m.node_id).length, text)).toBe(1);
    } finally {
        await model.close();
    }
});
