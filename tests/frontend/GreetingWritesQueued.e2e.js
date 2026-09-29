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
