import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

test('the chat\'s overrides are kept on OK and discarded on Escape', async ({ page }) => {
    await testSetup.awaitST({ page });
    await page.evaluate(async () => {
        // @ts-ignore
        await SillyTavern.getContext().executeSlashCommandsWithOptions('/go Seraphina');
    });
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
    await openCharacterManagementDrawer(page);
    // @ts-ignore
    const scenario = () => page.evaluate(() => SillyTavern.getContext().chatMetadata.scenario ?? '');
    const before = await scenario();

    const open = () => page.locator('#char-management-dropdown').selectOption({ label: 'Character Settings Overrides' }, { force: true });
    await open();
    await page.locator('.popup .chat_scenario').fill('Discarded scenario.');
    await page.keyboard.press('Escape');
    await expect(page.locator('.popup .chat_scenario')).toHaveCount(0);
    expect(await scenario()).toBe(before);

    await open();
    await page.locator('.popup .chat_scenario').fill('Kept scenario.');
    await page.locator('.popup .popup-button-ok').click();
    await expect.poll(scenario).toBe('Kept scenario.');
});
