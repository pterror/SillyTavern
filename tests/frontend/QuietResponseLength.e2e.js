import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { connectLlamaCpp, createCharacter, openCharacter, startLlamaCpp } from './llamacpp-mock.js';
import { connectOpenAICompat, startOpenAICompat } from './openai-mock.js';

// A quiet prompt's own response length reaches the backend with its request (response_length), and the response
// length setting stays as it was: it's the server's, and a generation doesn't change it.

test('a quiet prompt with a response length asks the backend for that many tokens, and leaves the setting alone', async ({ page }) => {
    const llama = await startLlamaCpp();
    try {
        await testSetup.awaitST({ page });
        await connectLlamaCpp(page, llama.url);
        const avatar = await createCharacter(page, `QuietLength-${Date.now()}`);
        await openCharacter(page, avatar);
        const before = await page.evaluate(async () => (await import('/scripts/generation-params.js')).amount_gen);
        const asked = before + 7;
        await page.evaluate(async (responseLength) => {
            // @ts-ignore
            await SillyTavern.getContext().generateQuietPrompt({ quietPrompt: 'Say hi.', responseLength });
        }, asked);
        const completion = llama.log.filter(entry => entry.url.startsWith('/completion')).at(-1);
        expect(completion?.body.n_predict).toBe(asked);
        expect(await page.evaluate(async () => (await import('/scripts/generation-params.js')).amount_gen)).toBe(before);
    } finally {
        await llama.close();
    }
});

test('the same over chat completion: max_tokens is the quiet prompt\'s, the setting stays', async ({ page }) => {
    const mock = await startOpenAICompat();
    try {
        await testSetup.awaitST({ page });
        await connectOpenAICompat(page, mock.url);
        const avatar = await createCharacter(page, `QuietLengthCC-${Date.now()}`);
        await openCharacter(page, avatar);
        // @ts-ignore
        const before = await page.evaluate(() => SillyTavern.getContext().chatCompletionSettings.openai_max_tokens);
        const asked = before + 7;
        await page.evaluate(async (responseLength) => {
            // @ts-ignore
            await SillyTavern.getContext().generateQuietPrompt({ quietPrompt: 'Say hi.', responseLength });
        }, asked);
        const completion = mock.log.filter(entry => entry.url.includes('/chat/completions')).at(-1);
        expect(completion?.body.max_tokens).toBe(asked);
        // @ts-ignore
        expect(await page.evaluate(() => SillyTavern.getContext().chatCompletionSettings.openai_max_tokens)).toBe(before);
    } finally {
        await mock.close();
    }
});
