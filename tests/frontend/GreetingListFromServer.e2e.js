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

    test('#character_json_data save: an add lands at the end even when another session changes the list length just before it', async ({ page }) => {
        const s = stamp();
        const [g0, g1] = [`Zero ${s}`, `One ${s}`];
        const avatar = await createCharacter(page, `FormAppend-${s}`, [g0, g1]);
        await openCharacter(page, avatar);

        const elsewhere = `Added elsewhere ${s}`;
        /** @type {number|null} */
        let otherStatus = null;
        await page.route('**/api/characters/greetings/add', async (route) => {
            if (otherStatus === null) {
                otherStatus = 0;
                otherStatus = await page.evaluate(async ({ avatar, text }) => {
                    // @ts-ignore
                    const headers = SillyTavern.getContext().getRequestHeaders();
                    const response = await fetch('/api/characters/greetings/add', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, position: 2, expected_length: 2, text }) });
                    return response.status;
                }, { avatar, text: elsewhere });
            }
            await route.continue();
        });

        const added = `Two added ${s}`;
        await page.evaluate(async (greetings) => {
            // @ts-ignore
            const card = JSON.parse($('#character_json_data').val());
            card.data.alternate_greetings = greetings;
            // @ts-ignore
            $('#character_json_data').val(JSON.stringify(card));
            const { createOrEditCharacter } = await import('/script.js');
            await createOrEditCharacter(new CustomEvent('newChat'));
        }, [g1, added]);

        expect(otherStatus).toBe(200);
        expect((await storedModel(page, avatar)).greetings).toEqual([g0, g1, elsewhere, added]);
        await expectPageHoldsServerList(page, avatar);
        await expect(page.locator('.toast-warning')).toHaveCount(0);
    });

    /**
     * Creates a character with greetings g0, g1, g2 whose default is g1, and opens it.
     * @param {import('@playwright/test').Page} page
     * @param {string} name
     */
    async function withDefaultAtOne(page, name) {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `${name}-${s}`, g);
        await otherSessionOp(page, 'default/set', { avatar_url: avatar, position: 1, expected_hash: hashGreetingText(g[1]) });
        await openCharacter(page, avatar);
        return { s, g, avatar };
    }

    /**
     * Sets `#character_json_data` to hold `greetings` with no default greeting, and saves it.
     * @param {import('@playwright/test').Page} page
     * @param {string[]} greetings
     */
    async function formSaveWithNoDefault(page, greetings) {
        await page.evaluate(async (greetings) => {
            // @ts-ignore
            const card = JSON.parse($('#character_json_data').val());
            card.first_mes = '';
            card.data.first_mes = '';
            card.data.alternate_greetings = greetings;
            delete card.data.extensions?.greeting_default_position;
            // @ts-ignore
            $('#character_json_data').val(JSON.stringify(card));
            const { createOrEditCharacter } = await import('/script.js');
            await createOrEditCharacter(new CustomEvent('newChat'));
        }, greetings);
    }

    test('popup demote: another session deleting an earlier greeting doesn\'t stop the default being cleared', async ({ page }) => {
        const { g, avatar } = await withDefaultAtOne(page, 'DemoteShifted');
        await openGreetingsPopup(page, 3);
        await otherSessionOp(page, 'delete', { avatar_url: avatar, position: 0, expected_hash: hashGreetingText(g[0]) });

        const response = greetingOpResponse(page, 'default/unset');
        await popupRow(page, 1).locator('.demote_default_greeting').click();
        expect((await response).status()).toBe(200);
        expect(await storedModel(page, avatar)).toEqual({ greetings: [g[1], g[2]], defaultIndex: null });
        await expectPageHoldsServerList(page, avatar);
    });

    test('#character_json_data save: another session deleting an earlier greeting doesn\'t stop the default being cleared', async ({ page }) => {
        const { g, avatar } = await withDefaultAtOne(page, 'FormUnsetShifted');
        await otherSessionOp(page, 'delete', { avatar_url: avatar, position: 0, expected_hash: hashGreetingText(g[0]) });

        await formSaveWithNoDefault(page, g);

        expect(await storedModel(page, avatar)).toEqual({ greetings: [g[1], g[2]], defaultIndex: null });
        await expectPageHoldsServerList(page, avatar);
        await expect(page.locator('.toast-warning')).toHaveCount(0);
    });

    test('#character_json_data save: clearing a default another session changed is refused and listed in the warning', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `FormUnsetChanged-${s}`, g);
        await openCharacter(page, avatar);
        await otherSessionOp(page, 'default/set', { avatar_url: avatar, position: 2, expected_hash: hashGreetingText(g[2]) });

        await formSaveWithNoDefault(page, g);

        expect(await storedModel(page, avatar)).toEqual({ greetings: g, defaultIndex: 2 });
        await expect(page.locator('.toast-warning', { hasText: 'Default greeting cleared' })).toBeVisible({ timeout: 10000 });
    });

    test('popup demote after another session already cleared the default succeeds', async ({ page }) => {
        const { g, avatar } = await withDefaultAtOne(page, 'DemoteAlreadyCleared');
        await openGreetingsPopup(page, 3);
        await otherSessionOp(page, 'default/unset', { avatar_url: avatar, expected_default_position: 1 });

        const response = greetingOpResponse(page, 'default/unset');
        await popupRow(page, 1).locator('.demote_default_greeting').click();
        expect((await response).status()).toBe(200);
        expect(await storedModel(page, avatar)).toEqual({ greetings: g, defaultIndex: null });
        await expectPageHoldsServerList(page, avatar);
        await expect(page.locator('.toast-error')).toHaveCount(0);
    });

    test('#character_json_data save: clearing a default another session already cleared is done, with no warning', async ({ page }) => {
        const { g, avatar } = await withDefaultAtOne(page, 'FormAlreadyCleared');
        await otherSessionOp(page, 'default/unset', { avatar_url: avatar, expected_default_position: 1 });

        await formSaveWithNoDefault(page, g);

        expect(await storedModel(page, avatar)).toEqual({ greetings: g, defaultIndex: null });
        await expectPageHoldsServerList(page, avatar);
        await expect(page.locator('.toast-warning')).toHaveCount(0);
    });

    test('sidebar pager edit that another session already made succeeds', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`];
        const avatar = await createCharacter(page, `PagerAlreadyEdited-${s}`, g);
        await openCharacter(page, avatar);
        const edited = `Zero edited ${s}`;
        await otherSessionOp(page, 'edit', { avatar_url: avatar, position: 0, expected_hash: hashGreetingText(g[0]), text: edited });

        const saved = await page.evaluate(async (text) => {
            const { saveGreetingField } = await import('/script.js');
            return saveGreetingField(text);
        }, edited);
        expect(saved).toBe(true);
        expect(await storedModel(page, avatar)).toEqual({ greetings: [edited, g[1]], defaultIndex: 0 });
        await expectPageHoldsServerList(page, avatar);
        await expect(page.locator('.toast-error')).toHaveCount(0);
    });

    test('#character_json_data save: a failure partway lists the refused change, the failed one, and every change never sent', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `FormFailure-${s}`, g);
        await openCharacter(page, avatar);
        const elsewhere = `One changed elsewhere ${s}`;
        await otherSessionOp(page, 'edit', { avatar_url: avatar, position: 1, expected_hash: hashGreetingText(g[1]), text: elsewhere });

        const [e0, e1, e2, added] = [`Zero edited ${s}`, `One edited ${s}`, `Two edited ${s}`, `Three added ${s}`];
        /** @type {string[]} */
        const sent = [];
        await page.route('**/api/characters/greetings/**', async (route) => {
            const body = route.request().postDataJSON();
            sent.push(body.text);
            if (body.text === e2) {
                await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, reason: 'internal error' }) });
                return;
            }
            await route.continue();
        });

        await page.evaluate(async (greetings) => {
            // @ts-ignore
            const card = JSON.parse($('#character_json_data').val());
            card.first_mes = greetings[0];
            card.data.first_mes = greetings[0];
            card.data.alternate_greetings = greetings.slice(1);
            // @ts-ignore
            $('#character_json_data').val(JSON.stringify(card));
            const { createOrEditCharacter } = await import('/script.js');
            await createOrEditCharacter(new CustomEvent('newChat'));
        }, [e0, e1, e2, added]);

        expect(sent).toEqual([e0, e1, e2]);
        expect((await storedModel(page, avatar)).greetings).toEqual([e0, elsewhere, g[2]]);
        const warning = page.locator('.toast-warning');
        await expect(warning).toHaveCount(1, { timeout: 10000 });
        await expect(warning).toContainText(e1);
        await expect(warning).toContainText(e2);
        await expect(warning).toContainText(added);
        await expect(warning).not.toContainText(e0);
    });

    test('popup set default: another session\'s edit of the shown greeting isn\'t announced as this page\'s edit, and the chat stays on its slot with the new text', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `OwnEditsOnly-${s}`, g);
        await openCharacter(page, avatar);
        await page.evaluate(async () => {
            const { swipe } = await import('/script.js');
            const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('/scripts/constants.js');
            await swipe(null, SWIPE_DIRECTION.RIGHT, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: 0, forceSwipeId: 1 });
        });
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(g[1], { timeout: 10000 });
        await openGreetingsPopup(page, 3);
        const elsewhere = `One changed elsewhere ${s}`;
        await otherSessionOp(page, 'edit', { avatar_url: avatar, position: 1, expected_hash: hashGreetingText(g[1]), text: elsewhere });
        await page.evaluate(() => {
            // @ts-ignore
            const { eventSource, eventTypes } = SillyTavern.getContext();
            // @ts-ignore
            window.__greetingEvents = [];
            eventSource.on(eventTypes.CHARACTER_EDITED, (/** @type {any} */ event) => {
                // @ts-ignore
                window.__greetingEvents.push({ greetingEdit: event.detail.greetingEdit ?? null, greetingEdits: event.detail.greetingEdits ?? [] });
            });
        });

        const response = greetingOpResponse(page, 'default/set');
        await popupRow(page, 2).locator('.set_default_greeting').click();
        expect((await response).ok()).toBe(true);
        expect(await storedModel(page, avatar)).toEqual({ greetings: [g[0], elsewhere, g[2]], defaultIndex: 2 });
        await expectPageHoldsServerList(page, avatar);

        // @ts-ignore
        await expect.poll(() => page.evaluate(() => window.__greetingEvents)).toEqual([{ greetingEdit: null, greetingEdits: [] }]);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(elsewhere, { timeout: 10000 });
        const opening = await page.evaluate(() => {
            // @ts-ignore
            const m = SillyTavern.getContext().chat[0];
            return { mes: m.mes, swipe_id: m.swipe_id, swipes: [...m.swipes] };
        });
        expect(opening).toEqual({ mes: elsewhere, swipe_id: 1, swipes: [g[0], elsewhere, g[2]] });
    });

    test('another session\'s edit of the shown greeting, arriving with its delete of an earlier greeting: the chat stays at the same index', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`, `Three ${s}`];
        const avatar = await createCharacter(page, `SlotShifted-${s}`, g);
        await openCharacter(page, avatar);
        await page.evaluate(async () => {
            const { swipe } = await import('/script.js');
            const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('/scripts/constants.js');
            await swipe(null, SWIPE_DIRECTION.RIGHT, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: 0, forceSwipeId: 2 });
        });
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(g[2], { timeout: 10000 });
        await openGreetingsPopup(page, 4);
        const elsewhere = `Two changed elsewhere ${s}`;
        await otherSessionOp(page, 'edit', { avatar_url: avatar, position: 2, expected_hash: hashGreetingText(g[2]), text: elsewhere });
        await otherSessionOp(page, 'delete', { avatar_url: avatar, position: 1, expected_hash: hashGreetingText(g[1]) });

        const response = greetingOpResponse(page, 'default/set');
        await popupRow(page, 3).locator('.set_default_greeting').click();
        expect((await response).ok()).toBe(true);
        expect(await storedModel(page, avatar)).toEqual({ greetings: [g[0], elsewhere, g[3]], defaultIndex: 2 });

        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(g[3], { timeout: 10000 });
        const opening = await page.evaluate(() => {
            // @ts-ignore
            const m = SillyTavern.getContext().chat[0];
            return { mes: m.mes, swipe_id: m.swipe_id, swipes: [...m.swipes] };
        });
        expect(opening).toEqual({ mes: g[3], swipe_id: 2, swipes: [g[0], elsewhere, g[3]] });
    });

    /**
     * Opens a character with greetings `g`, shows greeting `shown` in the chat and opens the popup, runs `otherSession`
     * (another session's changes), then sets the greeting in popup row `defaultRow` as the default from this page.
     * Resolves to the chat's opening afterwards.
     * @param {import('@playwright/test').Page} page
     * @param {object} args
     * @param {string} args.name
     * @param {string[]} args.g
     * @param {number} args.shown
     * @param {(avatar: string) => Promise<void>} args.otherSession
     * @param {number} args.defaultRow
     * @param {string} args.expected The text the chat should end up showing.
     */
    async function chatAfterOtherSession(page, { name, g, shown, otherSession, defaultRow, expected }) {
        const avatar = await createCharacter(page, name, g);
        await openCharacter(page, avatar);
        await page.evaluate(async (shown) => {
            const { swipe } = await import('/script.js');
            const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('/scripts/constants.js');
            await swipe(null, SWIPE_DIRECTION.RIGHT, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: 0, forceSwipeId: shown });
        }, shown);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(g[shown], { timeout: 10000 });
        await openGreetingsPopup(page, g.length);
        await otherSession(avatar);

        const response = greetingOpResponse(page, 'default/set');
        await popupRow(page, defaultRow).locator('.set_default_greeting').click();
        expect((await response).ok()).toBe(true);
        await expectPageHoldsServerList(page, avatar);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(expected, { timeout: 10000 });
        return page.evaluate(() => {
            // @ts-ignore
            const m = SillyTavern.getContext().chat[0];
            return { mes: m.mes, swipe_id: m.swipe_id, swipes: [...m.swipes] };
        });
    }

    test('the shown text is still an opening after another session\'s changes: the chat shows that opening', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const opening = await chatAfterOtherSession(page, {
            name: `SlotStillThere-${s}`, g, shown: 2, defaultRow: 1, expected: g[2],
            otherSession: avatar => otherSessionOp(page, 'delete', { avatar_url: avatar, position: 0, expected_hash: hashGreetingText(g[0]) }),
        });
        // Zero stays: the chat opened on it, so it is a stored opening.
        expect(opening).toEqual({ mes: g[2], swipe_id: 2, swipes: [g[0], g[1], g[2]] });
    });

    test('the shown greeting is gone: the chat shows the opening now at the same index', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`, `Three ${s}`];
        const opening = await chatAfterOtherSession(page, {
            name: `SlotEmptyNext-${s}`, g, shown: 1, defaultRow: 3, expected: g[2],
            otherSession: avatar => otherSessionOp(page, 'delete', { avatar_url: avatar, position: 1, expected_hash: hashGreetingText(g[1]) }),
        });
        expect(opening).toEqual({ mes: g[2], swipe_id: 1, swipes: [g[0], g[2], g[3]] });
    });

    test('the shown greeting was last and is gone: the index is clamped, so the chat shows the last opening', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`, `Three ${s}`];
        const opening = await chatAfterOtherSession(page, {
            name: `SlotEmptyPrevious-${s}`, g, shown: 3, defaultRow: 1, expected: g[2],
            otherSession: avatar => otherSessionOp(page, 'delete', { avatar_url: avatar, position: 3, expected_hash: hashGreetingText(g[3]) }),
        });
        expect(opening).toEqual({ mes: g[2], swipe_id: 2, swipes: [g[0], g[1], g[2]] });
    });

    test('the shown greeting now has another opening\'s text: the chat shows the opening now at the same index', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`, `Three ${s}`];
        const opening = await chatAfterOtherSession(page, {
            name: `SlotCopy-${s}`, g, shown: 2, defaultRow: 1, expected: g[3],
            otherSession: avatar => otherSessionOp(page, 'edit', { avatar_url: avatar, position: 2, expected_hash: hashGreetingText(g[2]), text: g[0] }),
        });
        expect(opening).toEqual({ mes: g[3], swipe_id: 2, swipes: [g[0], g[1], g[3]] });
    });

    test('several openings changed around the shown greeting: the chat shows the opening now at the same index', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`, `Three ${s}`, `Four ${s}`];
        const [x2, x3] = [`Two changed elsewhere ${s}`, `Three changed elsewhere ${s}`];
        const opening = await chatAfterOtherSession(page, {
            name: `SlotSeveral-${s}`, g, shown: 3, defaultRow: 4, expected: g[4],
            otherSession: async (avatar) => {
                await otherSessionOp(page, 'edit', { avatar_url: avatar, position: 2, expected_hash: hashGreetingText(g[2]), text: x2 });
                await otherSessionOp(page, 'edit', { avatar_url: avatar, position: 3, expected_hash: hashGreetingText(g[3]), text: x3 });
                await otherSessionOp(page, 'delete', { avatar_url: avatar, position: 1, expected_hash: hashGreetingText(g[1]) });
            },
        });
        expect(opening).toEqual({ mes: g[4], swipe_id: 3, swipes: [g[0], x2, x3, g[4]] });
    });

    test('with more stored openings than the loaded window, a gone last greeting lands on the last opening', async ({ page }) => {
        const s = stamp();
        const name = `SlotWindow-${s}`;
        const g = Array.from({ length: 14 }, (_, i) => `Greeting ${i} ${s}`);
        const avatar = await createCharacter(page, name, g);
        const stored = await page.evaluate(async ({ avatar, name, texts }) => {
            // @ts-ignore
            const headers = SillyTavern.getContext().getRequestHeaders();
            const contents = texts.map(mes => ({ name, is_user: false, is_system: false, send_date: Date.now(), mes, extra: {} }));
            const response = await fetch('/api/chats/openings/ensure', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, contents }) });
            return response.ok;
        }, { avatar, name, texts: g.slice(0, 13) });
        expect(stored).toBe(true);
        await openCharacter(page, avatar);
        const loaded = await page.evaluate(() => {
            // @ts-ignore
            return [...SillyTavern.getContext().chat[0].swipes];
        });
        expect(loaded).toHaveLength(14);
        expect(loaded[12]).toBeNull();
        await page.evaluate(async () => {
            const { swipe } = await import('/script.js');
            const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('/scripts/constants.js');
            await swipe(null, SWIPE_DIRECTION.RIGHT, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: 0, forceSwipeId: 13 });
        });
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(g[13], { timeout: 10000 });
        await openGreetingsPopup(page, 14);
        await otherSessionOp(page, 'delete', { avatar_url: avatar, position: 13, expected_hash: hashGreetingText(g[13]) });

        const response = greetingOpResponse(page, 'default/set');
        await popupRow(page, 5).locator('.set_default_greeting').click();
        expect((await response).ok()).toBe(true);

        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(g[12], { timeout: 10000 });
        const opening = await page.evaluate(() => {
            // @ts-ignore
            const m = SillyTavern.getContext().chat[0];
            return { mes: m.mes, swipe_id: m.swipe_id };
        });
        expect(opening).toEqual({ mes: g[12], swipe_id: 12 });
    });

    test('when finding where the chat lands fails, a warning says so and the chat shows what reopening it would', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`, `Three ${s}`];
        await page.route('**/api/chats/openings/land', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: true }) }));
        // The chat was switched to One, which is deleted: reopening shows the greeting now at One's card position.
        const opening = await chatAfterOtherSession(page, {
            name: `LandingFails-${s}`, g, shown: 1, defaultRow: 3, expected: g[2],
            otherSession: avatar => otherSessionOp(page, 'delete', { avatar_url: avatar, position: 1, expected_hash: hashGreetingText(g[1]) }),
        });
        expect(opening.mes).toBe(g[2]);
        await expect(page.locator('.toast-warning', { hasText: 'couldn\'t follow' })).toBeVisible({ timeout: 10000 });
    });

    /**
     * Runs `/char-update` on a non-greeting field, which refetches the card and replaces the pager's greetings.
     * @param {import('@playwright/test').Page} page
     * @param {string} personality
     */
    async function charUpdate(page, personality) {
        const refetched = page.waitForResponse(response => new URL(response.url()).pathname === '/api/characters/get', { timeout: 15000 });
        await page.evaluate(async (personality) => {
            // @ts-ignore
            const { executeSlashCommandsWithOptions } = SillyTavern.getContext();
            await executeSlashCommandsWithOptions(`/char-update personality="${personality}"`);
        }, personality);
        expect((await refetched).ok()).toBe(true);
    }

    /**
     * The popup row whose text box shows `text`.
     * @param {import('@playwright/test').Page} page
     * @param {string} text
     */
    async function popupRowShowing(page, text) {
        const rows = greetingsPopup(page).locator('.alternate_greetings_list .alternate_greeting');
        const count = await rows.count();
        for (let i = 0; i < count; i++) {
            if (await rows.nth(i).locator('.alternate_greeting_text').inputValue() === text) return rows.nth(i);
        }
        throw new Error(`no popup row shows ${text}`);
    }

    /**
     * @param {import('@playwright/test').Page} page
     */
    async function popupTexts(page) {
        return greetingsPopup(page).locator('.alternate_greetings_list .alternate_greeting .alternate_greeting_text').evaluateAll(els => els.map(el => /** @type {HTMLTextAreaElement} */ (el).value));
    }

    test('popup row edit after /char-update brought in another session\'s delete lands on that row\'s own greeting', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `RowOwnHashEdit-${s}`, g);
        await openCharacter(page, avatar);
        await openGreetingsPopup(page, 3);
        await otherSessionOp(page, 'delete', { avatar_url: avatar, position: 0, expected_hash: hashGreetingText(g[0]) });
        await charUpdate(page, `Personality ${s}`);

        const edited = `One edited ${s}`;
        const response = greetingOpResponse(page, 'edit');
        await (await popupRowShowing(page, g[1])).locator('.alternate_greeting_text').fill(edited);
        expect((await response).ok()).toBe(true);

        expect((await storedModel(page, avatar)).greetings).toEqual([edited, g[2]]);
        await expectPageHoldsServerList(page, avatar);
    });

    test('popup row delete after /char-update brought in another session\'s delete removes that row\'s own greeting', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `RowOwnHashDelete-${s}`, g);
        await openCharacter(page, avatar);
        await openGreetingsPopup(page, 3);
        await otherSessionOp(page, 'delete', { avatar_url: avatar, position: 0, expected_hash: hashGreetingText(g[0]) });
        await charUpdate(page, `Personality ${s}`);

        const response = greetingOpResponse(page, 'delete');
        await (await popupRowShowing(page, g[2])).locator('.delete_alternate_greeting').click();
        await page.locator('.popup', { hasText: 'Are you sure you want to delete' }).locator('.popup-button-ok').click();
        expect((await response).ok()).toBe(true);

        expect((await storedModel(page, avatar)).greetings).toEqual([g[1]]);
        await expectPageHoldsServerList(page, avatar);
    });

    test('a popup row being edited keeps its text through /char-update, its edit lands on its own greeting, and the list re-renders when the edit ends', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `RowOwnHashFocused-${s}`, g);
        await openCharacter(page, avatar);
        await openGreetingsPopup(page, 3);
        const textarea = popupRow(page, 1).locator('.alternate_greeting_text');
        await textarea.focus();
        await otherSessionOp(page, 'delete', { avatar_url: avatar, position: 0, expected_hash: hashGreetingText(g[0]) });
        await charUpdate(page, `Personality ${s}`);

        expect(await popupTexts(page)).toEqual(g);
        await expect(textarea).toBeFocused();

        const more = ' and more';
        const response = greetingOpResponse(page, 'edit');
        await textarea.press('End');
        await textarea.pressSequentially(more);
        expect((await response).ok()).toBe(true);
        expect((await storedModel(page, avatar)).greetings).toEqual([g[1] + more, g[2]]);
        await expect(textarea).toHaveValue(g[1] + more);
        expect(await popupTexts(page)).toEqual([g[0], g[1] + more, g[2]]);

        await greetingsPopup(page).locator('.greeting-filter-input').focus();
        await expect.poll(() => popupTexts(page), { timeout: 10000 }).toEqual([g[1] + more, g[2]]);
        await expectPageHoldsServerList(page, avatar);
    });

    test('a popup row open in the maximize editor isn\'t redrawn by /char-update, keeps what is typed, and its edit lands on its own greeting', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `RowMaximized-${s}`, g);
        await openCharacter(page, avatar);
        await openGreetingsPopup(page, 3);
        await popupRow(page, 1).locator('.editor_maximize').click();
        const editor = page.locator('textarea.maximized_textarea');
        await expect(editor).toBeVisible();
        await expect(editor).toHaveValue(g[1]);

        const typed = `${g[1]} typed`;
        let response = greetingOpResponse(page, 'edit');
        await editor.press('End');
        await editor.pressSequentially(' typed');
        expect((await response).ok()).toBe(true);
        expect((await storedModel(page, avatar)).greetings).toEqual([g[0], typed, g[2]]);

        await otherSessionOp(page, 'delete', { avatar_url: avatar, position: 0, expected_hash: hashGreetingText(g[0]) });
        await charUpdate(page, `Personality ${s}`);
        expect(await popupTexts(page)).toEqual([g[0], typed, g[2]]);

        const more = `${typed} and more`;
        response = greetingOpResponse(page, 'edit');
        await editor.pressSequentially(' and more');
        await expect(editor).toHaveValue(more);
        await expect(popupRow(page, 1).locator('.alternate_greeting_text')).toHaveValue(more);
        expect((await response).ok()).toBe(true);
        expect((await storedModel(page, avatar)).greetings).toEqual([more, g[2]]);

        await page.keyboard.press('Escape');
        await expect(editor).toHaveCount(0);
        await expect.poll(() => popupTexts(page), { timeout: 10000 }).toEqual([more, g[2]]);
        await expectPageHoldsServerList(page, avatar);
    });

    /**
     * Edits the chat's opening message in place to `text`.
     * @param {import('@playwright/test').Page} page
     * @param {string} text
     */
    async function editOpeningInChat(page, text) {
        await page.locator('#chat .mes[mesid="0"] .mes_edit').click();
        await page.locator('#curEditTextarea').fill(text);
        await page.locator('#chat .mes[mesid="0"] .mes_edit_done').click();
        await expect(page.locator('#curEditTextarea')).toHaveCount(0);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(text, { timeout: 10000 });
    }

    /**
     * The chat's opening: its swipes, and the node id behind each.
     * @param {import('@playwright/test').Page} page
     */
    async function openingSwipes(page) {
        return page.evaluate(() => {
            // @ts-ignore
            const m = SillyTavern.getContext().chat[0];
            return { swipes: [...m.swipes], nodeIds: m.swipe_info.map(i => i?.node_id ?? null), swipe_id: m.swipe_id };
        });
    }

    /**
     * @param {string|null} id
     */
    const isStoredId = id => typeof id === 'string' && !id.startsWith('card:');

    test('a card greeting edited, then the chat\'s opening edited to the same text: the stored opening plus the card\'s other greetings, the text once, the chat on it', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `DedupCardThenChat-${s}`, g);
        await openCharacter(page, avatar);
        const x = `Shared ${s}`;
        await openGreetingsPopup(page, 3);
        const response = greetingOpResponse(page, 'edit');
        await popupRow(page, 2).locator('.alternate_greeting_text').fill(x);
        expect((await response).ok()).toBe(true);
        await page.keyboard.press('Escape');
        await expect(greetingsPopup(page)).toHaveCount(0);

        await editOpeningInChat(page, x);

        await expect.poll(async () => (await openingSwipes(page)).swipes, { timeout: 10000 }).toEqual([x, g[0], g[1]]);
        const opening = await openingSwipes(page);
        expect(isStoredId(opening.nodeIds[0])).toBe(true);
        expect(opening.nodeIds.slice(1).every(id => !isStoredId(id))).toBe(true);
        expect(opening.swipe_id).toBe(0);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(x);
    });

    test('the chat\'s opening edited, then a card greeting edited to the same text: the stored opening plus the card\'s other greetings, the text once, the chat on it', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `DedupChatThenCard-${s}`, g);
        await openCharacter(page, avatar);
        const y = `Shared ${s}`;
        await editOpeningInChat(page, y);

        // Clicking into the chat closes the character's editor.
        await openCharacter(page, avatar);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(y, { timeout: 10000 });
        await openGreetingsPopup(page, 3);
        const response = greetingOpResponse(page, 'edit');
        await popupRow(page, 2).locator('.alternate_greeting_text').fill(y);
        expect((await response).ok()).toBe(true);

        await expect.poll(async () => (await openingSwipes(page)).swipes, { timeout: 10000 }).toEqual([y, g[0], g[1]]);
        const opening = await openingSwipes(page);
        expect(isStoredId(opening.nodeIds[0])).toBe(true);
        expect(opening.nodeIds.slice(1).every(id => !isStoredId(id))).toBe(true);
        expect(opening.swipe_id).toBe(0);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(y);
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
