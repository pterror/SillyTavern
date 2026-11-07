import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, awaitChatMessages } from './frontent-test-utils.js';
import { write as writeCard } from '../../src/character-card-parser.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

const NAME = 'Upstreamer';
const card = JSON.stringify({ name: NAME, first_mes: 'Hello there.', spec: 'chara_card_v2', spec_version: '2.0', data: { name: NAME, first_mes: 'Hello there.', extensions: {} } });

test.use({
    freshAccount: true,
    upstreamFiles: {
        [`characters/${NAME}.png`]: writeCard(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'public', 'img', 'ai4.png')), card),
        [`chats/${NAME}/Upstream chat.jsonl`]: [
            { user_name: 'User', character_name: NAME, chat_metadata: {} },
            { name: NAME, is_user: false, mes: 'From upstream.', send_date: 'x', extra: {} },
            { name: 'User', is_user: true, mes: 'Hi.', send_date: 'x', extra: {} },
            { name: NAME, is_user: false, mes: 'Swipe two.', send_date: 'x', extra: {}, swipe_id: 1, swipes: ['Swipe one.', 'Swipe two.', 'Swipe three.'], swipe_info: [{ extra: {} }, { extra: {} }, { extra: {} }] },
        ].map(l => JSON.stringify(l)).join('\n'),
    },
});

test.describe('the upstream data import', () => {
    test('an upstream chat file is imported when the store is made, and opens by its name with its swipes', async ({ page }) => {
        await testSetup.awaitFreshST({ page });
        const avatar = `${NAME}.png`;
        await awaitChatMessages(page, avatar, 'Upstream chat', 3);

        await openCharacterManagementDrawer(page);
        await page.evaluate(async (avatar) => {
            // @ts-ignore
            await stTest.context().getCharacters();
            const { selectCharacterByAvatar, openCharacterChat } = await import('/script.js');
            await selectCharacterByAvatar(avatar);
            await openCharacterChat('Upstream chat');
        }, avatar);
        await expect(page.locator('#chat .mes .mes_text').last()).toHaveText('Swipe two.', { timeout: 15000 });
        const shown = await page.evaluate(() => {
            // @ts-ignore
            const { chat } = stTest.context();
            return { mes: chat.map(m => m.mes), swipes: chat[chat.length - 1].swipes, swipeId: chat[chat.length - 1].swipe_id };
        });
        expect(shown).toEqual({ mes: ['From upstream.', 'Hi.', 'Swipe two.'], swipes: ['Swipe one.', 'Swipe two.', 'Swipe three.'], swipeId: 1 });
    });
});
