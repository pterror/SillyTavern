import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string[]} greetings
 * @returns {Promise<string>}
 */
async function createCharacter(page, name, greetings) {
    return page.evaluate(async ({ name, greetings }) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', greetings[0]);
        for (const text of greetings.slice(1)) form.append('alternate_greetings', text);
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, { name, greetings });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function openCharacter(page, avatar) {
    await openCharacterManagementDrawer(page);
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        await stTest.context().getCharacters();
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
    await expect.poll(() => page.evaluate(() => {
        // @ts-ignore
        return typeof stTest.context().chat[0]?.node_id;
    }), { timeout: 10000 }).toBe('string');
}

/**
 * A chat of the opening, a question and the reply `replies[0]`, the question's other replies stored beside it, and
 * `under` stored under `replies[1]`
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @param {string[]} replies
 * @param {string} under
 */
async function chatWithReplies(page, avatar, replies, under) {
    await page.evaluate(async ({ avatar, replies, under }) => {
        // @ts-ignore
        const context = stTest.context();
        const post = async (/** @type {string} */ path, /** @type {object} */ body) => {
            const response = await fetch(path, { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, ...body }) });
            if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
            return response.json();
        };
        const said = (/** @type {string} */ mes, is_user = false) => ({ name: is_user ? 'User' : 'Bot', is_user, mes, send_date: new Date().toISOString(), extra: {} });
        const { ensureOpeningRow } = await import('/scripts/chat-store.js');
        const opening = await ensureOpeningRow(0);
        const [question, first] = (await post('/api/chats/message/append', { after_node_id: opening, messages: [said('How far is it?', true), said(replies[0])] })).node_ids;
        const others = (await post('/api/chats/message/alternative', { sibling_node_id: first, contents: replies.slice(1).map(text => said(text)) })).node_ids;
        await post('/api/chats/message/append', { after_node_id: others[0], messages: [said(under, true)] });
        await post('/api/chats/message/select', { node_id: first });
        const { openCharacterChat, getCurrentChatId } = await import('/script.js');
        await openCharacterChat(getCurrentChatId());
        return question;
    }, { avatar, replies, under });
    await expect(page.locator('#chat .mes')).toHaveCount(3, { timeout: 10000 });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} mesId
 */
function message(page, mesId) {
    return page.evaluate((mesId) => {
        // @ts-ignore
        const m = stTest.context().chat[mesId];
        return { mes: m.mes, node_id: m.node_id, swipe_id: m.swipe_id ?? 0, swipes: m.swipes ? [...m.swipes] : [] };
    }, mesId);
}

/**
 * @param {import('@playwright/test').Page} page
 */
function shownTexts(page) {
    // @ts-ignore
    return page.evaluate(() => stTest.context().chat.map(m => m.mes));
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} nodeId
 */
function storedAlternatives(page, nodeId) {
    return page.evaluate(async (nodeId) => {
        // @ts-ignore
        const context = stTest.context();
        const response = await fetch('/api/chats/alternatives', { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ node_id: nodeId }) });
        return (await response.json()).alternatives.map((/** @type {any} */ a) => a.mes);
    }, nodeId);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function openings(page, avatar) {
    return page.evaluate(async (avatar) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders();
        const response = await fetch('/api/chats/openings', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, offset: 0, limit: 100 }) });
        const body = await response.json();
        return body.alternatives.map((/** @type {any} */ a) => ({ stored: a.node_id != null, mes: a.mes }));
    }, avatar);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} swipeId
 */
async function showOpening(page, swipeId) {
    await page.evaluate(async (swipeId) => {
        const { swipe } = await import('/script.js');
        const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('/scripts/constants.js');
        // @ts-ignore
        const current = stTest.context().chat[0].swipe_id ?? 0;
        await swipe(null, swipeId > current ? SWIPE_DIRECTION.RIGHT : SWIPE_DIRECTION.LEFT, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: 0, forceSwipeId: swipeId });
    }, swipeId);
    await expect.poll(async () => (await message(page, 0)).swipe_id, { timeout: 10000 }).toBe(swipeId);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {boolean} on
 */
async function saveWhileTyping(page, on) {
    await page.evaluate(async (on) => {
        const { power_user } = await import('/scripts/power-user.js');
        power_user.auto_save_msg_edits = on;
    }, on);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} mesId
 * @param {string} text
 */
async function startEdit(page, mesId, text) {
    await page.locator(`#chat .mes[mesid="${mesId}"] .mes_edit`).click();
    await page.locator('.mes_editor .cm-content').fill(text);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} mesId
 */
