import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

// Upstream's saveChat(), as an extension calls it after changing `chat` directly: the whole chat goes to
// /api/chats/save in one request, and the server stores what changed, so a reload shows the same chat.

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
function chatState(page) {
    return page.evaluate(() => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        return { messages: context.chat.map(m => m.mes), key: context.chatMetadata.compat_key ?? null };
    });
}

test('an extension\'s changes to chat and chat metadata are stored by saveChat()', async ({ page }) => {
    await testSetup.awaitST({ page });
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const avatar = await createCharacter(page, `SaveCompat-${stamp}`);
    await openCharacter(page, avatar);
    // The chat is stored (its greeting has a row).
    await page.evaluate(async () => {
        const { ensureOpeningRow } = await import('/scripts/chat-store.js');
        await ensureOpeningRow(0);
    });

    /** @type {string[]} */
    const saves = [];
    page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (request.method() === 'POST' && path.startsWith('/api/chats/')) saves.push(path);
    });
    await page.evaluate(async () => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        context.chat.push({ name: 'User', is_user: true, is_system: false, mes: 'Pushed by an extension.', send_date: new Date().toISOString(), extra: {} });
        context.chat[0] = { ...context.chat[0], mes: 'Hello, changed.' };
        context.chatMetadata.compat_key = 'stored';
        await context.saveChat();
    });
    expect(saves).toEqual(['/api/chats/save']);
    const before = await chatState(page);
    expect(before).toEqual({ messages: ['Hello, changed.', 'Pushed by an extension.'], key: 'stored' });

    await page.reload();
    await testSetup.awaitST({ page });
    await openCharacter(page, avatar);
    expect(await chatState(page)).toEqual(before);
});
