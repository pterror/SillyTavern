import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

test.describe('nothing a test asks for reaches past loopback, and what it asks is told', () => {
    test('a request from the page is refused and told', async ({ page, pastLoopback }) => {
        await testSetup.awaitST({ page });
        expect(await page.evaluate(() => fetch('https://example.com/').then(() => 'answered', () => 'refused'))).toBe('refused');
        expect(pastLoopback.take()).toEqual(['the page asked for https://example.com/']);
    });

    test('a request the server makes for the page is refused and told', async ({ page, pastLoopback }) => {
        await testSetup.awaitST({ page });
        const status = await page.evaluate(async () => {
            // @ts-ignore
            const headers = stTest.context().getRequestHeaders();
            const response = await fetch('/api/content/importURL', { method: 'POST', headers, body: JSON.stringify({ url: 'https://chub.ai/characters/someone/something' }) });
            return response.status;
        });
        expect(status).not.toBe(200);
        expect(pastLoopback.take()).toEqual(['the server asked for https://api.chub.ai']);
    });

    test('the default API is answered as unreachable, and that is no refusal', async ({ page, pastLoopback }) => {
        await testSetup.awaitST({ page });
        const answered = await page.evaluate(async () => {
            // @ts-ignore
            const response = await fetch('/api/horde/status', { method: 'POST', headers: stTest.context().getRequestHeaders({ omitContentType: true }) });
            return response.ok;
        });
        expect(answered).toBe(false);
        expect(pastLoopback.take()).toEqual([]);
    });
});
