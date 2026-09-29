import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, openInfoTab } from './frontent-test-utils.js';
import { cardToGreetingsModel } from '../../src/greeting-list.js';

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

/**
 * Records every greeting op request in order, and holds the first one's response (after the server has applied
 * it) until `release()`, so that write is still in flight when the next one is started.
 * @param {import('@playwright/test').Page} page
 */
async function holdFirstGreetingWrite(page) {
    const state = {
        /** @type {string[]} */
        started: [],
        inFlight: 0,
        maxInFlight: 0,
        /** @type {() => void} */
        release: () => { },
        /** @type {Promise<void>} */
        held: Promise.resolve(),
    };
    /** @type {() => void} */
    let markHeld = () => { };
    state.held = new Promise(resolve => { markHeld = () => resolve(undefined); });
    const released = new Promise(resolve => { state.release = () => resolve(undefined); });
    await page.route('**/api/characters/greetings/**', async (route) => {
        state.started.push(new URL(route.request().url()).pathname.replace('/api/characters/greetings/', ''));
        const first = state.started.length === 1;
        state.inFlight++;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        const response = await route.fetch();
        if (first) {
            markHeld();
            await released;
        }
        state.inFlight--;
        await route.fulfill({ response });
    });
    return state;
}

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** How long a write that isn't queued is given to show up while the earlier one is held. */
const OVERLAP_GRACE_MS = 1500;

test.describe('one character\'s greeting writes never overlap', () => {
    test.beforeEach(testSetup.awaitST);

    /**
     * Popup: types into row 1 and holds that edit's response, runs `act` (another popup op), checks the op is
     * not sent while the edit is in flight, then releases the edit and waits for the op.
     * @param {import('@playwright/test').Page} page
     * @param {string} name
     * @param {string} op
     * @param {(page: import('@playwright/test').Page) => Promise<void>} act
     */
    async function popupOpAfterHeldEdit(page, name, op, act) {
        const s = stamp();
        const [g0, g1, g2] = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const edited = `One edited ${s}`;
        const avatar = await createCharacter(page, `${name}-${s}`, [g0, g1, g2]);
        await openCharacter(page, avatar);
        await openGreetingsPopup(page, 3);
        const state = await holdFirstGreetingWrite(page);

        await popupRow(page, 1).locator('.alternate_greeting_text').fill(edited);
        await state.held;
        expect(state.started).toEqual(['edit']);

        await act(page);
        await page.waitForTimeout(OVERLAP_GRACE_MS);
        expect(state.started, `"${op}" must not be sent while the earlier edit is in flight`).toEqual(['edit']);

        const opResponse = greetingOpResponse(page, op);
        state.release();
        expect((await opResponse).status()).toBe(200);
        expect(state.started).toEqual(['edit', op]);
        expect(state.maxInFlight).toBe(1);
        return { avatar, g0, g2, edited };
    }

    test('popup delete waits for the row edit in flight and deletes the edited greeting', async ({ page }) => {
        const { avatar, g0, g2 } = await popupOpAfterHeldEdit(page, 'QueueDelete', 'delete', async (page) => {
            await popupRow(page, 1).locator('.delete_alternate_greeting').click();
            await page.locator('.popup', { hasText: 'Are you sure you want to delete' }).locator('.popup-button-ok').click();
        });
        expect(await storedModel(page, avatar)).toEqual({ greetings: [g0, g2], defaultIndex: 0 });
        await expect(greetingsPopup(page).locator('.alternate_greetings_list .alternate_greeting')).toHaveCount(2, { timeout: 10000 });
    });

    test('popup set default waits for the row edit in flight and makes the edited greeting the default', async ({ page }) => {
        const { avatar, g0, g2, edited } = await popupOpAfterHeldEdit(page, 'QueueSetDefault', 'default/set', async (page) => {
            await popupRow(page, 1).locator('.set_default_greeting').click();
        });
        expect(await storedModel(page, avatar)).toEqual({ greetings: [g0, edited, g2], defaultIndex: 1 });
    });

    test('popup demote waits for the row edit in flight and clears the default', async ({ page }) => {
        const { avatar, g0, g2, edited } = await popupOpAfterHeldEdit(page, 'QueueDemote', 'default/unset', async (page) => {
            await popupRow(page, 0).locator('.demote_default_greeting').click();
        });
        expect(await storedModel(page, avatar)).toEqual({ greetings: [g0, edited, g2], defaultIndex: null });
    });

    test('popup move waits for the row edit in flight and moves the edited greeting', async ({ page }) => {
        const { avatar, g0, g2, edited } = await popupOpAfterHeldEdit(page, 'QueueMove', 'move', async (page) => {
            await popupRow(page, 1).locator('.pick_up_greeting').click();
            await greetingsPopup(page).locator('.pick-place-slot').last().click();
        });
        expect(await storedModel(page, avatar)).toEqual({ greetings: [g0, g2, edited], defaultIndex: 0 });
    });

    test('a #character_json_data greeting save waits for the pager save in flight', async ({ page }) => {
        const s = stamp();
        const [g0, g1, g2] = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const [e0, e2] = [`Zero edited ${s}`, `Two edited ${s}`];
        const avatar = await createCharacter(page, `QueueForm-${s}`, [g0, g1, g2]);
        await openCharacter(page, avatar);
        const state = await holdFirstGreetingWrite(page);

        await page.evaluate(async (e0) => {
            const { saveGreetingField } = await import('/script.js');
            // @ts-ignore
            window.__pagerSave = saveGreetingField(e0);
        }, e0);
        await state.held;
        expect(state.started).toEqual(['edit']);

        await page.evaluate(async (e2) => {
            // @ts-ignore
            const card = JSON.parse($('#character_json_data').val());
            card.data.alternate_greetings = [card.data.alternate_greetings[0], e2];
            // @ts-ignore
            $('#character_json_data').val(JSON.stringify(card));
            const { createOrEditCharacter } = await import('/script.js');
            // @ts-ignore
            window.__formSave = createOrEditCharacter(new CustomEvent('newChat'));
        }, e2);
        await page.waitForTimeout(OVERLAP_GRACE_MS);
        expect(state.started, 'the form\'s greeting edit must not be sent while the pager save is in flight').toEqual(['edit']);

        state.release();
        await page.evaluate(async () => {
            // @ts-ignore
            await window.__pagerSave;
            // @ts-ignore
            await window.__formSave;
        });
        expect(state.started).toEqual(['edit', 'edit']);
        expect(state.maxInFlight).toBe(1);
        expect(await storedModel(page, avatar)).toEqual({ greetings: [e0, g1, e2], defaultIndex: 0 });
    });
});

