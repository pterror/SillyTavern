import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { cardToGreetingsModel } from '../../src/greeting-list.js';
import { greetingAnswer, answerOf } from './alternatives-list.js';

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
 * @param {string} groupId
 */
async function openGroup(page, groupId) {
    await page.evaluate(async (groupId) => {
        // @ts-ignore
        await stTest.context().getCharacters();
        const { openGroupById } = await import('/scripts/group-chats.js');
        await openGroupById(groupId);
    }, groupId);
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
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
        const response = await fetch('/api/groups/create', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ name, members }) });
        if (!response.ok) throw new Error(`group create failed: ${response.status}`);
        return String((await response.json()).id);
    }, { name, members });
    await openGroup(page, id);
    return id;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function storedModel(page, avatar) {
    const card = await page.evaluate(async (avatar) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders();
        const response = await fetch('/api/characters/get', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar }) });
        return response.json();
    }, avatar);
    return cardToGreetingsModel(card);
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function opening(page) {
    return page.evaluate(() => {
        // @ts-ignore
        const m = stTest.context().chat[0];
        return { mes: m.mes, original_avatar: m.original_avatar, swipe_id: m.swipe_id, swipes: [...m.swipes] };
    });
}

/**
 * Swipes the first message to `swipeId`, and answers what the page asked the server to remember
 * @param {import('@playwright/test').Page} page
 * @param {number} swipeId
 */
async function swipeTo(page, swipeId) {
    const told = page.waitForRequest(r => new URL(r.url()).pathname === '/api/chats/openings/choose', { timeout: 10000 });
    await page.evaluate(async (swipeId) => {
        const { swipe } = await import('/script.js');
        const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('/scripts/constants.js');
        // @ts-ignore
        const current = stTest.context().chat[0].swipe_id ?? 0;
        await swipe(null, swipeId > current ? SWIPE_DIRECTION.RIGHT : SWIPE_DIRECTION.LEFT, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: 0, forceSwipeId: swipeId });
    }, swipeId);
    const request = await told;
    expect((await request.response())?.ok()).toBe(true);
    await expect.poll(async () => (await opening(page)).swipe_id, { timeout: 10000 }).toBe(swipeId);
    return request.postDataJSON();
}

/**
 * Clicks "Show in character info" in the first message's menu, as a user does
 * @param {import('@playwright/test').Page} page
 */
async function showInCharacterInfo(page) {
    const show = page.locator('#chat .mes[mesid="0"] .mes_show_greeting');
    await expect(show).not.toHaveClass(/disabled/, { timeout: 10000 });
    await page.locator('#chat .mes[mesid="0"]').hover();
    await page.locator('#chat .mes[mesid="0"] .extraMesButtonsHint').click();
    const shown = page.waitForResponse(r => new URL(r.url()).pathname === '/api/characters/greetings/show', { timeout: 10000 });
    await show.click();
    expect((await shown).ok()).toBe(true);
}

/**
 * The character editor is shown, and nothing covers its greeting pager
 * @param {import('@playwright/test').Page} page
 */
async function expectEditorInFront(page) {
    await expect(page.locator('#char-info-panel')).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
        const use = document.querySelector('.greeting-pager-use');
        if (!use) return 'no pager';
        const box = use.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return hit?.closest('#char-info-panel') ? 'editor' : (hit?.closest('[id]')?.id ?? 'nothing');
    }), { timeout: 10000 }).toBe('editor');
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @param {string} text
 * @returns {Promise<number>} the id of the character's greeting with the text
 */
async function greetingId(page, avatar, text) {
    return page.evaluate(async ({ avatar, text }) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders();
        const card = await (await fetch('/api/characters/get', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar }) })).json();
        return card.card_greetings.ids[card.card_greetings.texts.indexOf(text)];
    }, { avatar, text });
}

const list = (/** @type {import('@playwright/test').Page} */ page) => page.locator('dialog.alternatives');
const rows = (/** @type {import('@playwright/test').Page} */ page) => list(page).locator('li.alternative');

/**
 * @param {import('@playwright/test').Page} page
 * @param {() => Promise<void>} act
 */
async function operate(page, act) {
    const answer = greetingAnswer(page);
    await act();
    expect((await answerOf(await answer)).ok).toBe(true);
}

