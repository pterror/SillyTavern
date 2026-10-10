import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

// Bookmarking, branching and forking are one request each: the branch is opened from the bookmark's own answer,
// and it carries the chat's metadata.

/** @param {import('@playwright/test').Page} page @param {string} name */
async function createCharacter(page, name) {
    return page.evaluate(async (name) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', 'Hello.');
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
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);
}

/** @param {import('@playwright/test').Page} page */
function recordChatRequests(page) {
    /** @type {string[]} */
    const paths = [];
    page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (request.method() === 'POST' && path.startsWith('/api/chats/')) paths.push(path);
    });
    return paths;
}

test('a fork is one request and opens the branch with the chat\'s metadata', async ({ page }) => {
    await testSetup.awaitST({ page });
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const avatar = await createCharacter(page, `Bookmark-${stamp}`);
    await openCharacter(page, avatar);

    // A stored chat: the greeting, two more messages, and a metadata key.
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        const { ensureOpeningRow } = await import('/scripts/chat-store.js');
        const opening = await ensureOpeningRow(0);
        const response = await fetch('/api/chats/message/append', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, after_node_id: opening, messages: [
                { name: 'User', is_user: true, mes: 'Where to?', send_date: new Date().toISOString(), extra: {} },
                { name: 'Bot', is_user: false, mes: 'North.', send_date: new Date().toISOString(), extra: {} },
            ] }),
        });
        if (!response.ok) throw new Error(`append failed: ${response.status}`);
        await fetch('/api/chats/metadata', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, file_name: opening, metadata: { note_prompt: 'Stay calm.' } }),
        });
    }, avatar);
    await page.reload();
    await testSetup.awaitST({ page });
    await openCharacter(page, avatar);
    await expect(page.locator('#chat .mes')).toHaveCount(3);

    const requests = recordChatRequests(page);
    const name = await page.evaluate(async () => {
        const { forkChat } = await import('/scripts/bookmarks.js');
        return forkChat(1);
    });
    expect(typeof name).toBe('string');
    expect(requests).toEqual(['/api/chats/bookmark']);

    const state = await page.evaluate(() => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        return { chatId: context.getCurrentChatId(), messages: context.chat.map(m => m.mes), note: context.chatMetadata.note_prompt ?? null };
    });
    expect(state.chatId).toBe(name);
    expect(state.messages).toEqual(['Hello.', 'Where to?', 'North.']);
    expect(state.note).toBe('Stay calm.');
});
