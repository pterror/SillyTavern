import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
function createCharacter(page, name) {
    return page.evaluate(async (name) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', 'Hello there.');
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, name);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function openCharacter(page, avatar) {
    await openCharacterManagementDrawer(page);
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        await SillyTavern.getContext().getCharacters();
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function seedReply(page, avatar) {
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        const { ensureOpeningRow } = await import('/scripts/chat-store.js');
        const opening = await ensureOpeningRow(0);
        const response = await fetch('/api/chats/message/append', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, after_node_id: opening, messages: [
                { name: 'User', is_user: true, mes: 'How far is it?', send_date: new Date().toISOString(), extra: {} },
                { name: 'Bot', is_user: false, mes: 'Two days on foot.', send_date: new Date().toISOString(), extra: { reasoning: '' } },
            ] }),
        });
        if (!response.ok) throw new Error(`append failed: ${response.status}`);
        const { openCharacterChat, getCurrentChatId } = await import('/script.js');
        await openCharacterChat(getCurrentChatId());
    }, avatar);
    await expect(page.locator('#chat .mes')).toHaveCount(3);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
function blockState(page, avatar) {
    return page.evaluate(async (avatar) => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        const { reasoningOf } = await import('/scripts/reasoning-block.js');
        const at = context.chat.findIndex(m => m.mes === 'Two days on foot.');
        const response = await fetch('/api/chats/open', { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }) });
        const stored = (await response.json()).messages.find(m => m.mes === 'Two days on foot.');
        return {
            shown: reasoningOf(context.chat[at]?.extra),
            stored: reasoningOf(stored?.extra),
            drawn: document.querySelector(`#chat .mes[mesid="${at}"] .mes_reasoning_details`)?.checkVisibility() ?? null,
        };
    }, avatar);
}

const EMPTY = { shown: '', stored: '', drawn: true };
const NONE = { shown: null, stored: null, drawn: false };

test.describe('an empty reasoning block', () => {
    test.beforeEach(testSetup.awaitST);

    test('added in the message editor and saved empty, it stays an empty block after a reload; removed, it is gone', async ({ page }) => {
        const avatar = await createCharacter(page, `EmptyBlock-${Date.now()}`);
        await openCharacter(page, avatar);
        await seedReply(page, avatar);
        expect(await blockState(page, avatar)).toEqual(NONE);

        const reply = page.locator('#chat .mes[mesid="2"]');
        await reply.hover();
        await reply.locator('.mes_edit').click();
        await reply.locator('.mes_edit_add_reasoning').click();
        await expect(reply.locator('.reasoning_edit_textarea')).toHaveValue('');
        await reply.locator('.mes_edit_done').click();
        await expect.poll(() => blockState(page, avatar)).toEqual(EMPTY);

        await page.reload();
        await testSetup.awaitST({ page });
        await openCharacter(page, avatar);
        await expect(page.locator('#chat .mes')).toHaveCount(3, { timeout: 10000 });
        await expect.poll(() => blockState(page, avatar)).toEqual(EMPTY);

        await page.evaluate(async () => {
            // @ts-ignore
            const { Popup } = await import('/scripts/popup.js');
            Popup.show.confirm = async () => true;
        });
        const shown = page.locator('#chat .mes[mesid="2"]');
        await shown.locator('.mes_reasoning_header').click();
        await shown.locator('.mes_reasoning_edit').click();
        await shown.locator('.mes_reasoning_delete').click();
        await expect.poll(() => blockState(page, avatar)).toEqual(NONE);
    });

    test('set with /reasoning-set to nothing, it stays an empty block after a reload', async ({ page }) => {
        const avatar = await createCharacter(page, `EmptyBlockCmd-${Date.now()}`);
        await openCharacter(page, avatar);
        await seedReply(page, avatar);

        await page.evaluate(async () => {
            // @ts-ignore
            await SillyTavern.getContext().executeSlashCommandsWithOptions('/reasoning-set at=2 ""');
        });
        await expect.poll(() => blockState(page, avatar)).toEqual(EMPTY);

        await page.reload();
        await testSetup.awaitST({ page });
        await openCharacter(page, avatar);
        await expect(page.locator('#chat .mes')).toHaveCount(3, { timeout: 10000 });
        await expect.poll(() => blockState(page, avatar)).toEqual(EMPTY);
    });
});
