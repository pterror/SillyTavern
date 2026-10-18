import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

// Upstream's itemized prompts, kept in this browser's SillyTavern_Prompts store by chat id, go onto the messages of
// the chat the upstream import made for that chat file. A chat's copy here goes once its entries are stored; what
// can't be placed stays here and is named in a warning.

/** @param {import('@playwright/test').Page} page @param {string} name */
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

test.describe('the upstream itemized-prompts import', () => {
    test('entries land on their messages; what can\'t be placed stays in the browser and is warned about', async ({ page, stServer }) => {
        await testSetup.awaitST({ page });
        await page.evaluate(() => new Promise(resolve => {
            const { eventSource, eventTypes } = window['SillyTavern'].getContext();
            eventSource.once(eventTypes.APP_READY, resolve);
        }));
        const name = `Itemizer${Date.now()}`;
        const avatar = await createCharacter(page, name);
        const chatId = `${name} - 2024-05-05@10h00m00s`;
        const folder = path.join(stServer.dataRoot, 'default-user', 'chats', path.parse(avatar).name);
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, `${chatId}.jsonl`), [
            { chat_metadata: {} },
            { name, is_user: false, mes: 'Greeting.', extra: {} },
            { name: 'User', is_user: true, mes: 'Hi.', extra: {} },
            { name, is_user: false, mes: 'Reply.', extra: {} },
        ].map(l => JSON.stringify(l)).join('\n'));
        const imported = await page.evaluate(async () => {
            // @ts-ignore
            const response = await fetch('/api/upstream-import', { method: 'POST', headers: SillyTavern.getContext().getRequestHeaders(), body: '{}' });
            return response.json();
        });
        expect(imported.imported.chats).toBe(1);

        const left = await page.evaluate(async ({ chatId }) => {
            const { localforage } = await import('/lib.js');
            const storage = localforage.createInstance({ name: 'SillyTavern_Prompts' });
            await storage.setItem(chatId, [
                { mesId: 0, rawPrompt: 'prompt for the greeting' },
                { mesId: 2, rawPrompt: 'prompt for the reply' },
                { mesId: 7, rawPrompt: 'past the end' },
            ]);
            await storage.setItem('No such chat', [{ mesId: 0, rawPrompt: 'orphan' }]);
            const { importUpstreamItemizedPrompts } = await import('/scripts/itemized-prompts.js');
            await importUpstreamItemizedPrompts();
            return { chat: await storage.getItem(chatId), orphan: await storage.getItem('No such chat') };
        }, { chatId });
        expect(left.chat).toEqual([{ mesId: 7, rawPrompt: 'past the end' }]);
        expect(left.orphan).toEqual([{ mesId: 0, rawPrompt: 'orphan' }]);

        const warning = page.locator('#toast-container .toast-warning');
        await expect(warning).toContainText('No such chat', { timeout: 10000 });
        await expect(warning).toContainText(`${chatId}, message 7`);

        const stored = await page.evaluate(async ({ avatar, chatId }) => {
            // @ts-ignore
            const response = await fetch('/api/itemized-prompts/chat', { method: 'POST', headers: SillyTavern.getContext().getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, chat: chatId }) });
            const { entries } = await response.json();
            return entries.map((/** @type {any} */ e) => [e.index, e.entry.rawPrompt]);
        }, { avatar, chatId });
        expect(stored).toEqual([[0, 'prompt for the greeting'], [2, 'prompt for the reply']]);
    });
});
