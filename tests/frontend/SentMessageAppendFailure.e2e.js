import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { createCharacter, openCharacter } from './llamacpp-mock.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

for (const command of ['/send', '/sendas name=Bob', '/sys', '/comment']) {
    test(`${command}: a message the server fails to store is shown as not saved`, async ({ page }) => {
        const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        await testSetup.awaitST({ page });
        const avatar = await createCharacter(page, `AppendFailure-${stamp}`);
        await openCharacter(page, avatar);
        await page.evaluate(async () => {
            const { ensureOpeningRow } = await import('/scripts/chat-store.js');
            await ensureOpeningRow(0);
        });

        await page.route('**/api/chats/message/append', route => route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"refused"}' }));
        const text = `Sent ${stamp}`;
        await page.evaluate(async (script) => {
            // @ts-ignore
            await stTest.context().executeSlashCommandsWithOptions(script);
        }, `${command} ${text}`);

        const sent = page.locator('#chat .mes[mesid="1"]');
        await expect(sent.locator('.mes_text')).toContainText(text);
        await expect(sent).toHaveClass(/failed_send/);
        await expect(page.locator('.toast-error', { hasText: 'Message not saved' })).toBeVisible();

        await page.unroute('**/api/chats/message/append');
        await page.locator('.toast-error', { hasText: 'Message not saved' }).getByRole('button', { name: 'Save it again' }).click();
        await expect(sent).not.toHaveClass(/failed_send/);
        await page.reload();
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
        await openCharacter(page, avatar);
        await expect(page.locator('#chat .mes[mesid="1"] .mes_text')).toContainText(text);
        await expect(page.locator('#chat .mes')).toHaveCount(2);
    });
}
