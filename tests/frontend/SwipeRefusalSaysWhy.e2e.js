import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';
import { hashGreetingText } from '../../src/greeting-ops.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string[]} greetings the first is the default
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
        return (await response.text()).trim();
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
    await expect.poll(() => page.evaluate((avatar) => {
        // @ts-ignore
        const context = stTest.context();
        return context.characters[context.characterId]?.avatar === avatar && typeof context.chat[0]?.node_id === 'string';
    }, avatar), { timeout: 10000 }).toBe(true);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string[]} members
 * @returns {Promise<string>}
 */
async function openNewGroup(page, members) {
    const id = await page.evaluate(async (members) => {
        // @ts-ignore
        const ctx = stTest.context();
        const response = await fetch('/api/groups/create', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ name: `Group ${Date.now()}`, members }) });
        if (!response.ok) throw new Error(`group create failed: ${response.status}`);
        return String((await response.json()).id);
    }, members);
    await page.evaluate(async (groupId) => {
        // @ts-ignore
        await stTest.context().getCharacters();
        const { openGroupById } = await import('/scripts/group-chats.js');
        await openGroupById(groupId);
    }, id);
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
    return id;
}

/**
 * Another tab of the same user, where changes are made behind the first tab's back
 * @param {import('@playwright/test').Page} page
 */
async function otherTab(page) {
    const other = await page.context().newPage();
    await other.goto(new URL('/', page.url()).href);
    await testSetup.awaitST({ page: other });
    return other;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} path
 * @param {object} body
 */
async function post(page, path, body) {
    return page.evaluate(async ({ path, body }) => {
        // @ts-ignore
        const response = await fetch(path, { method: 'POST', headers: stTest.context().getRequestHeaders(), body: JSON.stringify(body) });
        return { status: response.status, body: await response.json().catch(() => null) };
    }, { path, body });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} mesId
 */
async function shown(page, mesId) {
    return page.evaluate((mesId) => {
        // @ts-ignore
        const m = stTest.context().chat[mesId];
        return { mes: m.mes, swipe_id: m.swipe_id ?? 0 };
    }, mesId);
}

/**
 * Swipes message `mesId` to its alternative `swipeId` and answers the server's answer to the switch
 * @param {import('@playwright/test').Page} page
 * @param {number} mesId
 * @param {number} swipeId
 * @param {{ answered?: boolean }} [options] answered: false when the switch gets no answer
 */
async function swipeTo(page, mesId, swipeId, { answered = true } = {}) {
    const asked = answered ? page.waitForResponse(r => ['/api/chats/openings/choose', '/api/chats/message/select'].includes(new URL(r.url()).pathname), { timeout: 10000 }) : Promise.resolve(null);
    await page.evaluate(async ({ mesId, swipeId }) => {
        const { swipe } = await import('/script.js');
        const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('/scripts/constants.js');
        // @ts-ignore
        const current = stTest.context().chat[mesId].swipe_id ?? 0;
        await swipe(null, swipeId > current ? SWIPE_DIRECTION.RIGHT : SWIPE_DIRECTION.LEFT, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: mesId, forceSwipeId: swipeId });
    }, { mesId, swipeId });
    const response = await asked;
    return response ? { status: response.status(), body: await response.json().catch(() => null) } : null;
}

const notSaved = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#toast-container .toast-warning', { hasText: 'Not saved' });

