import { test, expect } from './fixtures.js';
import { greetingRow, greetingsList, listAdd, listDelete, listEdit, listMoveToEnd, listToggleDefault, openGreetingsList } from './alternatives-list.js';
import { testSetup, openCharacterManagementDrawer, openInfoTab } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function awaitAppReady(page) {
    await page.evaluate(() => new Promise((resolve) => {
        // @ts-ignore
        const ctx = stTest.context();
        ctx.eventSource.once(ctx.eventTypes.APP_READY, resolve);
    }));
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
 * @param {string} name
 * @param {string[]} texts
 * @returns {Promise<string[]>}
 */
async function storeOpenings(page, avatar, name, texts) {
    return page.evaluate(async ({ avatar, name, texts }) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders();
        const contents = texts.map(mes => ({ name, is_user: false, is_system: false, send_date: Date.now(), mes, extra: {} }));
        const post = async (url, body) => {
            const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
            if (!response.ok) throw new Error(`${url} failed: ${response.status}`);
            return response.json();
        };
        const selected = await post('/api/chats/message/select', { avatar_url: avatar, opening: { refs: ['opening'], messages: [contents[0]] } });
        const first = selected.stored.find((/** @type {any} */ s) => s.ref === 'opening').node_id;
        if (contents.length === 1) return [first];
        const added = await post('/api/chats/message/alternative', { avatar_url: avatar, sibling_node_id: first, contents: contents.slice(1) });
        return [first, ...added.node_ids];
    }, { avatar, name, texts });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @returns {Promise<{total: number, stored: number, alternatives: {node_id: string|null, mes: string}[]}>}
 */
async function fetchOpenings(page, avatar) {
    return page.evaluate(async (avatar) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders();
        const response = await fetch('/api/chats/openings', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, offset: 0, limit: 1000 }) });
        const body = await response.json();
        return {
            total: body.total,
            stored: body.stored,
            alternatives: body.alternatives.map(a => ({ node_id: a.node_id, mes: a.mes })),
        };
    }, avatar);
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
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function openingState(page) {
    return page.evaluate(() => {
        // @ts-ignore
        const chat = stTest.context().chat;
        const m = chat[0];
        return {
            length: chat.length,
            mes: m?.mes,
            node_id: m?.node_id,
            swipe_id: m?.swipe_id,
            swipes: m?.swipes ? [...m.swipes] : undefined,
            swipe_node_ids: m?.swipe_info ? m.swipe_info.map(i => i?.node_id ?? null) : undefined,
        };
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} swipeId
 * @param {string} text
 */
async function showSwipe(page, swipeId, text) {
    await page.evaluate(async (swipeId) => {
        const { swipe } = await import('/script.js');
        const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('/scripts/constants.js');
        // @ts-ignore
        const current = stTest.context().chat[0].swipe_id ?? 0;
        const direction = swipeId > current ? SWIPE_DIRECTION.RIGHT : SWIPE_DIRECTION.LEFT;
        await swipe(null, direction, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: 0, forceSwipeId: swipeId });
    }, swipeId);
    await expect.poll(async () => (await openingState(page)).mes, { timeout: 10000 }).toBe(text);
    await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(text);
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {{writes: string[], openingBodies: any[], landingBodies: any[]}}
 */
function recordChatRequests(page) {
    const record = { writes: [], openingBodies: [], landingBodies: [] };
    page.on('request', (request) => {
        if (request.method() !== 'POST') return;
        const path = new URL(request.url()).pathname;
        if (!path.startsWith('/api/chats/')) return;
        if (path === '/api/chats/openings') {
            record.openingBodies.push(request.postDataJSON());
            return;
        }
        if (path === '/api/chats/openings/land') {
            record.landingBodies.push(request.postDataJSON());
            return;
        }
        record.writes.push(path);
    });
    return record;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} op
 */
function greetingOpResponse(page, op) {
    return page.waitForResponse(response => new URL(response.url()).pathname === `/api/characters/greetings/${op}`, { timeout: 15000 });
}

const openGreetingsPopup = openGreetingsList;
const popupEdit = listEdit;
const popupAdd = listAdd;
const popupMove = listMoveToEnd;
const popupSetDefault = listToggleDefault;
const popupUnsetDefault = listToggleDefault;

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} index
 * @param {number} remaining
 */
async function popupDelete(page, index, remaining) {
    await listDelete(page, index);
    await expect(greetingsList(page).locator('li.alternative')).toHaveCount(remaining, { timeout: 10000 });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @returns {Promise<string>}
 */
async function createPersona(page, name) {
    return page.evaluate(async (name) => {
        // @ts-ignore
        const commands = stTest.context().SlashCommandParser.commands;
        return String(await commands['persona-create'].callback({ name, select: 'false' }));
    }, name);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatarId
 */
async function switchPersona(page, avatarId) {
    await page.evaluate(async (avatarId) => {
        const { setUserAvatar } = await import('/scripts/personas.js');
        await setUserAvatar(avatarId);
    }, avatarId);
}

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test.describe('provisional greeting follows greeting saves', () => {
    test.beforeEach(testSetup.awaitST);

    test('editing the showing greeting in the sidebar pager keeps it shown with its new text', async ({ page }) => {
        const s = stamp();
        const name = `ProvEdit-${s}`;
        const [g0, g1, g2] = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, name, [g0, g1, g2]);
        await openCharacter(page, avatar);
        await showSwipe(page, 1, g1);
        const before = await openingState(page);
        expect(before.node_id.startsWith('card:')).toBe(true);

        const requests = recordChatRequests(page);
        const edited = `One edited ${s}`;
        await openInfoTab(page, 'greeting');
        await page.locator('.greeting-pager-next').click();
        await expect(page.locator('#greeting_field')).toHaveValue(g1);
        const response = greetingOpResponse(page, 'edit');
        await page.locator('.field_edit_toggle[data-for="greeting_field"]').click();
        await page.locator('#greeting_field').fill(edited);
        await page.locator('.field_edit_done[data-for="greeting_field"]').click();
        expect((await response).ok()).toBe(true);

        await expect.poll(async () => (await openingState(page)).mes, { timeout: 10000 }).toBe(edited);
        const after = await openingState(page);
        expect(after.length).toBe(1);
        expect(after.swipes).toEqual([g0, edited, g2]);
        expect(after.swipe_id).toBe(1);
        expect(after.node_id.startsWith('card:')).toBe(true);
        expect(after.node_id).not.toBe(before.node_id);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(edited);

        expect(requests.writes).toEqual([]);
        expect((await fetchOpenings(page, avatar)).stored).toBe(0);
    });

    test('deleting the showing greeting when it was last shows the opening before it', async ({ page }) => {
        const s = stamp();
        const [g0, g1, g2] = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `ProvDelete-${s}`, [g0, g1, g2]);
        await openCharacter(page, avatar);
        await showSwipe(page, 2, g2);

        const requests = recordChatRequests(page);
        await openGreetingsPopup(page, 3);
        await popupDelete(page, 2, 2);

        await expect.poll(async () => (await openingState(page)).mes, { timeout: 10000 }).toBe(g1);
        const after = await openingState(page);
        expect(after.length).toBe(1);
        expect(after.swipes).toEqual([g0, g1]);
        expect(after.swipe_id).toBe(1);
        expect(after.node_id.startsWith('card:')).toBe(true);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(g1);

        expect(requests.writes).toEqual([]);
        expect((await fetchOpenings(page, avatar)).stored).toBe(0);
    });

    test('add, edit of another greeting, move, default set and unset rebuild the swipes and keep the showing greeting', async ({ page }) => {
        const s = stamp();
        const [g0, g1, g2] = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `ProvOtherOps-${s}`, [g0, g1, g2]);
        await openCharacter(page, avatar);
        await showSwipe(page, 1, g1);
        const shownId = (await openingState(page)).node_id;

        const requests = recordChatRequests(page);
        await openGreetingsPopup(page, 3);

        /**
         * @param {string[]} swipes
         * @param {number} swipeId
         */
        const expectShowing = async (swipes, swipeId) => {
            await expect.poll(async () => (await openingState(page)).swipes, { timeout: 10000 }).toEqual(swipes);
            const state = await openingState(page);
            expect(state.length).toBe(1);
            expect(state.mes).toBe(g1);
            expect(state.node_id).toBe(shownId);
            expect(state.swipe_id).toBe(swipeId);
            await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(g1);
        };

        const g3 = `Three ${s}`;
        await popupAdd(page, g3);
        await expectShowing([g0, g1, g2, g3], 1);

        const g2e = `Two edited ${s}`;
        await popupEdit(page, 2, g2e);
        await expectShowing([g0, g1, g2e, g3], 1);

        await popupMove(page, 1);
        await expectShowing([g0, g2e, g3, g1], 3);

        await expect(greetingsList(page).locator('li.alternative')).toHaveCount(4, { timeout: 10000 });
        await popupSetDefault(page, 1);
        await expect(greetingRow(page, 1).locator('.alternative-default')).toHaveAttribute('aria-pressed', 'true');
        await expectShowing([g0, g2e, g3, g1], 3);

        await popupUnsetDefault(page, 1);
        await expect(greetingRow(page, 1).locator('.alternative-default')).toHaveAttribute('aria-pressed', 'false');
        await expectShowing([g0, g2e, g3, g1], 3);

        expect(requests.writes).toEqual([]);
        expect((await fetchOpenings(page, avatar)).stored).toBe(0);
    });

    test('with more than 11 openings, deleting a showing greeting outside the first window shows the next opening', async ({ page }) => {
        const s = stamp();
        const greetings = Array.from({ length: 14 }, (_, i) => `Greeting ${i} ${s}`);
        const avatar = await createCharacter(page, `ProvWide-${s}`, greetings);
        await openCharacter(page, avatar);
        const loaded = await openingState(page);
        expect(loaded.swipes).toHaveLength(14);
        expect(loaded.swipes[12]).toBeNull();

        await showSwipe(page, 12, greetings[12]);

        const requests = recordChatRequests(page);
        await openGreetingsPopup(page, 14);
        await popupDelete(page, 12, 13);

        await expect.poll(async () => (await openingState(page)).mes, { timeout: 10000 }).toBe(greetings[13]);
        const after = await openingState(page);
        expect(after.length).toBe(1);
        expect(after.swipes).toEqual(greetings.filter((_, i) => i !== 12));
        expect(after.swipe_id).toBe(12);
        expect(after.node_id.startsWith('card:')).toBe(true);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(greetings[13]);

        expect(requests.writes).toEqual([]);
        expect((await fetchOpenings(page, avatar)).stored).toBe(0);
    });

    test('deleting the showing greeting shows the next opening and leaves the stored default row as it is, in memory', async ({ page }) => {
        const s = stamp();
        const name = `ProvStoredDefault-${s}`;
        const [d, a, b] = [`Default ${s}`, `Alpha ${s}`, `Beta ${s}`];
        const avatar = await createCharacter(page, name, [d, a, b]);
        const [dId] = await storeOpenings(page, avatar, name, [d]);
        const storedBefore = await fetchOpenings(page, avatar);
        expect(storedBefore.stored).toBe(1);

        await openCharacter(page, avatar);
        const loaded = await openingState(page);
        expect(loaded.node_id).toBe(dId);
        expect(loaded.swipes).toEqual([d, a, b]);

        await showSwipe(page, 1, a);
        expect((await openingState(page)).node_id.startsWith('card:')).toBe(true);

        const requests = recordChatRequests(page);
        await openGreetingsPopup(page, 3);
        await popupDelete(page, 1, 2);

        await expect.poll(async () => (await openingState(page)).mes, { timeout: 10000 }).toBe(b);
        const after = await openingState(page);
        expect(after.length).toBe(1);
        expect(after.node_id.startsWith('card:')).toBe(true);
        expect(after.swipe_id).toBe(1);
        expect(after.swipes).toEqual([d, b]);
        expect(after.swipe_node_ids[0]).toBe(dId);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(b);

        expect(requests.writes).toEqual([]);
        const storedAfter = await fetchOpenings(page, avatar);
        expect(storedAfter.alternatives.filter(x => x.node_id)).toEqual(storedBefore.alternatives.filter(x => x.node_id));
    });

    test('editing the showing greeting into a stored opening\'s text inside the loaded window swaps onto that row in memory', async ({ page }) => {
        const s = stamp();
        const name = `ProvCollideIn-${s}`;
        const [g0, a, b] = [`Zero ${s}`, `Alpha ${s}`, `Beta ${s}`];
        const stored = `Stored ${s}`;
        const avatar = await createCharacter(page, name, [g0, a, b]);
        const [storedId] = await storeOpenings(page, avatar, name, [stored]);
        const storedBefore = await fetchOpenings(page, avatar);

        await openCharacter(page, avatar);
        const loaded = await openingState(page);
        expect(loaded.swipes).toEqual([stored, g0, a, b]);

        await showSwipe(page, 2, a);
        expect((await openingState(page)).node_id.startsWith('card:')).toBe(true);

        const requests = recordChatRequests(page);
        await openGreetingsPopup(page, 3);
        await popupEdit(page, 1, stored);

        await expect.poll(async () => (await openingState(page)).node_id, { timeout: 10000 }).toBe(storedId);
        const after = await openingState(page);
        expect(after.length).toBe(1);
        expect(after.mes).toBe(stored);
        expect(after.swipe_id).toBe(0);
        expect(after.swipes).toEqual([stored, g0, b]);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(stored);

        expect(requests.writes).toEqual([]);
        const storedAfter = await fetchOpenings(page, avatar);
        expect(storedAfter.alternatives.filter(x => x.node_id)).toEqual(storedBefore.alternatives.filter(x => x.node_id));
    });

    test('editing the showing greeting into a stored opening\'s text outside the loaded window finds it through the server and swaps in memory', async ({ page }) => {
        const s = stamp();
        const name = `ProvCollideOut-${s}`;
        const [g0, a] = [`Zero ${s}`, `Alpha ${s}`];
        const avatar = await createCharacter(page, name, [g0, a]);
        const storedTexts = Array.from({ length: 60 }, (_, i) => `Stored ${i} ${s}`);
        const storedIds = await storeOpenings(page, avatar, name, storedTexts);
        const target = storedTexts[30];
        const storedBefore = await fetchOpenings(page, avatar);
        expect(storedBefore.stored).toBe(60);

        await openCharacter(page, avatar);
        const loaded = await openingState(page);
        expect(loaded.swipes).toHaveLength(62);

        await showSwipe(page, 61, a);
        const showing = await openingState(page);
        expect(showing.node_id.startsWith('card:')).toBe(true);
        expect(showing.swipes[30]).toBeNull();

        const requests = recordChatRequests(page);
        await openGreetingsPopup(page, 2);
        await popupEdit(page, 1, target);

        await expect.poll(async () => (await openingState(page)).node_id, { timeout: 10000 }).toBe(storedIds[30]);
        const after = await openingState(page);
        expect(after.length).toBe(1);
        expect(after.mes).toBe(target);
        expect(after.swipe_id).toBe(30);
        expect(after.swipes).toHaveLength(61);
        expect(after.swipes[30]).toBe(target);
        expect(after.swipes[60]).toBe(g0);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(target);

        expect(requests.landingBodies.some(body => body?.edits?.some(edit => edit.to === target))).toBe(true);
        expect(requests.writes).toEqual([]);
        const storedAfter = await fetchOpenings(page, avatar);
        expect(storedAfter.alternatives.filter(x => x.node_id)).toEqual(storedBefore.alternatives.filter(x => x.node_id));
    });
});

