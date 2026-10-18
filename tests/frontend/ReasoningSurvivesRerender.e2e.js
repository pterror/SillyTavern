import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

// A reply's reasoning stays its reasoning, in the page and as stored, through redraws: a chat reopened, a user
// message before it duplicated into an alternative and switched back from, and the page reloaded.

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

/** @param {import('@playwright/test').Page} page */
async function reopenChat(page) {
    await page.evaluate(async () => {
        // @ts-ignore
        const { openCharacterChat, getCurrentChatId } = await import('/script.js');
        await openCharacterChat(getCurrentChatId());
    });
}

/** The bot reply's state: in the page's chat, drawn, and as the server holds the shown path. */
async function replyState(page, avatar) {
    return page.evaluate(async (avatar) => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        const at = context.chat.findIndex(m => !m.is_user && m.mes?.includes('Two days'));
        const m = context.chat[at];
        const block = document.querySelector(`#chat .mes[mesid="${at}"]`);
        const response = await fetch('/api/chats/open', { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }) });
        const stored = (await response.json()).messages.find(x => !x.is_user && String(x.mes).includes('Two days'));
        return {
            mes: m?.mes,
            reasoning: m?.extra?.reasoning,
            drawnReasoning: block?.querySelector('.mes_reasoning')?.textContent?.trim(),
            drawnText: block?.querySelector('.mes_text')?.textContent?.trim(),
            storedMes: stored?.mes,
            storedReasoning: stored?.extra?.reasoning,
        };
    }, avatar);
}

const WANT = {
    mes: 'Two days on foot.',
    reasoning: 'The road is long.',
    drawnReasoning: 'The road is long.',
    drawnText: 'Two days on foot.',
    storedMes: 'Two days on foot.',
    storedReasoning: 'The road is long.',
};

for (const autoParse of [false, true]) {
    test(`a reply's reasoning survives redraws (auto-parse ${autoParse ? 'on' : 'off'})`, async ({ page }) => {
        await testSetup.awaitST({ page });
        const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const avatar = await createCharacter(page, `Reasoner-${stamp}`);
        await openCharacter(page, avatar);
        await expect(page.locator('#chat .mes')).toHaveCount(1);

        await page.evaluate(async ({ avatar, autoParse }) => {
            // @ts-ignore
            const context = SillyTavern.getContext();
            context.powerUserSettings.reasoning.auto_parse = autoParse;
            const { ensureOpeningRow } = await import('/scripts/chat-store.js');
            const opening = await ensureOpeningRow(0);
            const response = await fetch('/api/chats/message/append', {
                method: 'POST',
                headers: context.getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar, after_node_id: opening, messages: [
                    { name: 'User', is_user: true, mes: 'How far is it?', send_date: new Date().toISOString(), extra: {} },
                    { name: 'Bot', is_user: false, mes: 'Two days on foot.', send_date: new Date().toISOString(), extra: { reasoning: 'The road is long.', reasoning_type: 'parsed' } },
                ] }),
            });
            if (!response.ok) throw new Error(`append failed: ${response.status}`);
        }, { avatar, autoParse });
        await reopenChat(page);
        await expect(page.locator('#chat .mes')).toHaveCount(3);
        expect(await replyState(page, avatar)).toEqual(WANT);

        // Redrawn in place.
        await page.evaluate(async () => {
            // @ts-ignore
            const context = SillyTavern.getContext();
            const at = context.chat.findIndex(m => !m.is_user && m.mes?.includes('Two days'));
            const { updateMessageBlock } = await import('/script.js');
            updateMessageBlock(at, context.chat[at]);
            await context.eventSource.emit(context.eventTypes.MESSAGE_UPDATED, at);
        });
        await expect.poll(() => replyState(page, avatar)).toEqual(WANT);

        // The user message duplicated into an alternative with another text, then switched back from.
        const user = page.locator('#chat .mes[mesid="1"]');
        await user.hover();
        await user.locator('.mes_edit').click({ force: true });
        await user.locator('.edit_textarea').fill('How far is the city?');
        await user.locator('.mes_edit_duplicate').click({ force: true });
        await expect(page.locator('#chat .mes')).toHaveCount(2, { timeout: 10000 });
        // The duplicate has settled once the page is on the new alternative's row.
        await expect.poll(() => page.evaluate(() => {
            // @ts-ignore
            const m = SillyTavern.getContext().chat[1];
            return m.mes === 'How far is the city?' && m.node_id === m.swipe_info?.[m.swipe_id]?.node_id;
        }), { timeout: 10000 }).toBe(true);
        expect(await page.evaluate(async () => {
            const { switchToAlternativePath } = await import('/scripts/node-navigation.js');
            return switchToAlternativePath(1, 0);
        })).toBe(true);
        await expect(page.locator('#chat .mes')).toHaveCount(3, { timeout: 10000 });
        await expect.poll(() => replyState(page, avatar)).toEqual(WANT);

        // The page reloaded and the chat opened again.
        await page.reload();
        await testSetup.awaitST({ page });
        await openCharacter(page, avatar);
        await expect(page.locator('#chat .mes')).toHaveCount(3, { timeout: 10000 });
        await expect.poll(() => replyState(page, avatar)).toEqual(WANT);
    });
}
