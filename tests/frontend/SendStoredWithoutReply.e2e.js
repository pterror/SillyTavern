import { test, expect } from './fixtures.js';
import { testSetup, chatBox } from './frontent-test-utils.js';

// A message sent when no reply can be made (here Horde, with no model to generate with: the request carrying the
// message never goes out) is stored all the same, as upstream keeps it: it is there after a reload, once, and the
// page doesn't say it couldn't be saved.

test('a message sent with no model to reply is stored, once', async ({ page }) => {
    await page.route(/aihorde\.net/, route => route.abort());
    await testSetup.awaitST({ page });
    // Tests on this data root before may have picked another API.
    if (!(await page.locator('#main_api').isVisible())) await page.locator('#API-status-top').click();
    await page.selectOption('#main_api', 'koboldhorde', { force: true });
    await page.locator('#API-status-top').click();
    // @ts-ignore
    await expect.poll(() => page.evaluate(() => SillyTavern.getContext().mainApi)).toBe('koboldhorde');
    await expect(page.locator('#main_api')).toBeHidden();
    await page.evaluate(async () => {
        // @ts-ignore
        await SillyTavern.getContext().executeSlashCommandsWithOptions('/go Seraphina');
    });
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
    const text = `sent with no reply ${Date.now()}`;
    await chatBox(page).click();
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
    await expect(page.locator('.toast', { hasText: 'No Horde model selected' })).toBeVisible();
    // @ts-ignore
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).userInputGenerateMutex.isBusy)).toBe(false);
    await expect(page.locator('.toast', { hasText: 'couldn\'t be saved' })).toHaveCount(0);

    await page.reload();
    await testSetup.awaitST({ page });
    await page.evaluate(async () => {
        // @ts-ignore
        await SillyTavern.getContext().executeSlashCommandsWithOptions('/go Seraphina');
    });
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
    // @ts-ignore
    await expect.poll(() => page.evaluate(t => SillyTavern.getContext().chat.filter(m => m.mes === t && m.node_id).length, text)).toBe(1);
});
