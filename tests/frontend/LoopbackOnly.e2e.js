import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

test.describe('a test that asks past loopback fails, and nothing reaches past it', () => {
    test('a request from the page', async ({ page }) => {
        test.fail();
        await testSetup.awaitST({ page });
        expect(await page.evaluate(() => fetch('https://example.com/').then(() => 'answered', () => 'refused'))).toBe('refused');
    });

    test('a request the server makes for it', async ({ page }) => {
        test.fail();
        await testSetup.awaitST({ page });
        const status = await page.evaluate(async () => {
            // @ts-ignore
            const headers = stTest.context().getRequestHeaders();
            const response = await fetch('/api/content/importURL', { method: 'POST', headers, body: JSON.stringify({ url: 'https://chub.ai/characters/someone/something' }) });
            return response.status;
        });
        expect(status).not.toBe(200);
    });
});
