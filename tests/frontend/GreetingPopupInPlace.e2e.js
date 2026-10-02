import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, openInfoTab } from './frontent-test-utils.js';

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
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function openCharacter(page, avatar) {
    await openCharacterManagementDrawer(page);
    await page.evaluate(async (avatar) => {
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });
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
 * @param {number} count
 */
async function openGreetingsPopup(page, count) {
    await openInfoTab(page, 'greeting');
    await page.locator('.open_alternate_greetings').click();
    await expect(greetingsPopup(page).locator('.alternate_greetings_list .alternate_greeting')).toHaveCount(count, { timeout: 10000 });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} op
 */
function greetingOpResponse(page, op) {
    return page.waitForResponse(response => new URL(response.url()).pathname === `/api/characters/greetings/${op}`, { timeout: 15000 });
}

/**
 * Tags the popup and every row element with a marker, so a later check can tell whether they are the same elements.
 * @param {import('@playwright/test').Page} page
 */
async function markElements(page) {
    await page.evaluate(() => {
        const list = document.querySelectorAll('.popup .alternate_greetings_list');
        const popupList = list[list.length - 1];
        // @ts-ignore
        popupList.closest('.popup').__marker = 'popup';
        popupList.querySelectorAll(':scope > .alternate_greeting').forEach((row, index) => {
            // @ts-ignore
            row.__marker = `row-${index}`;
        });
    });
}

/**
 * The marker each row carries, in the order shown; null for a row made since {@link markElements}.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{popup: string|null, rows: (string|null)[]}>}
 */
async function readMarkers(page) {
    return page.evaluate(() => {
        const list = document.querySelectorAll('.popup .alternate_greetings_list');
        const popupList = list[list.length - 1];
        return {
            // @ts-ignore
            popup: popupList.closest('.popup').__marker ?? null,
            // @ts-ignore
            rows: Array.from(popupList.querySelectorAll(':scope > .alternate_greeting')).map(row => row.__marker ?? null),
        };
    });
}

/**
 * Puts text and the cursor in a row without letting its save be sent yet.
 * @param {import('@playwright/test').Locator} textarea
 * @param {string} text
 * @param {number} cursor
 */
async function typeInto(textarea, text, cursor) {
    await textarea.click();
    await textarea.fill(text);
    await textarea.evaluate((element, cursor) => {
        /** @type {HTMLTextAreaElement} */ (element).setSelectionRange(cursor, cursor);
    }, cursor);
}

/**
 * @param {import('@playwright/test').Locator} textarea
 * @returns {Promise<{value: string, cursor: number}>}
 */
function textareaState(textarea) {
    return textarea.evaluate(element => ({
        value: /** @type {HTMLTextAreaElement} */ (element).value,
        cursor: /** @type {HTMLTextAreaElement} */ (element).selectionStart,
    }));
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<HTMLElement>}
 */
function scrollerHandle(page) {
    return /** @type {any} */ (page.evaluateHandle(() => {
        const list = document.querySelectorAll('.popup .alternate_greetings_list');
        /** @type {HTMLElement|null} */
        let element = /** @type {HTMLElement} */ (list[list.length - 1]);
        while (element && element.scrollHeight <= element.clientHeight) element = element.parentElement;
        return element;
    }));
}

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test.describe('greetings popup changes only the rows an action touches', () => {
    test.beforeEach(testSetup.awaitST);

    test('deleting a greeting keeps the popup and the other rows, with their typing and cursor', async ({ page }) => {
        const s = stamp();
        const greetings = ['Alpha', 'Bravo', 'Charlie', 'Delta'].map(name => `${name} ${s}`);
        const avatar = await createCharacter(page, `InPlaceDelete-${s}`, greetings);
        await openCharacter(page, avatar);
        await openGreetingsPopup(page, 4);
        await markElements(page);

        const typed = `Charlie typed ${s}`;
        await typeInto(popupRow(page, 2).locator('.alternate_greeting_text'), typed, 5);

        await popupRow(page, 0).locator('.delete_alternate_greeting').click();
        const deleted = greetingOpResponse(page, 'delete');
        await page.locator('dialog[open] .popup-button-ok').last().click();
        expect((await deleted).ok()).toBe(true);

        await expect(greetingsPopup(page).locator('.alternate_greetings_list .alternate_greeting')).toHaveCount(3);
        expect(await readMarkers(page)).toEqual({ popup: 'popup', rows: ['row-1', 'row-2', 'row-3'] });
        expect(await textareaState(popupRow(page, 1).locator('.alternate_greeting_text'))).toEqual({ value: typed, cursor: 5 });
        await expect(popupRow(page, 1).locator('.greeting_index')).toHaveText('2');
        await expect(popupRow(page, 0).locator('.alternate_greeting_text')).toHaveValue(greetings[1]);
    });

    test('deleting a greeting below the visible ones leaves the scroll where it was', async ({ page }) => {
        const s = stamp();
        const long = Array.from({ length: 12 }, () => 'line').join('\n');
        const greetings = Array.from({ length: 14 }, (_, index) => `Greeting ${index} ${s}\n${long}`);
        const avatar = await createCharacter(page, `InPlaceScroll-${s}`, greetings);
        await openCharacter(page, avatar);
        await openGreetingsPopup(page, 14);
        await markElements(page);

        const scroller = await scrollerHandle(page);
        await page.evaluate(element => { element.scrollTop = 300; }, scroller);
        const before = await page.evaluate(element => element.scrollTop, scroller);
        expect(before).toBeGreaterThan(0);

        await popupRow(page, 13).locator('.delete_alternate_greeting').evaluate(element => /** @type {HTMLElement} */ (element).click());
        const deleted = greetingOpResponse(page, 'delete');
        await page.locator('dialog[open] .popup-button-ok').last().click();
        expect((await deleted).ok()).toBe(true);

        await expect(greetingsPopup(page).locator('.alternate_greetings_list .alternate_greeting')).toHaveCount(13);
        expect((await readMarkers(page)).rows).toEqual(Array.from({ length: 13 }, (_, index) => `row-${index}`));
        expect(await page.evaluate(element => element.scrollTop, scroller)).toBe(before);
    });

    test('moving and setting the default keep every row, and a row being typed in keeps its text', async ({ page }) => {
        const s = stamp();
        const greetings = ['Alpha', 'Bravo', 'Charlie', 'Delta'].map(name => `${name} ${s}`);
        const avatar = await createCharacter(page, `InPlaceMove-${s}`, greetings);
        await openCharacter(page, avatar);
        await openGreetingsPopup(page, 4);
        await markElements(page);

        const typed = `Delta typed ${s}`;
        await typeInto(popupRow(page, 3).locator('.alternate_greeting_text'), typed, 3);

        await popupRow(page, 0).locator('.pick_up_greeting').click();
        const moved = greetingOpResponse(page, 'move');
        await greetingsPopup(page).locator('.pick-place-slot').nth(1).click();
        expect((await moved).ok()).toBe(true);

        await expect.poll(async () => (await readMarkers(page)).rows).toEqual(['row-1', 'row-2', 'row-0', 'row-3']);
        expect((await readMarkers(page)).popup).toBe('popup');
        await expect(popupRow(page, 2).locator('.alternate_greeting_text')).toHaveValue(greetings[0]);
        expect(await textareaState(popupRow(page, 3).locator('.alternate_greeting_text'))).toEqual({ value: typed, cursor: 3 });

        const set = greetingOpResponse(page, 'default/set');
        await popupRow(page, 1).locator('.set_default_greeting').click();
        expect((await set).ok()).toBe(true);
        await expect(popupRow(page, 1).locator('.greeting_default_badge')).toBeVisible();
        await expect(popupRow(page, 2).locator('.greeting_default_badge')).toBeHidden();
        expect(await readMarkers(page)).toEqual({ popup: 'popup', rows: ['row-1', 'row-2', 'row-0', 'row-3'] });
        await expect(popupRow(page, 3).locator('.alternate_greeting_text')).toHaveValue(typed);
    });

    test('adding a greeting keeps the rows already there', async ({ page }) => {
        const s = stamp();
        const greetings = ['Alpha', 'Bravo'].map(name => `${name} ${s}`);
        const avatar = await createCharacter(page, `InPlaceAdd-${s}`, greetings);
        await openCharacter(page, avatar);
        await openGreetingsPopup(page, 2);
        await markElements(page);

        const typed = `Bravo typed ${s}`;
        await typeInto(popupRow(page, 1).locator('.alternate_greeting_text'), typed, 4);

        await greetingsPopup(page).locator('.add_alternate_greeting').click();
        const added = greetingOpResponse(page, 'add');
        await greetingsPopup(page).locator('.alternate_greeting.greeting-draft .alternate_greeting_text').fill(`Charlie ${s}`);
        expect((await added).ok()).toBe(true);

        await expect.poll(async () => (await readMarkers(page)).rows).toEqual(['row-0', 'row-1', null]);
        expect((await readMarkers(page)).popup).toBe('popup');
        await expect(popupRow(page, 1).locator('.alternate_greeting_text')).toHaveValue(typed);
        await expect(popupRow(page, 2).locator('.alternate_greeting_text')).toHaveValue(`Charlie ${s}`);
    });

    test('a refused edit refreshes in place: other rows stay, the typed row keeps its text, and the edit is kept', async ({ page }) => {
        const s = stamp();
        const greetings = ['Alpha', 'Bravo', 'Charlie'].map(name => `${name} ${s}`);
        const avatar = await createCharacter(page, `InPlaceConflict-${s}`, greetings);
        await openCharacter(page, avatar);
        await openGreetingsPopup(page, 3);
        await markElements(page);

        let refused = false;
        await page.route('**/api/characters/greetings/edit', async route => {
            if (refused) return route.continue();
            refused = true;
            await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, reason: 'hash mismatch' }) });
        });

        const typed = `Bravo typed ${s}`;
        const textarea = popupRow(page, 1).locator('.alternate_greeting_text');
        await typeInto(textarea, typed, 2);
        const edit = greetingOpResponse(page, 'edit');
        expect((await edit).status()).toBe(409);

        await expect(greetingsPopup(page).locator('.greeting-conflict-draft')).toHaveCount(1, { timeout: 10000 });
        await expect(greetingsPopup(page).locator('.greeting-conflict-draft-text')).toHaveValue(typed);
        expect(await readMarkers(page)).toEqual({ popup: 'popup', rows: ['row-0', 'row-1', 'row-2'] });
        expect(await textareaState(textarea)).toEqual({ value: typed, cursor: 2 });
    });
});
