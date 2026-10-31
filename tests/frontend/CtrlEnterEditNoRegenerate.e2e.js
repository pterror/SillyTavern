import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { createCharacter, openCharacter } from './llamacpp-mock.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

test('Ctrl+Enter finishing a user message edit does not ask to regenerate', async ({ page }) => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await testSetup.awaitST({ page });
    const avatar = await createCharacter(page, `CtrlEnterEdit-${stamp}`);
    await openCharacter(page, avatar);
    await page.evaluate(async (text) => {
        // @ts-ignore
        await SillyTavern.getContext().executeSlashCommandsWithOptions(`/send ${text}`);
    }, `Question ${stamp}`);
    await expect(page.locator('#chat .mes[mesid="1"] .mes_text')).toContainText(`Question ${stamp}`);
    // @ts-ignore
    await expect.poll(() => page.evaluate(() => String(SillyTavern.getContext().chat[1]?.node_id ?? '')), { timeout: 10000 }).toMatch(/^(?!card:).+/);

    await page.locator('#chat .mes[mesid="1"] .mes_edit').click();
    const editor = page.locator('#chat .mes[mesid="1"] .cm-content').or(page.locator('#chat .mes[mesid="1"] #curEditTextarea:not(.live-editor-textarea)'));
    await expect(editor).toBeFocused();
    await page.keyboard.press('End');
    await page.keyboard.type(' (edited)');
    await page.keyboard.press('Control+Enter');

    await expect(page.locator('#chat .mes[mesid="1"] .mes_text')).toContainText(`Question ${stamp} (edited)`);
    await page.waitForTimeout(1000);
    await expect(page.locator('.popup', { hasText: 'Regenerate Message' })).toHaveCount(0);
});