test.describe('a switch to an alternative the server didn\'t save says why', () => {
    test.beforeEach(testSetup.awaitST);

    test('a page older than the server says to reload', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `Stale-${s}`, g);
        await openCharacter(page, avatar);
        await page.evaluate(() => document.querySelector('meta[name="st-build"]')?.setAttribute('content', 'a build before the server\'s'));
        await page.route('**/api/chats/openings/choose', async (route) => {
            const { greeting_id: _id, expected_hash: _hash, ...rest } = route.request().postDataJSON();
            await route.continue({ postData: JSON.stringify({ ...rest, text: g[1], index: 1 }) });
        });

        const answer = await swipeTo(page, 0, 1);
        expect(answer?.status).toBe(400);
        await expect(notSaved(page)).toContainText('SillyTavern was updated and this page is older than the server. Reload the page, then switch again.');
        await expect.poll(() => shown(page, 0)).toEqual({ mes: g[0], swipe_id: 0 });
    });

    test('a greeting deleted in another tab: the card no longer has it', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `Gone-${s}`, g);
        await openCharacter(page, avatar);
        const other = await otherTab(page);
        expect((await post(other, '/api/characters/greetings/delete', { avatar_url: avatar, position: 2, expected_hash: hashGreetingText(g[2]) })).status).toBe(200);
        await other.close();

        const answer = await swipeTo(page, 0, 2);
        expect(answer).toMatchObject({ status: 409, body: { ok: false, reason: 'no such greeting' } });
        await expect(notSaved(page)).toContainText('The switch to this greeting wasn\'t saved, because the greeting was deleted from the character\'s card. The message is back as it was.');
        expect((await shown(page, 0)).mes).toBe(g[0]);
    });

    test('a greeting edited in another tab: its text was changed', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`];
        const avatar = await createCharacter(page, `Changed-${s}`, g);
        await openCharacter(page, avatar);
        const other = await otherTab(page);
        expect((await post(other, '/api/characters/greetings/edit', { avatar_url: avatar, position: 1, expected_hash: hashGreetingText(g[1]), text: `One edited ${s}` })).status).toBe(200);
        await other.close();

        const answer = await swipeTo(page, 0, 1);
        expect(answer).toMatchObject({ status: 409, body: { ok: false, reason: 'the greeting changed' } });
        await expect(notSaved(page)).toContainText('The switch to this greeting wasn\'t saved, because its text was changed elsewhere since this page showed it. The message is back as it was; reopen the chat to see the greeting as it is now.');
        expect((await shown(page, 0)).mes).toBe(g[0]);
    });

    test('a group member removed in another tab: its character is no longer in this chat', async ({ page }) => {
        const s = stamp();
        const ann = await createCharacter(page, `MemberAnn-${s}`, [`Ann ${s}`]);
        const bo = await createCharacter(page, `MemberBo-${s}`, [`Bo ${s}`]);
        const groupId = await openNewGroup(page, [ann, bo]);
        const other = await otherTab(page);
        expect((await post(other, '/api/groups/members', { id: groupId, op: 'remove', avatar: bo })).status).toBe(200);
        await other.close();

        const answer = await swipeTo(page, 0, 1);
        expect(answer).toMatchObject({ status: 409, body: { ok: false, reason: 'not in this chat' } });
        await expect(notSaved(page)).toContainText('The switch to this greeting wasn\'t saved, because its character is no longer in this chat. The message is back as it was.');
    });

    test('a reply alternative deleted in another tab: the alternative was deleted', async ({ page }) => {
        const s = stamp();
        const avatar = await createCharacter(page, `ReplyGone-${s}`, [`Hello ${s}`]);
        await openCharacter(page, avatar);
        await page.evaluate(async (s) => {
            // @ts-ignore
            const { executeSlashCommandsWithOptions: run } = stTest.context();
            await run(`/send hi ${s}`);
            await run(`/sendas name={{char}} first ${s}`);
            await run(`/addswipe switch=true second ${s}`);
        }, s);
        await expect.poll(() => shown(page, 2)).toEqual({ mes: `second ${s}`, swipe_id: 1 });
        const first = await page.evaluate(() => {
            // @ts-ignore
            return stTest.context().chat[2].swipe_info[0].node_id;
        });
        const other = await otherTab(page);
        const deleted = await post(other, '/api/chats/message/alternative/delete', { avatar_url: avatar, node_id: first, preview: true });
        expect(deleted.status).toBe(200);
        expect((await post(other, '/api/chats/message/alternative/delete', { avatar_url: avatar, node_id: first, confirm: deleted.body.confirm })).status).toBe(200);
        await other.close();

        const answer = await swipeTo(page, 2, 0);
        expect(answer).toMatchObject({ status: 409, body: { ok: false, reason: 'unknown node' } });
        await expect(notSaved(page)).toContainText('The switch to this alternative wasn\'t saved, because the alternative was deleted. The message is back as it was.');
        expect(await shown(page, 2)).toEqual({ mes: `second ${s}`, swipe_id: 1 });
    });

    test('a server that can\'t be reached: it says so', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`];
        const avatar = await createCharacter(page, `Unreached-${s}`, g);
        await openCharacter(page, avatar);
        await page.route('**/api/chats/openings/choose', route => route.abort('connectionrefused'));

        await swipeTo(page, 0, 1, { answered: false });
        await expect(notSaved(page)).toContainText('The switch to this alternative wasn\'t saved, because the server couldn\'t be reached. The message is back as it was.');
        await expect.poll(() => shown(page, 0)).toEqual({ mes: g[0], swipe_id: 0 });
    });
});

test.describe('a greeting\'s macros are kept as written', () => {
    test.beforeEach(testSetup.awaitST);

    test('a greeting with {{user}} is chosen after the persona changes, and stored with its macros as written', async ({ page }) => {
        const s = stamp();
        const g = [`Hi {{user}} ${s}`, `{{char}} waves at {{user}} ${s}`];
        const avatar = await createCharacter(page, `RawMacros-${s}`, g);
        await openCharacter(page, avatar);
        await page.evaluate(async () => {
            const { setUserName } = await import('/script.js');
            setUserName(`Someone else ${Date.now()}`);
        });

        const answer = await swipeTo(page, 0, 1);
        expect(answer?.status).toBe(200);
        expect((await shown(page, 0)).mes).toBe(g[1]);
        await page.evaluate(async (s) => {
            // @ts-ignore
            await stTest.context().executeSlashCommandsWithOptions(`/send hi ${s}`);
        }, s);
        const stored = await page.evaluate(async (avatar) => {
            // @ts-ignore
            const headers = stTest.context().getRequestHeaders();
            const response = await fetch('/api/chats/openings', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, offset: 0, limit: 100 }) });
            return (await response.json()).alternatives.filter((/** @type {any} */ a) => a.node_id != null).map((/** @type {any} */ a) => ({ mes: a.mes, greeting: a.greeting }));
        }, avatar);
        expect(stored).toEqual([{ mes: g[1], greeting: { id: 1, hash: hashGreetingText(g[1]), avatar } }]);
        await expect(notSaved(page)).toHaveCount(0);
    });
});
