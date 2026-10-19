import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

// Upstream's saveChat() as extensions use it: they change `chat` themselves (in place, as upstream's code does) and
// ask for a save. Each change goes to the server as an action addressed by node id, never the chat array: a message's
// `mes` and `extra`, a swipe added and edited, a swipe chosen, messages pushed and popped. Checked against what the
// server stores after each step, across a branch switch and a reload.

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

/**
 * What the server stores: the chat the character opens on (each message's text and `extra.note`), and the
 * alternatives beside message `mesId` of the page's chat.
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @param {number} mesId
 */
function stored(page, avatar, mesId) {
    return page.evaluate(async ({ avatar, mesId }) => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        const headers = context.getRequestHeaders();
        const post = async (/** @type {string} */ url, /** @type {any} */ body) => (await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })).json();
        const opened = await post('/api/chats/open', { avatar_url: avatar });
        const nodeId = context.chat[mesId]?.node_id;
        const alternatives = typeof nodeId === 'string' ? await post('/api/chats/alternatives', { node_id: nodeId }) : null;
        return {
            opensOn: opened.messages.map((/** @type {any} */ m) => m.mes),
            notes: opened.messages.map((/** @type {any} */ m) => m.extra?.note ?? null),
            alternatives: alternatives?.alternatives?.map((/** @type {any} */ a) => a.mes) ?? null,
        };
    }, { avatar, mesId });
}

/** What the page shows and holds. @param {import('@playwright/test').Page} page */
function shown(page) {
    return page.evaluate(() => {
        // @ts-ignore
        const chat = SillyTavern.getContext().chat;
        return chat.map((/** @type {any} */ m) => m.mes);
    });
}

test('an extension\'s changes to chat are stored by saveChat() as node-addressed actions, across a branch switch and a reload', async ({ page }) => {
    test.setTimeout(120000);
    await testSetup.awaitST({ page });
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const avatar = await createCharacter(page, `NodeActions-${stamp}`);
    await openCharacter(page, avatar);
    await page.evaluate(async () => {
        const { ensureOpeningRow } = await import('/scripts/chat-store.js');
        await ensureOpeningRow(0);
    });

    /** @type {string[]} */
    const posts = [];
    page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (request.method() === 'POST' && path.startsWith('/api/chats/')) posts.push(path);
    });
    /** @type {string[]} */
    const warnings = [];
    page.on('console', (message) => {
        if (message.type() === 'warning' && message.text().includes('[saveChat] Not saved')) warnings.push(message.text());
    });
    const save = () => page.evaluate(async () => {
        // @ts-ignore
        await SillyTavern.getContext().saveChat();
    });

    // Messages pushed: appended after the stored greeting.
    await page.evaluate(() => {
        // @ts-ignore
        const { chat } = SillyTavern.getContext();
        const date = new Date().toISOString();
        chat.push({ name: 'User', is_user: true, is_system: false, mes: 'U1', send_date: date, extra: {} });
        chat.push({ name: 'Bot', is_user: false, is_system: false, mes: 'C1', send_date: date, extra: {} });
    });
    await save();
    expect(await stored(page, avatar, 2)).toMatchObject({ opensOn: ['Hello.', 'U1', 'C1'], alternatives: ['C1'] });

    // Changed in place, as upstream's code changes a message: its text and its extra.
    await page.evaluate(() => {
        // @ts-ignore
        const { chat } = SillyTavern.getContext();
        chat[1].mes = 'U1 edited';
        chat[2].extra.note = 'noted';
    });
    await save();
    expect(await stored(page, avatar, 2)).toMatchObject({ opensOn: ['Hello.', 'U1 edited', 'C1'], notes: [null, null, 'noted'] });

    // A swipe added beside C1, then edited by its own id; C1 itself untouched.
    await page.evaluate(() => {
        // @ts-ignore
        const { chat } = SillyTavern.getContext();
        const message = chat[2];
        message.swipes = [message.mes, 'C1 alt'];
        message.swipe_info = [{ send_date: message.send_date, extra: { ...message.extra } }, { send_date: message.send_date, extra: {} }];
        message.swipe_id = 0;
    });
    await save();
    expect(await stored(page, avatar, 2)).toMatchObject({ opensOn: ['Hello.', 'U1 edited', 'C1'], alternatives: ['C1', 'C1 alt'] });
    await page.evaluate(() => {
        // @ts-ignore
        SillyTavern.getContext().chat[2].swipes[1] = 'C1 alt edited';
    });
    await save();
    expect(await stored(page, avatar, 2)).toMatchObject({ opensOn: ['Hello.', 'U1 edited', 'C1'], alternatives: ['C1', 'C1 alt edited'] });

    // The swipe chosen on the last message, and a message pushed after it: the chat goes on below that swipe.
    await page.evaluate(() => {
        // @ts-ignore
        const { chat } = SillyTavern.getContext();
        const message = chat[2];
        message.swipe_id = 1;
        message.mes = message.swipes[1];
        message.extra = { ...message.swipe_info[1].extra };
        chat.push({ name: 'User', is_user: true, is_system: false, mes: 'U2', send_date: new Date().toISOString(), extra: {} });
    });
    await save();
    expect(await stored(page, avatar, 2)).toMatchObject({ opensOn: ['Hello.', 'U1 edited', 'C1 alt edited', 'U2'], alternatives: ['C1', 'C1 alt edited'] });

    // Back to C1 (the app's own swipe): its branch has nothing below. A save then deletes nothing of the other.
    await page.evaluate(async () => {
        const { reloadCurrentChat } = await import('/script.js');
        await reloadCurrentChat();
    });
    await expect(page.locator('#chat .mes')).toHaveCount(4, { timeout: 10000 });
    await page.locator('#chat .mes[mesid="2"] .swipe_left').click();
    await expect.poll(() => shown(page), { timeout: 10000 }).toEqual(['Hello.', 'U1 edited', 'C1']);
    await save();
    expect(await stored(page, avatar, 2)).toMatchObject({ opensOn: ['Hello.', 'U1 edited', 'C1'], alternatives: ['C1', 'C1 alt edited'] });
    await page.locator('#chat .mes[mesid="2"] .swipe_right').click();
    await expect.poll(() => shown(page), { timeout: 10000 }).toEqual(['Hello.', 'U1 edited', 'C1 alt edited', 'U2']);

    // A message popped: cut from the chat.
    await page.evaluate(() => {
        // @ts-ignore
        SillyTavern.getContext().chat.pop();
    });
    await save();
    expect(await stored(page, avatar, 2)).toMatchObject({ opensOn: ['Hello.', 'U1 edited', 'C1 alt edited'] });

    // After a reload the page shows what was stored.
    await page.reload();
    await testSetup.awaitST({ page });
    await openCharacter(page, avatar);
    await expect.poll(() => shown(page), { timeout: 10000 }).toEqual(['Hello.', 'U1 edited', 'C1 alt edited']);
    const reloaded = await page.evaluate(() => {
        // @ts-ignore
        const message = SillyTavern.getContext().chat[2];
        return { swipes: message.swipes, swipeId: message.swipe_id };
    });
    expect(reloaded).toEqual({ swipes: ['C1', 'C1 alt edited'], swipeId: 1 });

    expect(posts).not.toContain('/api/chats/save');
    expect(warnings).toEqual([]);
});