test.describe('persona switch redraws message 0', () => {
    test.beforeEach(testSetup.awaitST);
    test.beforeEach(async ({ page }) => awaitAppReady(page));

    test('solo chat on a provisional greeting', async ({ page }) => {
        const s = stamp();
        const first = await createPersona(page, `PersonaFirst${s}`);
        const second = await createPersona(page, `PersonaSecond${s}`);
        await switchPersona(page, first);

        const avatar = await createCharacter(page, `PersonaProv-${s}`, ['Hello {{user}}!']);
        await openCharacter(page, avatar);
        expect((await openingState(page)).node_id.startsWith('card:')).toBe(true);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(`Hello PersonaFirst${s}!`);

        await switchPersona(page, second);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(`Hello PersonaSecond${s}!`);
        expect((await openingState(page)).mes).toBe('Hello {{user}}!');
    });

    test('solo chat with a reply, on a stored greeting', async ({ page }) => {
        const s = stamp();
        const first = await createPersona(page, `PersonaFirst${s}`);
        const second = await createPersona(page, `PersonaSecond${s}`);
        await switchPersona(page, first);

        const avatar = await createCharacter(page, `PersonaStored-${s}`, ['Hello {{user}}!']);
        await openCharacter(page, avatar);
        await page.evaluate(async () => {
            // @ts-ignore
            const commands = stTest.context().SlashCommandParser.commands;
            await commands['send'].callback({}, 'a reply');
        });
        await expect.poll(async () => {
            const state = await openingState(page);
            return state.length === 2 && !state.node_id.startsWith('card:');
        }, { timeout: 10000 }).toBe(true);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(`Hello PersonaFirst${s}!`);

        await switchPersona(page, second);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(`Hello PersonaSecond${s}!`);
    });

    test('group chat whose message 0 was edited to hold a macro', async ({ page }) => {
        const s = stamp();
        const first = await createPersona(page, `PersonaFirst${s}`);
        const second = await createPersona(page, `PersonaSecond${s}`);
        await switchPersona(page, first);

        const avatar = await createCharacter(page, `PersonaGroupMember-${s}`, [`Plain greeting ${s}`]);
        const groupId = await page.evaluate(async ({ avatar, name }) => {
            // @ts-ignore
            const ctx = stTest.context();
            const response = await fetch('/api/groups/create', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ name, members: [avatar] }) });
            const data = await response.json();
            const { openGroupById } = await import('/scripts/group-chats.js');
            await openGroupById(String(data.id));
            return String(data.id);
        }, { avatar, name: `PersonaGroup-${s}` });
        expect(groupId).not.toBe('');

        await page.evaluate(async () => {
            const { ensureOpeningRow } = await import('/scripts/chat-store.js');
            await ensureOpeningRow(0);
        });
        await expect.poll(async () => {
            const state = await openingState(page);
            return typeof state.node_id === 'string' && !state.node_id.startsWith('card:');
        }, { timeout: 10000 }).toBe(true);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(`Plain greeting ${s}`);

        const editResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/chats/message/edit', { timeout: 15000 });
        await page.evaluate(async () => {
            const { updateMessage, chatOpEdit } = await import('/scripts/chat-store.js');
            const { updateMessageBlock } = await import('/script.js');
            const { chat } = await import('/scripts/chat-state.js');
            updateMessage(0, { mes: 'Hello {{user}}!' });
            updateMessageBlock(0, chat[0]);
            await chatOpEdit(0);
        });
        expect((await editResponse).ok()).toBe(true);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(`Hello PersonaFirst${s}!`);

        await switchPersona(page, second);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(`Hello PersonaSecond${s}!`);
    });
});
