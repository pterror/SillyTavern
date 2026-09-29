import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, openInfoTab } from './frontent-test-utils.js';
import { cardToGreetingsModel } from '../../src/greeting-list.js';
import { hashGreetingText } from '../../src/greeting-ops.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * Creates a character whose greetings are `greetings`, in order, with the first one as the default.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string[]} greetings
 * @returns {Promise<string>} The new character's avatar filename.
 */
async function createCharacter(page, name, greetings) {
    return page.evaluate(async ({ name, greetings }) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders({ omitContentType: true });
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
 * Opens the character (editor included) and waits for its chat's opening to be in place.
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function openCharacter(page, avatar) {
    await openCharacterManagementDrawer(page);
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        await SillyTavern.getContext().getCharacters();
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
    await expect.poll(() => page.evaluate(() => {
        // @ts-ignore
        return typeof SillyTavern.getContext().chat[0]?.node_id;
    }), { timeout: 10000 }).toBe('string');
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);
}

/**
 * The character's greetings and default as the server stores them.
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function storedModel(page, avatar) {
    const card = await page.evaluate(async (avatar) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        const response = await fetch('/api/characters/get', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar }) });
        if (!response.ok) throw new Error(`get failed: ${response.status}`);
        return response.json();
    }, avatar);
    return cardToGreetingsModel(card);
}

/**
 * The character's greetings and default as this page holds them.
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function pageModel(page, avatar) {
    const card = await page.evaluate((avatar) => {
        // @ts-ignore
        return JSON.parse(JSON.stringify(SillyTavern.getContext().getCharacterByAvatar(avatar)));
    }, avatar);
    return cardToGreetingsModel(card);
}

/**
 * Runs a greeting op for `avatar` from outside this page, standing in for another session.
 * @param {import('@playwright/test').Page} page
 * @param {string} op
 * @param {object} body
 */
async function otherSessionOp(page, op, body) {
    const status = await page.evaluate(async ({ op, body }) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        const response = await fetch(`/api/characters/greetings/${op}`, { method: 'POST', headers, body: JSON.stringify(body) });
        return response.status;
    }, { op, body });
    expect(status).toBe(200);
}

/**
 * @param {import('@playwright/test').Page} page
 */
function greetingsPopup(page) {
    return page.locator('.popup', { has: page.locator('.alternate_greetings_list') }).last();
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} index
 */
function popupRow(page, index) {
    return greetingsPopup(page).locator(`.alternate_greetings_list .alternate_greeting[data-index="${index}"]`);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} count Number of greetings the popup should list.
 */
async function openGreetingsPopup(page, count) {
    await openInfoTab(page, 'greeting');
    await page.locator('.open_alternate_greetings').click();
    await expect(greetingsPopup(page).locator('.alternate_greetings_list .alternate_greeting')).toHaveCount(count, { timeout: 10000 });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} op e.g. 'delete', 'default/set'
 */