/**
 * Registers a CHARACTER_EDITED listener that, on the first event only, saves `nestedText` through the sidebar pager
 * and waits for that save, then runs `start` and waits up to `limitMs` for it and for the nested save.
 * @param {import('@playwright/test').Page} page
 * @param {string} nestedText
 * @param {'pager'|'form'} outer What starts the outer save: the pager saving `outerText`, or `createOrEditCharacter`
 * after `#character_json_data`'s greetings are set to `outerGreetings`.
 * @param {{outerText?: string, outerGreetings?: string[]}} args
 * @returns {Promise<{outer: string, nested: string}>} Each is `'done'`, or `'hung'` if it didn't finish in time.
 */
async function saveWithNestedListenerSave(page, nestedText, outer, { outerText, outerGreetings }) {
    return page.evaluate(async ({ nestedText, outer, outerText, outerGreetings }) => {
        const limitMs = 10000;
        const { saveGreetingField, createOrEditCharacter } = await import('/script.js');
        // @ts-ignore
        const { eventSource, eventTypes } = SillyTavern.getContext();
        const timedOut = () => new Promise(resolve => setTimeout(() => resolve('hung'), limitMs));
        /** @type {Promise<any>|null} */
        let nested = null;
        const listener = async () => {
            if (nested) return;
            nested = saveGreetingField(nestedText);
            await nested;
        };
        eventSource.on(eventTypes.CHARACTER_EDITED, listener);
        try {
            let outerSave;
            if (outer === 'pager') {
                outerSave = saveGreetingField(outerText);
            } else {
                // @ts-ignore
                const card = JSON.parse($('#character_json_data').val());
                card.first_mes = outerGreetings[0];
                card.data.first_mes = outerGreetings[0];
                card.data.alternate_greetings = outerGreetings.slice(1);
                // @ts-ignore
                $('#character_json_data').val(JSON.stringify(card));
                outerSave = createOrEditCharacter(new CustomEvent('newChat'));
            }
            const outerResult = await Promise.race([outerSave.then(() => 'done'), timedOut()]);
            const nestedResult = nested ? await Promise.race([nested.then(() => 'done'), timedOut()]) : 'never started';
            return { outer: outerResult, nested: nestedResult };
        } finally {
            eventSource.removeListener(eventTypes.CHARACTER_EDITED, listener);
        }
    }, { nestedText, outer, outerText, outerGreetings });
}