async function done(page, mesId) {
    await page.locator(`#chat .mes[mesid="${mesId}"] .mes_edit_done`).click();
}

/** @param {import('@playwright/test').Page} page */
const notices = page => page.evaluate(() => document.querySelector('#toast-container')?.textContent ?? '');

/** @param {import('@playwright/test').Page} page */
async function expectNoWarnings(page) {
    await expect(page.locator('#toast-container .toast-warning, #toast-container .toast-error').filter({ hasText: /save|saved|alternative|connection/i })).toHaveCount(0);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} path
 */
const answerOf = (page, path) => page.waitForResponse(r => new URL(r.url()).pathname === path, { timeout: 10000 });

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test.describe('an edit that becomes the text of another alternative', () => {
    test.setTimeout(120000);
    test.beforeEach(testSetup.awaitST);
    test.afterEach(async ({ page }) => {
        await saveWhileTyping(page, false);
    });

    test('a reply goes to the reply with that text, with what is under it, and says so', async ({ page }) => {
        const s = stamp();
        const replies = [`Two days ${s}`, `Three days ${s}`];
        const avatar = await createCharacter(page, `SameReply-${s}`, [`Hello ${s}`]);
        await openCharacter(page, avatar);
        await chatWithReplies(page, avatar, replies, `Fine ${s}`);
        const first = (await message(page, 2)).node_id;

        await startEdit(page, 2, replies[1]);
        await done(page, 2);

        await expect.poll(() => shownTexts(page), { timeout: 10000 }).toEqual([`Hello ${s}`, 'How far is it?', replies[1], `Fine ${s}`]);
        expect((await message(page, 2)).swipe_id).toBe(1);
        await expect.poll(() => notices(page), { timeout: 10000 }).toContain('same as alternative 2');
        await expectNoWarnings(page);
        expect(await storedAlternatives(page, first)).toEqual(replies);

        await page.reload();
        await testSetup.awaitST({ page });
        await openCharacter(page, avatar);
        await expect.poll(() => shownTexts(page), { timeout: 10000 }).toEqual([`Hello ${s}`, 'How far is it?', replies[1], `Fine ${s}`]);
    });

    test('with saving while typing on, typing through another reply\'s text stays in the edit, and only Done goes to it', async ({ page }) => {
        const s = stamp();
        const replies = [`Two days ${s}`, `Three days ${s}`];
        const avatar = await createCharacter(page, `SameTyping-${s}`, [`Hello ${s}`]);
        await openCharacter(page, avatar);
        await chatWithReplies(page, avatar, replies, `Fine ${s}`);
        const first = (await message(page, 2)).node_id;
        await saveWhileTyping(page, true);

        const typed = answerOf(page, '/api/chats/message/edit');
        await startEdit(page, 2, replies[1]);
        expect((await typed).status()).toBe(409);
        await page.waitForTimeout(500);
        await expect(page.locator('.mes_editor .cm-content')).toHaveText(replies[1]);
        expect((await message(page, 2)).node_id).toBe(first);
        expect(await notices(page)).not.toContain('same as alternative');
        expect(await storedAlternatives(page, first)).toEqual(replies);

        const spaced = `${replies[1]} `;
        const saved = answerOf(page, '/api/chats/message/edit');
        await page.locator('.mes_editor .cm-content').fill(spaced);
        expect((await saved).ok()).toBe(true);
        await done(page, 2);
        await expect.poll(() => storedAlternatives(page, first), { timeout: 10000 }).toEqual([spaced, replies[1]]);
        expect((await message(page, 2)).node_id).toBe(first);
        expect(await notices(page)).not.toContain('same as alternative');
        await expectNoWarnings(page);

        const again = answerOf(page, '/api/chats/message/edit');
        await startEdit(page, 2, replies[1]);
        expect((await again).status()).toBe(409);
        await done(page, 2);
        await expect.poll(() => shownTexts(page), { timeout: 10000 }).toEqual([`Hello ${s}`, 'How far is it?', replies[1], `Fine ${s}`]);
        await expect.poll(() => notices(page), { timeout: 10000 }).toContain('same as alternative 2');
        expect(await storedAlternatives(page, first)).toEqual([spaced, replies[1]]);
        await expectNoWarnings(page);
    });

    test('a new alternative typed with the text of one there, in an empty swipe or saved as a new alternative, goes to that one', async ({ page }) => {
        const s = stamp();
        const replies = [`Two days ${s}`, `Three days ${s}`];
        const avatar = await createCharacter(page, `SameNew-${s}`, [`Hello ${s}`]);
        await openCharacter(page, avatar);
        await chatWithReplies(page, avatar, replies, `Fine ${s}`);
        const question = (await message(page, 1)).node_id;
        const first = (await message(page, 2)).node_id;

        const asked = page.locator('#chat .mes[mesid="1"]');
        await asked.hover();
        await asked.locator('.swipe_right').click({ force: true });
        await expect(asked.locator('.mes_editor .cm-content')).toBeVisible({ timeout: 10000 });
        await asked.locator('.mes_editor .cm-content').fill('How far is it?');
        await asked.locator('.mes_edit_done').click({ force: true });
        await expect.poll(() => shownTexts(page), { timeout: 10000 }).toEqual([`Hello ${s}`, 'How far is it?', replies[0]]);
        expect((await message(page, 1)).node_id).toBe(question);
        await expect.poll(() => notices(page), { timeout: 10000 }).toContain('same as alternative 1');
        expect(await storedAlternatives(page, question)).toEqual(['How far is it?']);

        await page.locator('#chat .mes[mesid="2"] .mes_edit').click();
        await page.locator('.mes_editor .cm-content').fill(replies[1]);
        await page.locator('#chat .mes[mesid="2"] .mes_edit_duplicate').click({ force: true });
        await expect.poll(() => shownTexts(page), { timeout: 10000 }).toEqual([`Hello ${s}`, 'How far is it?', replies[1], `Fine ${s}`]);
        await expect(page.locator('.mes_editor .cm-content')).toHaveCount(0);
        await expect.poll(() => notices(page), { timeout: 10000 }).toContain('same as alternative 2');
        expect(await storedAlternatives(page, first)).toEqual(replies);
        await expectNoWarnings(page);
    });

    test('a card greeting goes to the stored opening with that text, and to the card greeting with it', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `SameGreeting-${s}`, g);
        await openCharacter(page, avatar);
        const own = `Own ${s}`;
        await startEdit(page, 0, own);
        await done(page, 0);
        await expect.poll(() => openings(page, avatar), { timeout: 10000 }).toEqual([
            { stored: false, mes: g[0] }, { stored: true, mes: own }, { stored: false, mes: g[1] }, { stored: false, mes: g[2] },
        ]);
        const ownNode = (await message(page, 0)).node_id;

        await showOpening(page, 2);
        await startEdit(page, 0, own);
        await done(page, 0);
        await expect.poll(async () => (await message(page, 0)).node_id, { timeout: 10000 }).toBe(ownNode);
        expect((await message(page, 0)).swipe_id).toBe(1);
        await expect.poll(() => notices(page), { timeout: 10000 }).toContain('same as alternative 2');

        await showOpening(page, 0);
        await startEdit(page, 0, g[2]);
        await done(page, 0);
        await expect.poll(async () => (await message(page, 0)).swipe_id, { timeout: 10000 }).toBe(3);
        expect((await message(page, 0)).mes).toBe(g[2]);
        expect((await message(page, 0)).node_id.startsWith('card:')).toBe(true);
        await expect.poll(() => notices(page), { timeout: 10000 }).toContain('same as alternative 4');
        expect(await openings(page, avatar)).toEqual([
            { stored: false, mes: g[0] }, { stored: true, mes: own }, { stored: false, mes: g[1] }, { stored: false, mes: g[2] },
        ]);
        await expectNoWarnings(page);

        await page.reload();
        await testSetup.awaitST({ page });
        await openCharacter(page, avatar);
        expect((await message(page, 0)).mes).toBe(g[2]);
    });

    test('a stored opening goes to the stored opening, or the card greeting, with that text', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `SameOpening-${s}`, g);
        await openCharacter(page, avatar);
        await startEdit(page, 0, `Own ${s}`);
        await done(page, 0);
        await expect.poll(async () => (await message(page, 0)).swipes, { timeout: 10000 }).toEqual([g[0], `Own ${s}`, g[1], g[2]]);
        await showOpening(page, 2);
        await startEdit(page, 0, `Other ${s}`);
        await done(page, 0);
        await expect.poll(async () => (await message(page, 0)).swipes, { timeout: 10000 }).toEqual([g[0], `Own ${s}`, g[1], `Other ${s}`, g[2]]);
        const other = (await message(page, 0)).node_id;

        await startEdit(page, 0, `Own ${s}`);
        await done(page, 0);
        await expect.poll(async () => (await message(page, 0)).swipe_id, { timeout: 10000 }).toBe(1);
        await expect.poll(() => notices(page), { timeout: 10000 }).toContain('same as alternative 2');
        expect(await openings(page, avatar)).toEqual([
            { stored: false, mes: g[0] }, { stored: true, mes: `Own ${s}` }, { stored: false, mes: g[1] }, { stored: true, mes: `Other ${s}` }, { stored: false, mes: g[2] },
        ]);

        await showOpening(page, 3);
        expect((await message(page, 0)).node_id).toBe(other);
        await startEdit(page, 0, g[1]);
        await done(page, 0);
        await expect.poll(async () => (await message(page, 0)).swipe_id, { timeout: 10000 }).toBe(2);
        expect((await message(page, 0)).node_id.startsWith('card:')).toBe(true);
        await expect.poll(() => notices(page), { timeout: 10000 }).toContain('same as alternative 3');
        expect(await openings(page, avatar)).toEqual([
            { stored: false, mes: g[0] }, { stored: true, mes: `Own ${s}` }, { stored: false, mes: g[1] }, { stored: true, mes: `Other ${s}` }, { stored: false, mes: g[2] },
        ]);
        await expectNoWarnings(page);
    });

    test('with saving while typing on, a card greeting typed through another greeting\'s text stays in the edit', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`];
        const avatar = await createCharacter(page, `SameGreetingTyping-${s}`, g);
        await openCharacter(page, avatar);
        await saveWhileTyping(page, true);

        const typed = answerOf(page, '/api/chats/message/select');
        await startEdit(page, 0, g[1]);
        expect((await typed).status()).toBe(409);
        await page.waitForTimeout(500);
        await expect(page.locator('.mes_editor .cm-content')).toHaveText(g[1]);
        expect((await message(page, 0)).swipe_id).toBe(0);
        expect(await notices(page)).not.toContain('same as alternative');
        expect(await openings(page, avatar)).toEqual([{ stored: false, mes: g[0] }, { stored: false, mes: g[1] }]);

        const stored = answerOf(page, '/api/chats/message/select');
        await page.locator('.mes_editor .cm-content').fill(`${g[1]}!`);
        expect((await stored).ok()).toBe(true);
        await done(page, 0);
        await expect.poll(() => openings(page, avatar), { timeout: 10000 }).toEqual([
            { stored: false, mes: g[0] }, { stored: true, mes: `${g[1]}!` }, { stored: false, mes: g[1] },
        ]);
        expect(await notices(page)).not.toContain('same as alternative');
        await expectNoWarnings(page);
    });
    test('a message by another persona with the same name and text is another alternative: the edit stays', async ({ page }) => {
        const s = stamp();
        const avatar = await createCharacter(page, `SameAuthor-${s}`, [`Hello ${s}`]);
        await openCharacter(page, avatar);
        await chatWithReplies(page, avatar, [`Two days ${s}`, `Three days ${s}`], `Fine ${s}`);
        const question = (await message(page, 1)).node_id;
        const other = `Far ${s}`;
        await page.evaluate(async ({ avatar, question, other, s }) => {
            // @ts-ignore
            const context = stTest.context();
            const body = { avatar_url: avatar, sibling_node_id: question, contents: [{ name: 'User', is_user: true, persona: `other-${s}.png`, mes: other, send_date: new Date().toISOString(), extra: {} }] };
            const response = await fetch('/api/chats/message/alternative', { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify(body) });
            if (!response.ok) throw new Error(`alternative failed: ${response.status}`);
        }, { avatar, question, other, s });
        expect(await storedAlternatives(page, question)).toEqual(['How far is it?', other]);

        const saved = answerOf(page, '/api/chats/message/edit');
        const asked = page.locator('#chat .mes[mesid="1"]');
        await asked.locator('.mes_edit').dispatchEvent('click');
        await page.locator('.mes_editor .cm-content').fill(other);
        await asked.locator('.mes_edit_done').dispatchEvent('click');
        expect((await saved).ok()).toBe(true);
        await expect.poll(() => storedAlternatives(page, question), { timeout: 10000 }).toEqual([other, other]);
        expect((await message(page, 1)).node_id).toBe(question);
        expect(await shownTexts(page)).toEqual([`Hello ${s}`, other, `Two days ${s}`]);
        expect(await notices(page)).not.toContain('same as alternative');
        await expectNoWarnings(page);
    });
});
