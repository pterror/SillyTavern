import { test, expect } from './fixtures.js';
import { testSetup, chatBox } from './frontent-test-utils.js';
import { startLlamaCpp, createCharacter, openCharacter, connectLlamaCpp } from './llamacpp-mock.js';

/** @param {import('@playwright/test').Page} page */
async function openChatList(page) {
    await page.locator('#options_button').click();
    await page.locator('#option_select_chat').click();
    await expect(page.locator('#select_chat_div .select_chat_block').first()).toBeVisible();
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} s
 * @param {string} url
 */
async function chatWithReply(page, s, url) {
    await testSetup.awaitST({ page });
    const avatar = await createCharacter(page, `Keep ${s}`, `Greeting ${s}`);
    await openCharacter(page, avatar);
    await connectLlamaCpp(page, url);
    await chatBox(page).fill(`Hello ${s}`);
    await page.locator('#send_but').click();
    await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText(`Mock reply 1 ${s}`, { timeout: 60000 });
    await expect(page.locator('#send_but')).toBeVisible();
}

test.describe('a new chat keeps the earlier chat: it is listed and opens with all its messages', () => {
    let s = '';
    /** @type {Awaited<ReturnType<typeof startLlamaCpp>>} */
    let mock;
    test.beforeEach(async () => {
        s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const stamp = s;
        mock = await startLlamaCpp({ reply: n => `Mock reply ${n} ${stamp}.` });
    });
    test.afterEach(async () => {
        await mock.close();
    });

    /** @type {{ title: string, startNewChat: (page: import('@playwright/test').Page) => Promise<void> }[]} */
    const ways = [
        {
            title: 'from the chat list',
            startNewChat: async (page) => {
                await openChatList(page);
                await page.locator('#newChatFromManageScreenButton').click();
            },
        },
        {
            title: 'through /newchat',
            startNewChat: async (page) => {
                await page.evaluate(async () => {
                    // @ts-ignore
                    await SillyTavern.getContext().executeSlashCommandsWithOptions('/newchat');
                });
            },
        },
    ];
    for (const { title, startNewChat } of ways) {
        test(`${title}`, async ({ page }) => {
            await chatWithReply(page, s, mock.url);
            await startNewChat(page);
            await expect(page.locator('#chat .mes')).toHaveCount(1);

            await openChatList(page);
            await expect(page.locator('#select_chat_div .select_chat_block')).toHaveCount(2);
            await page.locator('#select_chat_div .select_chat_block', { hasText: `Mock reply 1 ${s}` }).click();
            await expect(page.locator('#chat .mes')).toHaveCount(3);
            await expect(page.locator('#chat .mes[mesid="1"] .mes_text')).toContainText(`Hello ${s}`);
            await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText(`Mock reply 1 ${s}`);
        });
    }
});