test.describe('a greeting save started from inside CHARACTER_EDITED', () => {
    test.beforeEach(testSetup.awaitST);

    test('from a pager save\'s event, both saves finish and the nested one lands last', async ({ page }) => {
        const s = stamp();
        const [g0, g1] = [`Zero ${s}`, `One ${s}`];
        const [outerText, nestedText] = [`Zero outer ${s}`, `Zero nested ${s}`];
        const avatar = await createCharacter(page, `NestedPager-${s}`, [g0, g1]);
        await openCharacter(page, avatar);

        expect(await saveWithNestedListenerSave(page, nestedText, 'pager', { outerText })).toEqual({ outer: 'done', nested: 'done' });
        expect(await storedModel(page, avatar)).toEqual({ greetings: [nestedText, g1], defaultIndex: 0 });
    });

    test('from the first event of a #character_json_data run of several ops, both saves finish', async ({ page }) => {
        const s = stamp();
        const [g0, g1, g2] = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const [e0, e2, nestedText] = [`Zero edited ${s}`, `Two edited ${s}`, `Zero nested ${s}`];
        const avatar = await createCharacter(page, `NestedForm-${s}`, [g0, g1, g2]);
        await openCharacter(page, avatar);

        expect(await saveWithNestedListenerSave(page, nestedText, 'form', { outerGreetings: [e0, g1, e2] })).toEqual({ outer: 'done', nested: 'done' });
        expect(await storedModel(page, avatar)).toEqual({ greetings: [nestedText, g1, e2], defaultIndex: 0 });
    });
});

/**
 * Sets `#character_json_data`'s greetings to `greetings` and runs `createOrEditCharacter`, recording every
 * CHARACTER_EDITED it fires.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} greetings
 * @returns {Promise<{greetingEdit: any, greetingEdits: any}[]>}
 */
async function formSaveEvents(page, greetings) {
    return page.evaluate(async (greetings) => {
        const { createOrEditCharacter } = await import('/script.js');
        // @ts-ignore
        const { eventSource, eventTypes } = SillyTavern.getContext();
        /** @type {{greetingEdit: any, greetingEdits: any}[]} */
        const events = [];
        const listener = (/** @type {any} */ event) => { events.push({ greetingEdit: event.detail.greetingEdit, greetingEdits: event.detail.greetingEdits }); };
        eventSource.on(eventTypes.CHARACTER_EDITED, listener);
        try {
            // @ts-ignore
            const card = JSON.parse($('#character_json_data').val());
            card.first_mes = greetings[0];
            card.data.first_mes = greetings[0];
            card.data.alternate_greetings = greetings.slice(1);
            // @ts-ignore
            $('#character_json_data').val(JSON.stringify(card));
            await createOrEditCharacter(new CustomEvent('newChat'));
            return events;
        } finally {
            eventSource.removeListener(eventTypes.CHARACTER_EDITED, listener);
        }
    }, greetings);
}

test.describe('a #character_json_data greeting save of several ops', () => {
    test.beforeEach(testSetup.awaitST);

    test('fires one CHARACTER_EDITED, with greetingEdit null and greetingEdits listing every changed greeting', async ({ page }) => {
        const s = stamp();
        const [g0, g1, g2] = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const [e0, e2] = [`Zero edited ${s}`, `Two edited ${s}`];
        const avatar = await createCharacter(page, `FormOneEvent-${s}`, [g0, g1, g2]);
        await openCharacter(page, avatar);

        expect(await formSaveEvents(page, [e0, g1, e2])).toEqual([{
            greetingEdit: null,
            greetingEdits: [{ from: g0, to: e0, index: 0 }, { from: g2, to: e2, index: 2 }],
        }]);
        expect(await storedModel(page, avatar)).toEqual({ greetings: [e0, g1, e2], defaultIndex: 0 });
    });

    test('with one greeting changed, greetingEdit is that change and greetingEdits lists only it', async ({ page }) => {
        const s = stamp();
        const [g0, g1] = [`Zero ${s}`, `One ${s}`];
        const e1 = `One edited ${s}`;
        const avatar = await createCharacter(page, `FormOneEdit-${s}`, [g0, g1]);
        await openCharacter(page, avatar);

        const edit = { from: g1, to: e1, index: 1 };
        expect(await formSaveEvents(page, [g0, e1])).toEqual([{ greetingEdit: edit, greetingEdits: [edit] }]);
    });

    test('the chat keeps showing the greeting it was on, with its new text', async ({ page }) => {
        const s = stamp();
        const [g0, g1, g2] = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const [e0, e2] = [`Zero edited ${s}`, `Two edited ${s}`];
        const avatar = await createCharacter(page, `FormFollow-${s}`, [g0, g1, g2]);
        await openCharacter(page, avatar);
        await page.evaluate(async () => {
            const { swipe } = await import('/script.js');
            const { SWIPE_DIRECTION, SWIPE_SOURCE } = await import('/scripts/constants.js');
            await swipe(null, SWIPE_DIRECTION.RIGHT, { source: SWIPE_SOURCE.SWIPE_PICKER, forceMesId: 0, forceSwipeId: 2 });
        });
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(g2, { timeout: 10000 });

        await formSaveEvents(page, [e0, g1, e2]);

        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(e2, { timeout: 10000 });
        const opening = await page.evaluate(() => {
            // @ts-ignore
            const m = SillyTavern.getContext().chat[0];
            return { mes: m.mes, swipe_id: m.swipe_id, swipes: [...m.swipes] };
        });
        expect(opening).toEqual({ mes: e2, swipe_id: 2, swipes: [e0, g1, e2] });
    });
});
