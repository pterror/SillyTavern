import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// A message is marked as on its last swipe (its right arrow highlighted) only when it is: an operator-precedence slip
// marked every message whose overswipe edits, on any swipe. And Ctrl+Up with no user message in the chat does
// nothing (it threw).

test('only a message on its last alternative is marked so; Ctrl+Up without a user message does nothing', async ({ page }) => {
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await testSetup.awaitST({ page });
    await page.evaluate(async () => {
        // @ts-ignore
        await SillyTavern.getContext().executeSlashCommandsWithOptions('/go Seraphina');
    });
    const greeting = page.locator('#chat .mes[mesid="0"]');
    await expect(greeting).toHaveCount(1, { timeout: 10000 });
    await page.evaluate(async () => {
        // @ts-ignore
        await SillyTavern.getContext().SlashCommandParser.commands['addswipe'].callback({ quiet: 'true' }, 'Another greeting.');
    });
    // @ts-ignore
    await expect.poll(() => page.evaluate(() => SillyTavern.getContext().chat[0].swipe_id)).toBe(0);
    await expect(greeting).not.toHaveClass(/\blast_swipe\b/);

    await page.locator('#send_textarea').focus();
    await page.keyboard.press('Control+ArrowUp');
    await page.waitForTimeout(300);
    expect(errors).toEqual([]);
});
