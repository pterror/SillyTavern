import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// Opening a character or group is one request (POST /api/chats/open): the server resolves which conversation,
// records what was opened, and answers what the screen draws. Viewing writes nothing else: no chat name is
// minted, no chat pointer or settings are saved from the page, no itemized prompts are read or saved, and a group chat
// with no messages yet shows its members' greetings without storing them until a message follows them.

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/** @param {import('@playwright/test').Page} page @param {string} name @param {string} greeting */
async function createCharacter(page, name, greeting) {
    return page.evaluate(async ({ name, greeting }) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', greeting);
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, { name, greeting });
}

/**
 * Every request the page makes to a chat, character-pointer, settings or itemized-prompt route while `run` runs.
 * @param {import('@playwright/test').Page} page
 * @param {() => Promise<void>} run
 */
async function requestsDuring(page, run) {
    /** @type {string[]} */
    const seen = [];
    const listener = (/** @type {import('@playwright/test').Request} */ request) => {
        const path = new URL(request.url()).pathname;
        if (/^\/api\/(chats|itemized-prompts|settings|groups)\//.test(path) || path === '/api/characters/chat' || path === '/api/characters/chats') {
            // A keyed settings save of something else (a drawer, a panel) isn't the open's doing.
            if (path === '/api/settings/save-partial' && !/active_(character|group)/.test(request.postData() ?? '')) return;
            seen.push(path);
        }
    };
    page.on('request', listener);
    try {
        await run();
        await page.waitForTimeout(500);
    } finally {
        page.off('request', listener);
    }
    return seen;
}

test('opening a character is one request and writes nothing but what was opened', async ({ page }) => {
    await testSetup.awaitST({ page });
    await openCharacterManagementDrawer(page);
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const avatar = await createCharacter(page, `Open-${stamp}`, 'Welcome in.');

    await page.evaluate(async () => {
        // @ts-ignore
        await SillyTavern.getContext().getCharacters();
    });
    const seen = await requestsDuring(page, async () => {
        await page.evaluate(async (avatar) => {
            const { selectCharacterByAvatar } = await import('/script.js');
            await selectCharacterByAvatar(avatar);
        }, avatar);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toContainText('Welcome in.');
    });
    expect(seen).toEqual(['/api/chats/open']);

    const state = await page.evaluate(async (avatar) => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        const settings = await (await fetch('/api/settings/get', { method: 'POST', headers: context.getRequestHeaders(), body: '{}' })).json();
        const parsed = typeof settings.settings === 'string' ? JSON.parse(settings.settings) : settings.settings;
        return { chat: context.characters.find(c => c.avatar === avatar)?.chat ?? null, active: parsed.active_character };
    }, avatar);
    expect(state).toEqual({ chat: '', active: avatar });
});

test('a group chat with no messages shows its greetings unsaved, and stores them before the first message', async ({ page }) => {
    await testSetup.awaitST({ page });
    await openCharacterManagementDrawer(page);
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const first = await createCharacter(page, `MemberA-${stamp}`, 'A says hi.');
    const second = await createCharacter(page, `MemberB-${stamp}`, 'B says hi.');

    const groupId = await page.evaluate(async (members) => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        const response = await fetch('/api/groups/create', { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ name: `Open group ${Date.now()}`, members }) });
        if (!response.ok) throw new Error(`group create failed: ${response.status}`);
        const id = String((await response.json()).id);
        const { groupsStore } = await import('/scripts/group-chats.js');
        await context.getCharacters({ silentGroups: true });
        groupsStore.reportCreated(id);
        return id;
    }, [first, second]);

    const seen = await requestsDuring(page, async () => {
        await page.evaluate(async (id) => {
            const { openGroupById } = await import('/scripts/group-chats.js');
            await openGroupById(id);
        }, groupId);
        await expect(page.locator('#chat .mes')).toHaveCount(2);
    });
    expect(seen.filter(path => path !== '/api/groups/members')).toEqual(['/api/chats/open']);

    // The first message stores the greetings, then itself after them.
    const stored = await page.evaluate(async () => {
        const { sendMessageAsUser } = await import('/script.js');
        await sendMessageAsUser('Hello both.', '');
        // @ts-ignore
        return SillyTavern.getContext().chat.map(m => ({ mes: m.mes, node_id: m.node_id }));
    });
    expect(stored.map(m => m.mes)).toEqual(['A says hi.', 'B says hi.', 'Hello both.']);
    for (const message of stored) expect(message.node_id).toMatch(/^[0-9a-f-]{36}$/);

    await page.reload();
    await testSetup.awaitST({ page });
    await page.evaluate(async (id) => {
        const { openGroupById } = await import('/scripts/group-chats.js');
        await openGroupById(id);
    }, groupId);
    await expect(page.locator('#chat .mes')).toHaveCount(3);
    expect(await page.evaluate(() => {
        // @ts-ignore
        return SillyTavern.getContext().chat.map(m => m.mes);
    })).toEqual(['A says hi.', 'B says hi.', 'Hello both.']);
});