test('what saveChat() can\'t address is refused with a warning naming it, and nothing is guessed', async ({ page }) => {
    await testSetup.awaitST({ page });
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const avatar = await createCharacter(page, `NodeRefusals-${stamp}`);
    await openCharacter(page, avatar);
    await page.evaluate(async () => {
        const { ensureOpeningRow } = await import('/scripts/chat-store.js');
        await ensureOpeningRow(0);
        // @ts-ignore
        const context = SillyTavern.getContext();
        context.chat.push({ name: 'User', is_user: true, is_system: false, mes: 'U1', send_date: new Date().toISOString(), extra: {} });
        context.chat.push({ name: 'Bot', is_user: false, is_system: false, mes: 'C1', send_date: new Date().toISOString(), extra: {} });
        await context.saveChat();
    });
    expect(await stored(page, avatar, 2)).toMatchObject({ opensOn: ['Hello.', 'U1', 'C1'] });

    // Two messages naming one stored message (a copy pushed by an extension): which is meant can't be told.
    const warning = await page.evaluate(async () => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        context.chat.push({ ...context.chat[2], mes: 'C1, copied' });
        /** @type {string[]} */
        const said = [];
        const toasts = /** @type {any} */ (window).toastr;
        const original = toasts.warning;
        toasts.warning = (/** @type {string} */ text, /** @type {any[]} */ ...rest) => { said.push(text); return original(text, ...rest); };
        try {
            await context.saveChat();
        } finally {
            toasts.warning = original;
        }
        return said.join('\n');
    });
    expect(warning).toContain('message #2');
    expect(warning).toContain('message #3');
    expect(await stored(page, avatar, 2)).toMatchObject({ opensOn: ['Hello.', 'U1', 'C1'], alternatives: ['C1'] });
});

test('a change an extension made in place without asking for a save is stored by /forcesave and before a reload', async ({ page }) => {
    await testSetup.awaitST({ page });
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const avatar = await createCharacter(page, `NodeForce-${stamp}`);
    await openCharacter(page, avatar);
    await page.evaluate(async () => {
        const { ensureOpeningRow } = await import('/scripts/chat-store.js');
        await ensureOpeningRow(0);
        // @ts-ignore
        const context = SillyTavern.getContext();
        context.chat.push({ name: 'User', is_user: true, is_system: false, mes: 'U1', send_date: new Date().toISOString(), extra: {} });
        await context.saveChat();
    });
    expect(await stored(page, avatar, 1)).toMatchObject({ opensOn: ['Hello.', 'U1'] });

    // Changed in place, no save asked for: /forcesave stores it.
    await page.evaluate(async () => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        context.chat[1].mes = 'U1, forced';
        await context.executeSlashCommandsWithOptions('/forcesave');
    });
    expect(await stored(page, avatar, 1)).toMatchObject({ opensOn: ['Hello.', 'U1, forced'] });

    // Changed again, then the chat reloaded (its button): stored first, so the reload shows it.
    await page.evaluate(() => {
        // @ts-ignore
        SillyTavern.getContext().chat[1].mes = 'U1, before the reload';
        // @ts-ignore
        $('#reload_chat').trigger('click');
    });
    await expect.poll(() => stored(page, avatar, 1), { timeout: 10000 }).toMatchObject({ opensOn: ['Hello.', 'U1, before the reload'] });
    await expect.poll(() => shown(page), { timeout: 10000 }).toEqual(['Hello.', 'U1, before the reload']);
});
