import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { connectOpenAICompat, startOpenAICompat } from './openai-mock.js';

test('the connection test sends one reply request with no chat open, and nothing else', async ({ page }) => {
    const mock = await startOpenAICompat();
    try {
        await testSetup.awaitST({ page });
        await connectOpenAICompat(page, mock.url);
        /** @type {string[]} */
        const generationRequests = [];
        page.on('request', request => { if (request.url().includes('/api/generation/')) generationRequests.push(new URL(request.url()).pathname); });
        await page.locator('#API-status-top').click();
        await page.locator('#test_api_button').click();
        await expect(page.locator('.toast-success')).toContainText('API connection successful!');
        expect(generationRequests).toEqual(['/api/generation/raw']);
        const completion = mock.log.filter(entry => entry.url.includes('/chat/completions')).at(-1);
        expect(completion?.body.messages).toEqual([{ role: 'user', content: 'Hi' }]);
    } finally {
        await mock.close();
    }
});

test('/tokens is one request to the server\'s count, with the connection it chooses', async ({ page }) => {
    const mock = await startOpenAICompat();
    try {
        await testSetup.awaitST({ page });
        await connectOpenAICompat(page, mock.url);
        /** @type {string[]} */
        const tokenizerRequests = [];
        page.on('request', request => { if (request.url().includes('/api/tokenizers/')) tokenizerRequests.push(new URL(request.url()).pathname); });
        // @ts-ignore
        const result = await page.evaluate(async () => (await stTest.context().executeSlashCommandsWithOptions('/tokens The lantern never goes out.')).pipe);
        expect(Number(result)).toBeGreaterThan(0);
        expect(tokenizerRequests).toEqual(['/api/tokenizers/count']);
    } finally {
        await mock.close();
    }
});
