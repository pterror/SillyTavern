import { test, expect } from './fixtures.js';
import { chatBox, testSetup } from './frontent-test-utils.js';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * Seraphina's chat ended at "reply two", then switched to "other one", an alternative of "reply one" above it: the
 * line left ends at "reply two"
 * @param {import('@playwright/test').Page} page
 */
async function chatWithALineLeft(page) {
    await testSetup.awaitST({ page });
    await page.evaluate(async () => {
        // @ts-ignore
        const { executeSlashCommandsWithOptions: run } = stTest.context();
        await run('/go Seraphina');
        await run('/send hello');
        await run('/sendas name=Seraphina reply one');
        await run('/addswipe other one');
        await run('/send more');
        await run('/sendas name=Seraphina reply two');
    });
    await expect(page.locator('#chat .last_mes .mes_text')).toHaveText('reply two');
    await page.evaluate(async () => {
        // @ts-ignore
        const { chat } = stTest.context();
        const above = chat.find(m => m.mes === 'reply one');
        const { switchToNode } = await import('/scripts/node-navigation.js');
        await switchToNode(above.swipe_info[above.swipes.indexOf('other one')].node_id);
    });
    await expect(page.locator('#chat .last_mes .mes_text')).toHaveText('other one');
    await expect(chatBox(page)).toHaveCount(1, { timeout: 10000 });
}

const dialog = page => page.locator('dialog.recent-history');
const rows = page => dialog(page).locator('.recent-history-entry');

test.describe('recent history', () => {
    test('opens from the options menu and the palette, shows where the chat is and the line it left, and goes there', async ({ page }) => {
        await chatWithALineLeft(page);

        await page.locator('#options_button').click();
        await page.locator('#option_recent_history').click();
        await expect(dialog(page)).toBeVisible();
        await expect(dialog(page).locator('[role=tab][aria-selected=true]')).toHaveText('This chat');
        await expect(rows(page)).toHaveCount(2);
        await expect(rows(page).nth(0)).toContainText('other one');
        await expect(rows(page).nth(0)).toContainText('Now');
        await expect(rows(page).nth(1)).toContainText('reply two');
        await dialog(page).locator('.popup-button-close').click();
        await expect(dialog(page)).toHaveCount(0);

        await chatBox(page).click();
        await page.keyboard.press(`${MOD}+k`);
        const palette = page.locator('.commandPalette');
        await expect(palette).toBeVisible();
        await page.keyboard.type('recent history');
        await expect(palette.locator('[role=option]').first()).toContainText('Recent history');
        await page.keyboard.press('Enter');
        await expect(dialog(page)).toBeVisible();

        await dialog(page).getByRole('tab', { name: 'All chats' }).click();
        await expect(dialog(page).locator('[role=tab][aria-selected=true]')).toHaveText('All chats');
        await expect(rows(page).first()).toContainText('other one');

        await rows(page).filter({ hasText: 'reply two' }).locator('.select_chat_block_wrapper').click();
        await expect(dialog(page)).toHaveCount(0);
        await expect(page.locator('#chat .last_mes .mes_text')).toHaveText('reply two');
    });
});
