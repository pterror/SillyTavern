import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

// Starting a new chat that replaces the open one is one write: the character moves to the new chat and the old one
// is deleted in the same request.

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

test('a new chat replacing the open one is one write', async ({ page }) => {
    await testSetup.awaitST({ page });
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const avatar = await createCharacter(page, `NewChat-${stamp}`);
    await openCharacter(page, avatar);

    // A labeled chat the character is at.
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        const { ensureOpeningRow } = await import('/scripts/chat-store.js');
        const opening = await ensureOpeningRow(0);
        const headers = context.getRequestHeaders();
        const appended = await (await fetch('/api/chats/message/append', {
            method: 'POST', headers,
            body: JSON.stringify({ avatar_url: avatar, after_node_id: opening, messages: [{ name: 'User', is_user: true, mes: 'Old chat.', send_date: new Date().toISOString(), extra: {} }] }),
        })).json();
        await fetch('/api/chats/label', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, node_id: appended.node_ids[0], label: 'Old chat' }) });
        await fetch('/api/characters/chat', { method: 'POST', headers, body: JSON.stringify({ avatar, chat: 'Old chat' }) });
    }, avatar);
    await page.reload();
    await testSetup.awaitST({ page });
    await openCharacter(page, avatar);
    await expect(page.locator('#chat .mes')).toHaveCount(2);

    /** @type {string[]} */
    const writes = [];
    page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (request.method() === 'POST' && ['/api/chats/new', '/api/chats/delete', '/api/characters/chat'].includes(path)) writes.push(path);
    });
    await page.evaluate(async () => {
        const { doNewChat } = await import('/script.js');
        await doNewChat({ deleteCurrentChat: true });
    });
    await expect(page.locator('#chat .mes')).toHaveCount(1);
    expect(writes).toEqual(['/api/chats/new']);

    const chats = await page.evaluate(async (avatar) => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        const response = await fetch('/api/characters/chats', { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, simple: true }) });
        return (await response.json()).map(chat => chat.file_name);
    }, avatar);
    expect(chats).not.toContain('Old chat.jsonl');
});
