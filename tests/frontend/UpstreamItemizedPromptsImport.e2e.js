import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from './fixtures.js';
import { testSetup, awaitChatMessages } from './frontent-test-utils.js';
import { write as writeCard } from '../../src/character-card-parser.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

const NAME = 'Itemizer';
const CHAT = `${NAME} - 2024-05-05@10h00m00s`;
const card = JSON.stringify({ name: NAME, first_mes: 'Hello there.', spec: 'chara_card_v2', spec_version: '2.0', data: { name: NAME, first_mes: 'Hello there.', extensions: {} } });

test.use({
    freshAccount: true,
    upstreamFiles: {
        [`characters/${NAME}.png`]: writeCard(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'public', 'img', 'ai4.png')), card),
        [`chats/${NAME}/${CHAT}.jsonl`]: [
            { chat_metadata: {} },
            { name: NAME, is_user: false, mes: 'Greeting.', extra: {} },
            { name: 'User', is_user: true, mes: 'Hi.', extra: {} },
            { name: NAME, is_user: false, mes: 'Reply.', extra: {} },
        ].map(l => JSON.stringify(l)).join('\n'),
    },
});

test.describe('the upstream itemized-prompts import', () => {
    test('entries land on their messages; what can\'t be placed stays in the browser and is warned about', async ({ page }) => {
        await testSetup.awaitFreshST({ page });
        const avatar = `${NAME}.png`;
        await awaitChatMessages(page, avatar, CHAT, 3);

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
        }, { chatId: CHAT });
        expect(left.chat).toEqual([{ mesId: 7, rawPrompt: 'past the end' }]);
        expect(left.orphan).toEqual([{ mesId: 0, rawPrompt: 'orphan' }]);

        const warning = page.locator('#toast-container .toast-warning');
        await expect(warning).toContainText('No such chat', { timeout: 10000 });
        await expect(warning).toContainText(`${CHAT}, message 7`);

        const stored = await page.evaluate(async ({ avatar, chat }) => {
            // @ts-ignore
            const headers = stTest.context().getRequestHeaders();
            const opened = await (await fetch('/api/chats/open', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, chat }) })).json();
            const found = [];
            for (const [index, message] of opened.messages.entries()) {
                const response = await fetch('/api/itemized-prompts/message', { method: 'POST', headers, body: JSON.stringify({ node_id: message.node_id }) });
                if (response.ok) found.push([index, (await response.json()).entry.rawPrompt]);
            }
            return found;
        }, { avatar, chat: CHAT });
        expect(stored).toEqual([[0, 'prompt for the greeting'], [2, 'prompt for the reply']]);
    });
});
