import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

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
 * @param {string} name
 * @param {string[]} members
 * @returns {Promise<string>}
 */
async function openNewGroup(page, name, members) {
    const id = await page.evaluate(async ({ name, members }) => {
        // @ts-ignore
        const ctx = stTest.context();
        await ctx.getCharacters();
        const response = await fetch('/api/groups/create', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ name, members }) });
        if (!response.ok) throw new Error(`group create failed: ${response.status}`);
        const data = await response.json();
        const { openGroupById } = await import('/scripts/group-chats.js');
        await openGroupById(String(data.id));
        return String(data.id);
    }, { name, members });
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
    return id;
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function opening(page) {
    return page.evaluate(() => {
        // @ts-ignore
        const chat = stTest.context().chat;
        const m = chat[0];
        return {
            length: chat.length,
            mes: m.mes,
            name: m.name,
            original_avatar: m.original_avatar,
            node_id: m.node_id,
            swipe_id: m.swipe_id,
            swipes: [...m.swipes],
        };
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} groupId
 */
async function listedOpenings(page, groupId) {
    return page.evaluate(async (groupId) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders();
        const response = await fetch('/api/chats/openings', { method: 'POST', headers, body: JSON.stringify({ group_id: groupId, offset: 0, limit: 100 }) });
        const body = await response.json();
        return body.alternatives.map((/** @type {any} */ a) => ({ stored: a.node_id != null, mes: a.mes, by: a.original_avatar }));
    }, groupId);
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
    await expect.poll(async () => (await opening(page)).swipe_id, { timeout: 10000 }).toBe(swipeId);
}

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test.describe('a group chat\'s first message', () => {
    test.beforeEach(testSetup.awaitST);

    test('offers every member\'s greetings, each by its member, and an edit of one is stored as that member\'s opening', async ({ page }) => {
        const s = stamp();
        const annName = `GroupAnn-${s}`;
        const boName = `GroupBo-${s}`;
        const ann = [`Ann zero ${s}`, `Ann one ${s}`];
        const bo = [`Bo zero, I am {{char}} ${s}`, `Bo one ${s}`];
        const annAvatar = await createCharacter(page, annName, ann);
        const boAvatar = await createCharacter(page, boName, bo);
        const groupId = await openNewGroup(page, `GroupOpenings-${s}`, [annAvatar, boAvatar]);

        const first = await opening(page);
        expect(first.length).toBe(1);
        expect(first.swipes).toEqual([...ann, ...bo]);
        expect([first.mes, first.name, first.original_avatar]).toEqual([ann[0], annName, annAvatar]);
        expect(first.node_id.startsWith('card:')).toBe(true);
        await expect(page.locator('#chat .mes[mesid="0"] .name_text')).toContainText(annName);

        await showOpening(page, 2);
        const swiped = await opening(page);
        expect([swiped.mes, swiped.name, swiped.original_avatar]).toEqual([bo[0], boName, boAvatar]);
        await expect(page.locator('#chat .mes[mesid="0"] .name_text')).toContainText(boName);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toContainText(`Bo zero, I am ${boName} ${s}`);

        await showOpening(page, 3);
        await showOpening(page, 1);
        expect((await opening(page)).mes).toBe(ann[1]);
        await showOpening(page, 3);
        expect((await opening(page)).name).toBe(boName);

        const edited = `Bo one, edited ${s}`;
        await page.locator('#chat .mes[mesid="0"] .mes_edit').click();
        await page.locator('.mes_editor .cm-content').fill(edited);
        await page.locator('#chat .mes[mesid="0"] .mes_edit_done').click();
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(edited, { timeout: 10000 });

        await expect.poll(() => listedOpenings(page, groupId), { timeout: 10000 }).toEqual([
            { stored: false, mes: ann[0], by: annAvatar },
            { stored: false, mes: ann[1], by: annAvatar },
            { stored: false, mes: bo[0], by: boAvatar },
            { stored: false, mes: bo[1], by: boAvatar },
            { stored: true, mes: edited, by: boAvatar },
        ]);
        await expect.poll(async () => (await opening(page)).swipes, { timeout: 10000 }).toEqual([...ann, ...bo, edited]);
        const stored = await opening(page);
        expect([stored.mes, stored.name, stored.original_avatar, stored.swipe_id]).toEqual([edited, boName, boAvatar, 4]);
        expect(stored.node_id.startsWith('card:')).toBe(false);

        await page.reload();
        await testSetup.awaitST({ page });
        await page.evaluate(async (groupId) => {
            // @ts-ignore
            await stTest.context().getCharacters();
            const { openGroupById } = await import('/scripts/group-chats.js');
            await openGroupById(groupId);
        }, groupId);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(edited, { timeout: 10000 });
        const reloaded = await opening(page);
        expect([reloaded.node_id, reloaded.name, reloaded.swipes]).toEqual([stored.node_id, boName, [...ann, ...bo, edited]]);
    });
});