function greetingOpResponse(page, op) {
    return page.waitForResponse(response => new URL(response.url()).pathname === `/api/characters/greetings/${op}`, { timeout: 15000 });
}

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test.describe('after a greeting save the page holds the server\'s greeting list', () => {
    test.beforeEach(testSetup.awaitST);

    /**
     * Creates a character with greetings g0..g3, opens it (and the popup when `popup`), then deletes g3 from
     * another session, so this page's copy still has g3.
     * @param {import('@playwright/test').Page} page
     * @param {string} name
     * @param {boolean} popup
     */
    async function afterRemoteDelete(page, name, popup) {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`, `Three ${s}`];
        const avatar = await createCharacter(page, `${name}-${s}`, g);
        await openCharacter(page, avatar);
        if (popup) await openGreetingsPopup(page, 4);
        await otherSessionOp(page, 'delete', { avatar_url: avatar, position: 3, expected_hash: hashGreetingText(g[3]) });
        return { s, g, avatar };
    }

    /**
     * @param {import('@playwright/test').Page} page
     * @param {string} avatar
     */
    async function expectPageHoldsServerList(page, avatar) {
        const stored = await storedModel(page, avatar);
        expect(await pageModel(page, avatar)).toEqual(stored);
        await expect(page.locator('.greeting-pager-total')).toHaveText(`/${stored.greetings.length}`);
    }

    test('sidebar pager edit: another session\'s delete shows up', async ({ page }) => {
        const { s, g, avatar } = await afterRemoteDelete(page, 'ServerListPager', false);
        const saved = await page.evaluate(async (text) => {
            const { saveGreetingField } = await import('/script.js');
            return saveGreetingField(text);
        }, `Zero edited ${s}`);
        expect(saved).toBe(true);
        expect(await storedModel(page, avatar)).toEqual({ greetings: [`Zero edited ${s}`, g[1], g[2]], defaultIndex: 0 });
        await expectPageHoldsServerList(page, avatar);
    });

    test('popup row edit: another session\'s delete shows up', async ({ page }) => {
        const { s, g, avatar } = await afterRemoteDelete(page, 'ServerListRowEdit', true);
        const response = greetingOpResponse(page, 'edit');
        await popupRow(page, 1).locator('.alternate_greeting_text').fill(`One edited ${s}`);
        expect((await response).ok()).toBe(true);
        expect(await storedModel(page, avatar)).toEqual({ greetings: [g[0], `One edited ${s}`, g[2]], defaultIndex: 0 });
        await expectPageHoldsServerList(page, avatar);
    });

    test('popup set default: another session\'s delete shows up', async ({ page }) => {
        const { g, avatar } = await afterRemoteDelete(page, 'ServerListSetDefault', true);
        const response = greetingOpResponse(page, 'default/set');
        await popupRow(page, 1).locator('.set_default_greeting').click();
        expect((await response).ok()).toBe(true);
        expect(await storedModel(page, avatar)).toEqual({ greetings: [g[0], g[1], g[2]], defaultIndex: 1 });
        await expectPageHoldsServerList(page, avatar);
        await expect(greetingsPopup(page).locator('.alternate_greetings_list .alternate_greeting')).toHaveCount(3, { timeout: 10000 });
    });

    test('popup demote: another session\'s delete shows up', async ({ page }) => {
        const { g, avatar } = await afterRemoteDelete(page, 'ServerListDemote', true);
        const response = greetingOpResponse(page, 'default/unset');
        await popupRow(page, 0).locator('.demote_default_greeting').click();
        expect((await response).ok()).toBe(true);
        expect(await storedModel(page, avatar)).toEqual({ greetings: [g[0], g[1], g[2]], defaultIndex: null });
        await expectPageHoldsServerList(page, avatar);
    });

    test('popup move: another session\'s delete shows up', async ({ page }) => {
        const { g, avatar } = await afterRemoteDelete(page, 'ServerListMove', true);
        await popupRow(page, 2).locator('.pick_up_greeting').click();
        const response = greetingOpResponse(page, 'move');
        await greetingsPopup(page).locator('.pick-place-slot').first().click();
        expect((await response).ok()).toBe(true);
        expect(await storedModel(page, avatar)).toEqual({ greetings: [g[2], g[0], g[1]], defaultIndex: 1 });
        await expectPageHoldsServerList(page, avatar);
        await expect(greetingsPopup(page).locator('.alternate_greetings_list .alternate_greeting')).toHaveCount(3, { timeout: 10000 });
    });

    test('popup delete: another session\'s delete shows up', async ({ page }) => {
        const { g, avatar } = await afterRemoteDelete(page, 'ServerListDelete', true);
        await popupRow(page, 1).locator('.delete_alternate_greeting').click();
        const response = greetingOpResponse(page, 'delete');
        await page.locator('.popup', { hasText: 'Are you sure you want to delete' }).locator('.popup-button-ok').click();
        expect((await response).ok()).toBe(true);
        expect(await storedModel(page, avatar)).toEqual({ greetings: [g[0], g[2]], defaultIndex: 0 });
        await expectPageHoldsServerList(page, avatar);
        await expect(greetingsPopup(page).locator('.alternate_greetings_list .alternate_greeting')).toHaveCount(2, { timeout: 10000 });
    });

    test('#character_json_data save: another session\'s delete shows up', async ({ page }) => {
        const { s, g, avatar } = await afterRemoteDelete(page, 'ServerListForm', false);
        await page.evaluate(async (text) => {
            // @ts-ignore
            const card = JSON.parse($('#character_json_data').val());
            card.first_mes = text;
            card.data.first_mes = text;
            // @ts-ignore
            $('#character_json_data').val(JSON.stringify(card));
            const { createOrEditCharacter } = await import('/script.js');
            await createOrEditCharacter(new CustomEvent('newChat'));
        }, `Zero edited ${s}`);
        expect(await storedModel(page, avatar)).toEqual({ greetings: [`Zero edited ${s}`, g[1], g[2]], defaultIndex: 0 });
        await expectPageHoldsServerList(page, avatar);
    });

    test('sidebar pager edit of the greeting the chat shows: the chat follows it to its new text though another session\'s delete arrived with it', async ({ page }) => {
        const { s, g, avatar } = await afterRemoteDelete(page, 'ServerListFollow', false);
        await page.evaluate(async () => {
            const { swipe } = await import('/script.js');
            const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('/scripts/constants.js');
            await swipe(null, SWIPE_DIRECTION.RIGHT, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: 0, forceSwipeId: 1 });
        });
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(g[1], { timeout: 10000 });
        await openInfoTab(page, 'greeting');
        await page.locator('.greeting-pager-next').click();
        await expect(page.locator('.greeting-pager-input')).toHaveValue('2');

        const edited = `One edited ${s}`;
        const saved = await page.evaluate(async (text) => {
            const { saveGreetingField } = await import('/script.js');
            return saveGreetingField(text);
        }, edited);
        expect(saved).toBe(true);
        expect((await storedModel(page, avatar)).greetings).toEqual([g[0], edited, g[2]]);
        await expectPageHoldsServerList(page, avatar);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(edited, { timeout: 10000 });
        const opening = await page.evaluate(() => {
            // @ts-ignore
            const m = SillyTavern.getContext().chat[0];
            return { mes: m.mes, swipe_id: m.swipe_id };
        });
        expect(opening).toEqual({ mes: edited, swipe_id: 1 });
    });

    test('#character_json_data save: a greeting another session changed since load is not overwritten, the rest lands, and a warning lists the change not saved', async ({ page }) => {
        const s = stamp();
        const [g0, g1, g2] = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `FormConflict-${s}`, [g0, g1, g2]);
        await openCharacter(page, avatar);
        const elsewhere = `Two changed elsewhere ${s}`;
        await otherSessionOp(page, 'edit', { avatar_url: avatar, position: 2, expected_hash: hashGreetingText(g2), text: elsewhere });

        const [e1, e2, added] = [`One edited ${s}`, `Two edited ${s}`, `Three added ${s}`];
        await page.evaluate(async (greetings) => {
            // @ts-ignore
            const card = JSON.parse($('#character_json_data').val());
            card.data.alternate_greetings = greetings;
            // @ts-ignore
            $('#character_json_data').val(JSON.stringify(card));
            const { createOrEditCharacter } = await import('/script.js');
            await createOrEditCharacter(new CustomEvent('newChat'));
        }, [e1, e2, added]);

        expect((await storedModel(page, avatar)).greetings).toEqual([g0, e1, elsewhere, added]);
        await expectPageHoldsServerList(page, avatar);
        const warning = page.locator('.toast-warning', { hasText: e2 });
        await expect(warning).toBeVisible({ timeout: 10000 });
        await expect(warning).not.toContainText(e1);
        await expect(warning).not.toContainText(added);
    });

    test('popup delete on a list another session reordered deletes that greeting and drops no other', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`, `Three ${s}`];
        const avatar = await createCharacter(page, `ServerListReordered-${s}`, g);
        await openCharacter(page, avatar);
        await openGreetingsPopup(page, 4);
        await otherSessionOp(page, 'move', {
            avatar_url: avatar, source_position: 3, expected_hash: hashGreetingText(g[3]), side: 'before', target_position: 0, target_expected_hash: hashGreetingText(g[0]),
        });

        await popupRow(page, 1).locator('.delete_alternate_greeting').click();
        const response = greetingOpResponse(page, 'delete');
        await page.locator('.popup', { hasText: 'Are you sure you want to delete' }).locator('.popup-button-ok').click();
        expect((await response).ok()).toBe(true);

        expect((await storedModel(page, avatar)).greetings).toEqual([g[3], g[0], g[2]]);
        await expectPageHoldsServerList(page, avatar);
        const rows = greetingsPopup(page).locator('.alternate_greetings_list .alternate_greeting .alternate_greeting_text');
        await expect(rows).toHaveCount(3, { timeout: 10000 });
        await expect(rows.nth(0)).toHaveValue(g[3]);
        await expect(rows.nth(1)).toHaveValue(g[0]);
        await expect(rows.nth(2)).toHaveValue(g[2]);
    });
});
