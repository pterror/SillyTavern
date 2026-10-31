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
 * @returns {Promise<{ avatar: string, question: string }>}
 */
async function chatWithQuestion(page) {
    await testSetup.awaitST({ page });
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const avatar = await createCharacter(page, `Overswiper-${stamp}`);
    await openCharacter(page, avatar);
    await expect(page.locator('#chat .mes')).toHaveCount(1);
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
                { name: 'Bot', is_user: false, mes: 'Two days on foot.', send_date: new Date().toISOString(), extra: {} },
            ] }),
        });
        if (!response.ok) throw new Error(`append failed: ${response.status}`);
        const { openCharacterChat, getCurrentChatId } = await import('/script.js');
        await openCharacterChat(getCurrentChatId());
    }, avatar);
    await expect(page.locator('#chat .mes')).toHaveCount(3);
    // @ts-ignore
    const question = await page.evaluate(() => SillyTavern.getContext().chat[1].node_id);
    return { avatar, question };
}

function storedAlternatives(page, nodeId) {
    return page.evaluate(async (nodeId) => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        const response = await fetch('/api/chats/alternatives', { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ node_id: nodeId }) });
        return (await response.json()).alternatives.map((/** @type {any} */ a) => a.mes);
    }, nodeId);
}

function storedPath(page, avatar) {
    return page.evaluate(async (avatar) => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        const response = await fetch('/api/chats/open', { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }) });
        return (await response.json()).messages.map((/** @type {any} */ m) => m.mes);
    }, avatar);
}

function shown(page, mesId) {
    return page.evaluate((mesId) => ({
        // @ts-ignore
        chat: SillyTavern.getContext().chat.map(m => m.mes),
        counter: document.querySelector(`#chat .mes[mesid="${mesId}"] .swipes-counter`)?.textContent?.replace(/\u200b/g, '').trim(),
    }), mesId);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} mesId
 * @param {string} text
 */
async function overswipeAndWrite(page, mesId, text) {
    const message = page.locator(`#chat .mes[mesid="${mesId}"]`);
    await message.hover();
    await message.locator('.swipe_right').click({ force: true });
    await expect(message.locator('.edit_textarea')).toBeVisible({ timeout: 10000 });
    await message.locator('.edit_textarea').fill(text);
    await page.waitForTimeout(3000);
    return message;
}

/** @param {import('@playwright/test').Page} page */
async function expectNoWarnings(page) {
    await expect(page.locator('#toast-container .toast-warning, #toast-container .toast-error')).toHaveCount(0);
}

test.describe('overswiping a user message', () => {
    test.setTimeout(120000);

    test('writing in the slot changes nothing stored; Done adds it beside the first, and swiping back brings the reply back', async ({ page }) => {
        const { avatar, question } = await chatWithQuestion(page);
        const message = await overswipeAndWrite(page, 1, 'How far is the city?');
        expect((await shown(page, 1)).counter).toBe('2/2');
        // @ts-ignore
        expect(await page.evaluate(() => SillyTavern.getContext().chat.length)).toBe(2);
        expect(await storedAlternatives(page, question)).toEqual(['How far is it?']);

        await message.locator('.mes_edit_done').click({ force: true });
        await expect.poll(() => storedAlternatives(page, question)).toEqual(['How far is it?', 'How far is the city?']);
        expect(await shown(page, 1)).toEqual({ chat: ['Hello there.', 'How far is the city?'], counter: '2/2' });
        expect(await storedPath(page, avatar)).toEqual(['Hello there.', 'How far is the city?']);

        await message.hover();
        await page.locator('#chat .mes[mesid="1"] .swipe_left').click({ force: true });
        await expect.poll(() => shown(page, 1)).toEqual({ chat: ['Hello there.', 'How far is it?', 'Two days on foot.'], counter: '1/2' });
        expect(await storedPath(page, avatar)).toEqual(['Hello there.', 'How far is it?', 'Two days on foot.']);
        await expectNoWarnings(page);

        await page.reload();
        await testSetup.awaitST({ page });
        await openCharacter(page, avatar);
        await expect.poll(() => shown(page, 1)).toEqual({ chat: ['Hello there.', 'How far is it?', 'Two days on foot.'], counter: '1/2' });
        await page.locator('#chat .mes[mesid="1"]').hover();
        await page.locator('#chat .mes[mesid="1"] .swipe_right').click({ force: true });
        await expect.poll(() => shown(page, 1)).toEqual({ chat: ['Hello there.', 'How far is the city?'], counter: '2/2' });
        await expect(page.locator('#chat .mes[mesid="1"] .edit_textarea')).toHaveCount(0);
        expect(await storedAlternatives(page, question)).toEqual(['How far is it?', 'How far is the city?']);
        await expectNoWarnings(page);
    });

    test('Save as a new alternative in the slot is Done: one alternative more, not two', async ({ page }) => {
        const { question } = await chatWithQuestion(page);
        const message = await overswipeAndWrite(page, 1, 'Is it far?');
        await message.locator('.mes_edit_duplicate').click({ force: true });
        await expect.poll(() => storedAlternatives(page, question)).toEqual(['How far is it?', 'Is it far?']);
        await expect.poll(() => shown(page, 1)).toEqual({ chat: ['Hello there.', 'Is it far?'], counter: '2/2' });
        await expect(message.locator('.edit_textarea')).toHaveCount(0);
        await expectNoWarnings(page);
    });

    test('Cancel drops the slot and brings back what followed', async ({ page }) => {
        const { avatar, question } = await chatWithQuestion(page);
        const message = await overswipeAndWrite(page, 1, 'Never mind.');
        await message.locator('.mes_edit_cancel').click({ force: true });
        await expect.poll(() => shown(page, 1)).toEqual({ chat: ['Hello there.', 'How far is it?', 'Two days on foot.'], counter: '1/1' });
        expect(await storedAlternatives(page, question)).toEqual(['How far is it?']);
        expect(await storedPath(page, avatar)).toEqual(['Hello there.', 'How far is it?', 'Two days on foot.']);
        await expectNoWarnings(page);
    });

    test('Done on an empty slot stores nothing and gives it up', async ({ page }) => {
        const { question } = await chatWithQuestion(page);
        const message = await overswipeAndWrite(page, 1, '');
        await message.locator('.mes_edit_done').click({ force: true });
        await expect.poll(() => shown(page, 1)).toEqual({ chat: ['Hello there.', 'How far is it?', 'Two days on foot.'], counter: '1/1' });
        expect(await storedAlternatives(page, question)).toEqual(['How far is it?']);
        await expectNoWarnings(page);
    });

    test('the opening: Done stores a new opening and leaves the first as it was', async ({ page }) => {
        const { avatar } = await chatWithQuestion(page);
        // @ts-ignore
        const opening = await page.evaluate(() => SillyTavern.getContext().chat[0].node_id);
        const message = await overswipeAndWrite(page, 0, 'Welcome back.');
        expect(await storedAlternatives(page, opening)).toEqual(['Hello there.']);
        await message.locator('.mes_edit_done').click({ force: true });
        await expect.poll(() => storedAlternatives(page, opening)).toEqual(['Hello there.', 'Welcome back.']);
        await expect.poll(() => shown(page, 0)).toEqual({ chat: ['Welcome back.'], counter: '2/2' });
        expect(await storedPath(page, avatar)).toEqual(['Welcome back.']);
        await expectNoWarnings(page);
    });
});
