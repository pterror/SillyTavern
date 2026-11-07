import { test, expect } from './fixtures.js';
import { testSetup, chatBox } from './frontent-test-utils.js';
import { startLlamaCpp, createCharacter, openCharacter, connectLlamaCpp } from './llamacpp-mock.js';

for (const streaming of [false, true]) {
    test(`a reply's count comes with the reply, and the counter asks for nothing more (${streaming ? 'streaming' : 'not streaming'})`, async ({ page }) => {
        const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const mock = await startLlamaCpp({ reply: () => `Counted reply ${s}.` });
        try {
            await testSetup.awaitST({ page });
            const avatar = await createCharacter(page, `Count ${s}`, `Greeting ${s}`);
            await openCharacter(page, avatar);
            await connectLlamaCpp(page, mock.url);
            await page.evaluate(async (streaming) => {
                // @ts-ignore
                const context = stTest.context();
                context.powerUserSettings.message_token_count_enabled = true;
                context.textCompletionSettings.streaming = streaming;
                context.saveSettingsDebounced('textgenerationwebui_settings.streaming');
            }, streaming);
            await page.waitForTimeout(2500);

            /** @type {string[]} */
            const counted = [];
            page.on('request', (request) => {
                if (new URL(request.url()).pathname === '/api/tokenizers/current/count') counted.push(request.postData() ?? '');
            });
            await chatBox(page).fill(`Hello ${s}`);
            await page.locator('#send_but').click();
            const reply = page.locator('#chat .mes[mesid="2"]');
            await expect(reply.locator('.mes_text')).toContainText(`Counted reply ${s}`, { timeout: 30000 });
            await expect(reply.locator('.tokenCounterDisplay')).toHaveText(/^\d+t$/);
            await page.waitForTimeout(500);
            expect(counted.filter(body => body.includes(`Counted reply ${s}`))).toEqual([]);
            // @ts-ignore
            expect(await page.evaluate(() => typeof stTest.context().chat[2].extra.text_token_count)).toBe('number');
        } finally {
            await mock.close();
        }
    });
}