test.describe('a group chat\'s first message, its card greetings', () => {
    test.beforeEach(testSetup.awaitST);

    test('the list has every card control on each member\'s greetings, each acting on that member\'s card only', async ({ page }) => {
        const s = stamp();
        const ann = [`Hi ${s}`, `Ann one ${s}`, `Ann two ${s}`];
        const bo = [`Hi ${s}`, `Bo one ${s}`];
        const annAvatar = await createCharacter(page, `CardsAnn-${s}`, ann);
        const boAvatar = await createCharacter(page, `CardsBo-${s}`, bo);
        await openNewGroup(page, `GroupCards-${s}`, [annAvatar, boAvatar]);

        await page.locator('#chat .mes[mesid="0"] .swipes-counter').click();
        await expect(rows(page)).toHaveCount(5);
        await expect(rows(page).locator('.alternative-text')).toHaveText([...ann, ...bo]);
        for (const n of [0, 3, 4]) {
            for (const control of ['.alternative-edit', '.alternative-default', '.alternative-drag', '.alternative-delete-greeting']) {
                await expect(rows(page).nth(n).locator(control)).toHaveCount(1);
            }
        }
        await expect(list(page).locator('.alternatives-add')).toHaveCount(0);
        await expect(rows(page).nth(3).locator('.alternative-default')).toHaveAttribute('aria-pressed', 'true');
        await expect(rows(page).nth(4).locator('.alternative-default')).toHaveAttribute('aria-pressed', 'false');

        const edited = `Hi, Bo edited ${s}`;
        await rows(page).nth(3).locator('.alternative-edit').click();
        await rows(page).nth(3).locator('.alternative-editor .cm-content').fill(edited);
        await operate(page, () => rows(page).nth(3).getByRole('button', { name: 'Save' }).click());
        await expect.poll(async () => (await storedModel(page, boAvatar)).greetings).toEqual([edited, bo[1]]);
        expect((await storedModel(page, annAvatar)).greetings).toEqual(ann);
        await expect(rows(page).locator('.alternative-text')).toHaveText([...ann, edited, bo[1]]);

        await operate(page, () => rows(page).nth(0).locator('.alternative-drag').press('End'));
        await expect.poll(async () => (await storedModel(page, annAvatar)).greetings).toEqual([ann[1], ann[2], ann[0]]);
        expect((await storedModel(page, boAvatar)).greetings).toEqual([edited, bo[1]]);
        await expect(rows(page).locator('.alternative-text')).toHaveText([ann[1], ann[2], ann[0], edited, bo[1]]);

        await operate(page, () => rows(page).nth(4).locator('.alternative-default').click());
        await expect.poll(async () => (await storedModel(page, boAvatar)).defaultIndex).toBe(1);
        expect((await storedModel(page, annAvatar)).defaultIndex).toBe(2);
        await expect(rows(page).nth(4).locator('.alternative-default')).toHaveAttribute('aria-pressed', 'true');
        await expect(rows(page).nth(3).locator('.alternative-default')).toHaveAttribute('aria-pressed', 'false');
        await expect(rows(page).nth(2).locator('.alternative-default')).toHaveAttribute('aria-pressed', 'true');
        await expect.poll(async () => (await opening(page)).swipes).toEqual([ann[1], ann[2], ann[0], edited, bo[1]]);
    });

    test('a swiped greeting is remembered by its id and member: the same text by two members, and one after an empty greeting', async ({ page }) => {
        const s = stamp();
        const same = `Same ${s}`;
        const last = `Bo last ${s}`;
        const annAvatar = await createCharacter(page, `ChoiceAnn-${s}`, [same]);
        const boAvatar = await createCharacter(page, `ChoiceBo-${s}`, [same, '', last]);
        const bo = await storedModel(page, boAvatar);
        expect(bo.greetings).toEqual([same, '', last]);
        const groupId = await openNewGroup(page, `GroupChoice-${s}`, [annAvatar, boAvatar]);
        expect((await opening(page)).swipes).toEqual([same, same, last]);

        const reopened = async () => {
            await page.reload();
            await testSetup.awaitST({ page });
            await openGroup(page, groupId);
            return opening(page);
        };
        const sent = await swipeTo(page, 1);
        expect(sent).toMatchObject({ group_id: groupId, greeting_avatar: boAvatar, greeting_id: expect.any(Number), expected_hash: expect.any(Number) });
        expect(sent).not.toHaveProperty('text');
        expect(sent).not.toHaveProperty('index');
        expect(await reopened()).toMatchObject({ mes: same, original_avatar: boAvatar, swipe_id: 1 });

        await swipeTo(page, 2);
        expect(await reopened()).toMatchObject({ mes: last, original_avatar: boAvatar, swipe_id: 2 });

        await swipeTo(page, 0);
        expect(await reopened()).toMatchObject({ mes: same, original_avatar: annAvatar, swipe_id: 0 });
    });

    test('"Show in character info" opens the member\'s greeting in front, and "Use in chat" makes it the group\'s opening again, each by its id', async ({ page }) => {
        const s = stamp();
        const ann = [`Ann zero ${s}`, `Ann one ${s}`];
        const bo = [`Bo zero ${s}`, `Bo one ${s}`];
        const annAvatar = await createCharacter(page, `InfoAnn-${s}`, ann);
        const boAvatar = await createCharacter(page, `InfoBo-${s}`, bo);
        await openNewGroup(page, `GroupInfo-${s}`, [annAvatar, boAvatar]);
        await swipeTo(page, 3);
        await expect(page.locator('#right-nav-panel')).not.toHaveClass(/openDrawer/);

        await showInCharacterInfo(page);
        await expect(page.locator('#greeting_field')).toHaveValue(bo[1], { timeout: 10000 });
        await expect(page.locator('.greeting-pager-input')).toHaveValue('2');
        await expectEditorInFront(page);
        await expect(page.locator('#right-nav-panel')).not.toHaveClass(/openDrawer/);

        await swipeTo(page, 0);
        expect((await opening(page)).original_avatar).toBe(annAvatar);
        const use = page.locator('.greeting-pager-use');
        await expect(use).not.toHaveClass(/disabled/);
        const used = page.waitForRequest(r => new URL(r.url()).pathname === '/api/chats/openings/use-greeting', { timeout: 10000 });
        await use.click();
        const request = await used;
        expect((await request.response())?.ok()).toBe(true);
        const sent = request.postDataJSON();
        expect(sent).toMatchObject({ avatar_url: boAvatar, greeting_id: await greetingId(page, boAvatar, bo[1]), expected_hash: expect.any(Number) });
        expect(sent).not.toHaveProperty('position');
        await expect.poll(async () => (await opening(page)).mes, { timeout: 10000 }).toBe(bo[1]);
        expect((await opening(page)).original_avatar).toBe(boAvatar);
    });
});
