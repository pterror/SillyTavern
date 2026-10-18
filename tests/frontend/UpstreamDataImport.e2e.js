import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

// A chat file in upstream's place (chats/<avatar>/<name>.jsonl) goes into the store through the upstream import: it
// opens by its name with every swipe, and a second import adds nothing.

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

/** @param {import('@playwright/test').Page} page */
function runImport(page) {
    return page.evaluate(async () => {
        // @ts-ignore
        const response = await fetch('/api/upstream-import', { method: 'POST', headers: SillyTavern.getContext().getRequestHeaders(), body: '{}' });
        if (!response.ok) throw new Error(`import failed: ${response.status}`);
        return response.json();
    });
}

test.describe('the upstream data import', () => {
    test('an upstream chat file opens by its name with its swipes, once', async ({ page, stServer }) => {
        await testSetup.awaitST({ page });
        await page.evaluate(() => new Promise(resolve => {
            const { eventSource, eventTypes } = window['SillyTavern'].getContext();
            eventSource.once(eventTypes.APP_READY, resolve);
        }));
        const name = `Upstreamer${Date.now()}`;
        const avatar = await createCharacter(page, name);
        const folder = path.join(stServer.dataRoot, 'default-user', 'chats', path.parse(avatar).name);
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, 'Upstream chat.jsonl'), [
            { user_name: 'User', character_name: name, chat_metadata: {} },
            { name, is_user: false, mes: 'From upstream.', send_date: 'x', extra: {} },
            { name: 'User', is_user: true, mes: 'Hi.', send_date: 'x', extra: {} },
            { name, is_user: false, mes: 'Swipe two.', send_date: 'x', extra: {}, swipe_id: 1, swipes: ['Swipe one.', 'Swipe two.', 'Swipe three.'], swipe_info: [{ extra: {} }, { extra: {} }, { extra: {} }] },
        ].map(l => JSON.stringify(l)).join('\n'));

        const first = await runImport(page);
        expect(first.imported.chats).toBe(1);
        expect(first.notImported).toEqual([]);

        await openCharacterManagementDrawer(page);
        await page.evaluate(async (avatar) => {
            // @ts-ignore
            await SillyTavern.getContext().getCharacters();
            const { selectCharacterByAvatar, openCharacterChat } = await import('/script.js');
            await selectCharacterByAvatar(avatar);
            await openCharacterChat('Upstream chat');
        }, avatar);
        await expect(page.locator('#chat .mes .mes_text').last()).toHaveText('Swipe two.', { timeout: 15000 });
        const shown = await page.evaluate(() => {
            // @ts-ignore
            const { chat } = SillyTavern.getContext();
            return { mes: chat.map(m => m.mes), swipes: chat[chat.length - 1].swipes, swipeId: chat[chat.length - 1].swipe_id };
        });
        expect(shown).toEqual({ mes: ['From upstream.', 'Hi.', 'Swipe two.'], swipes: ['Swipe one.', 'Swipe two.', 'Swipe three.'], swipeId: 1 });

        const again = await runImport(page);
        expect(again.imported.chats).toBe(0);
        expect(again.present.some(p => p.file.endsWith('/Upstream chat.jsonl'))).toBe(true);
    });
});
