import { test, expect } from './fixtures.js';
import { testSetup, chatBox } from './frontent-test-utils.js';
import { startLlamaCpp, createCharacter, openCharacter, connectLlamaCpp } from './llamacpp-mock.js';

test('a setting changed just before a send goes with the send, and the reply is made with it', async ({ page }) => {
    const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const mock = await startLlamaCpp({ reply: () => `Warm reply ${s}.` });
    try {
        await testSetup.awaitST({ page });
        const avatar = await createCharacter(page, `Ride ${s}`, `Greeting ${s}`);
        await openCharacter(page, avatar);
        await connectLlamaCpp(page, mock.url);

        /** @type {{ path: string, body: any }[]} */
        const sent = [];
        page.on('request', (request) => {
            const path = new URL(request.url()).pathname;
            if (path === '/api/generation/generate' || path === '/api/settings/save-partial') sent.push({ path, body: request.postDataJSON() });
        });
        await page.evaluate(() => {
            // @ts-ignore
            const context = stTest.context();
            context.textCompletionSettings.temp = 0.37;
            context.saveSettingsDebounced('textgenerationwebui_settings.temp');
        });
        await chatBox(page).fill(`Hello ${s}`);
        await page.locator('#send_but').click();
        await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText(`Warm reply ${s}`, { timeout: 30000 });
        await page.waitForTimeout(2500);

        expect(sent.map(request => request.path)).toEqual(['/api/generation/generate']);
        expect(sent[0].body.settings_changes?.keys).toEqual({ 'textgenerationwebui_settings.temp': 0.37 });
        const completion = mock.log.filter(entry => entry.url.startsWith('/completion')).at(-1);
        expect(completion?.body.temperature).toBe(0.37);

        // @ts-ignore
        const stored = await page.evaluate(async () => JSON.parse((await (await fetch('/api/settings/get', { method: 'POST', headers: stTest.context().getRequestHeaders(), body: '{}' })).json()).settings));
        expect(stored.textgenerationwebui_settings.temp).toBe(0.37);
    } finally {
        await mock.close();
    }
});
