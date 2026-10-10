import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

// A message's token count is derived for display: the counts of the messages drawn are asked for in one request,
// and never stored with the messages.

/** @param {import('@playwright/test').Page} page @param {string} name */
async function createCharacter(page, name) {
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

/** @param {import('@playwright/test').Page} page @param {string} avatar */
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

test('the drawn messages\' counts come in one request and are not stored', async ({ page }) => {
    await testSetup.awaitST({ page });
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const avatar = await createCharacter(page, `Counters-${stamp}`);
    await openCharacter(page, avatar);
    await expect(page.locator('#chat .mes')).toHaveCount(1);

    await page.evaluate(async (avatar) => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        context.powerUserSettings.message_token_count_enabled = true;
        const { ensureOpeningRow } = await import('/scripts/chat-store.js');
        const opening = await ensureOpeningRow(0);
        const response = await fetch('/api/chats/message/append', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, after_node_id: opening, messages: [
                { name: 'User', is_user: true, mes: 'How far is it?', send_date: new Date().toISOString(), extra: { token_count: 999 } },
                { name: 'Bot', is_user: false, mes: 'Two days on foot.', send_date: new Date().toISOString(), extra: {} },
            ] }),
        });
        if (!response.ok) throw new Error(`append failed: ${response.status}`);
    }, avatar);

    /** @type {any[]} */
    const countRequests = [];
    page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/tokenizers/current/count') countRequests.push(request.postDataJSON());
    });
    await page.evaluate(async (avatar) => {
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await page.evaluate(async () => {
        // @ts-ignore
        const { openCharacterChat, getCurrentChatId } = await import('/script.js');
        await openCharacterChat(getCurrentChatId());
    });
    await expect(page.locator('#chat .mes')).toHaveCount(3);

    await expect.poll(() => page.evaluate(() => {
        // @ts-ignore
        return SillyTavern.getContext().chat.map(m => typeof m.extra?.token_count === 'number' && m.extra.token_count > 0);
    })).toEqual([true, true, true]);
    const counts = countRequests.filter(body => Array.isArray(body.texts) || Array.isArray(body.messages_each));
    expect(counts).toHaveLength(1);
    expect((counts[0].texts ?? counts[0].messages_each).length).toBe(3);
    await expect(page.locator('#chat .mes[mesid="1"] .tokenCounterDisplay')).not.toHaveText('999t');

    const stored = await page.evaluate(async (avatar) => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        const response = await fetch('/api/chats/open', { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }) });
        return (await response.json()).messages.map(m => m.extra?.token_count ?? null);
    }, avatar);
    expect(stored).toEqual([null, null, null]);
});
