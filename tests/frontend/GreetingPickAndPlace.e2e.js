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
 * The character's greetings in the server's order. Only valid while the default is position 0.
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @returns {Promise<string[]>}
 */
async function serverGreetings(page, avatar) {
    return page.evaluate(async (avatar) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        const response = await fetch('/api/characters/get', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar }) });
        if (!response.ok) throw new Error(`get failed: ${response.status}`);
        const character = await response.json();
        return [character.first_mes, ...character.data.alternate_greetings];
    }, avatar);
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
 * @param {import('@playwright/test').Page} page
 * @param {string} op e.g. 'edit', 'default/set'
 */
function greetingOpResponse(page, op) {
    return page.waitForResponse(response => new URL(response.url()).pathname === `/api/characters/greetings/${op}`, { timeout: 15000 });
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
 * @param {import('@playwright/test').Locator} locator
 * @returns {Promise<boolean>} Whether the element right before it is a pick-and-place slot.
 */
function hasSlotBefore(locator) {
    return locator.evaluate(element => element.previousElementSibling?.classList.contains('pick-place-slot') ?? false);
}

/**
 * @param {import('@playwright/test').Locator} locator
 * @returns {Promise<boolean>} Whether the element right after it is a pick-and-place slot.
 */
function hasSlotAfter(locator) {
    return locator.evaluate(element => element.nextElementSibling?.classList.contains('pick-place-slot') ?? false);
}

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/**
 * @param {string} s
 */
const greetingsFor = s => [`Alpha ${s}`, `Bravo ${s}`, `Charlie ${s}`, `Delta ${s}`];

test.describe('greetings popup pick and place', () => {
    test.beforeEach(testSetup.awaitST);

    test('a slot recreated by filtering still places the picked greeting', async ({ page }) => {
        const s = stamp();
        const [alpha, bravo, charlie, delta] = greetingsFor(s);
        const avatar = await createCharacter(page, `PickFilter-${s}`, [alpha, bravo, charlie, delta]);
        await openCharacter(page, avatar);
        await openGreetingsPopup(page, 4);

        await popupRow(page, 3).locator('.pick_up_greeting').click();
        await greetingsPopup(page).locator('.greeting-filter-input').fill('Bravo');

        const slots = greetingsPopup(page).locator('.pick-place-slot');
        await expect(slots).toHaveCount(1);
        expect(await hasSlotBefore(popupRow(page, 1))).toBe(true);

        const response = greetingOpResponse(page, 'move');
        await slots.click();
        expect((await response).ok()).toBe(true);
        expect(await serverGreetings(page, avatar)).toEqual([alpha, delta, bravo, charlie]);
    });

    test('no slot is offered that would leave the picked greeting in place when its neighbours are filtered out', async ({ page }) => {
        const s = stamp();
        const [alpha, bravo, charlie, delta] = greetingsFor(s);
        const avatar = await createCharacter(page, `PickNoOp-${s}`, [alpha, bravo, charlie, delta]);
        await openCharacter(page, avatar);
        await openGreetingsPopup(page, 4);

        await popupRow(page, 1).locator('.pick_up_greeting').click();
        await greetingsPopup(page).locator('.greeting-filter-input').fill('ha');
        await expect(popupRow(page, 1)).toBeHidden();
        await expect(popupRow(page, 3)).toBeHidden();

        const slots = greetingsPopup(page).locator('.pick-place-slot');
        await expect(slots).toHaveCount(2);
        expect(await hasSlotBefore(popupRow(page, 0))).toBe(true);
        expect(await hasSlotBefore(popupRow(page, 2))).toBe(false);
        expect(await hasSlotAfter(popupRow(page, 2))).toBe(true);

        const response = greetingOpResponse(page, 'move');
        await slots.last().click();
        expect((await response).ok()).toBe(true);
        expect(await serverGreetings(page, avatar)).toEqual([alpha, charlie, delta, bravo]);
    });

    test('a move whose target changed in another session is refused and the popup reloads', async ({ page }) => {
        const s = stamp();
        const [alpha, bravo, charlie, delta] = greetingsFor(s);
        const avatar = await createCharacter(page, `PickStale-${s}`, [alpha, bravo, charlie, delta]);
        await openCharacter(page, avatar);
        await openGreetingsPopup(page, 4);

        await popupRow(page, 0).locator('.pick_up_greeting').click();

        const deltaChanged = `Delta changed ${s}`;
        const editStatus = await page.evaluate(async ({ avatar, delta, deltaChanged }) => {
            const { getStringHash } = await import('/scripts/hash-utils.js');
            // @ts-ignore
            const headers = SillyTavern.getContext().getRequestHeaders();
            const body = { avatar_url: avatar, position: 3, expected_hash: getStringHash(JSON.stringify(delta)), text: deltaChanged };
            const response = await fetch('/api/characters/greetings/edit', { method: 'POST', headers, body: JSON.stringify(body) });
            return response.status;
        }, { avatar, delta, deltaChanged });
        expect(editStatus).toBe(200);

        const response = greetingOpResponse(page, 'move');
        await greetingsPopup(page).locator('.pick-place-slot').last().click();
        expect((await response).status()).toBe(409);

        await expect(page.locator('.toast-warning', { hasText: 'Greeting not moved' })).toBeVisible({ timeout: 10000 });
        expect(await serverGreetings(page, avatar)).toEqual([alpha, bravo, charlie, deltaChanged]);
        await expect(popupRow(page, 3).locator('.alternate_greeting_text')).toHaveValue(deltaChanged, { timeout: 10000 });
        await expect(greetingsPopup(page).locator('.pick-place-picked')).toHaveCount(0);
    });

    test('a refused move whose reload fails blocks moves on the stale list until a retry reloads it', async ({ page }) => {
        const s = stamp();
        const [alpha, bravo, charlie, delta] = greetingsFor(s);
        const avatar = await createCharacter(page, `PickReloadFail-${s}`, [alpha, bravo, charlie, delta]);
        await openCharacter(page, avatar);
        await openGreetingsPopup(page, 4);

        await popupRow(page, 0).locator('.pick_up_greeting').click();

        const deltaChanged = `Delta changed ${s}`;
        const editStatus = await page.evaluate(async ({ avatar, delta, deltaChanged }) => {
            const { getStringHash } = await import('/scripts/hash-utils.js');
            // @ts-ignore
            const headers = SillyTavern.getContext().getRequestHeaders();
            const body = { avatar_url: avatar, position: 3, expected_hash: getStringHash(JSON.stringify(delta)), text: deltaChanged };
            const response = await fetch('/api/characters/greetings/edit', { method: 'POST', headers, body: JSON.stringify(body) });
            return response.status;
        }, { avatar, delta, deltaChanged });
        expect(editStatus).toBe(200);

        await page.route('**/api/characters/get', route => route.fulfill({ status: 500 }));

        const refusedResponse = greetingOpResponse(page, 'move');
        await greetingsPopup(page).locator('.pick-place-slot').last().click();
        expect((await refusedResponse).status()).toBe(409);

        const refreshFailed = greetingsPopup(page).locator('.greeting-refresh-failed');
        const pickButtons = greetingsPopup(page).locator('.pick_up_greeting');
        await expect(page.locator('.toast-error', { hasText: 'Greeting not moved' })).toBeVisible({ timeout: 10000 });
        await expect(refreshFailed).toBeVisible();
        await expect(pickButtons).not.toHaveCount(0);
        await expect(greetingsPopup(page).locator('.pick_up_greeting:not(.disabled)')).toHaveCount(0);
        await expect(greetingsPopup(page).locator('.pick-place-slot')).toHaveCount(0);
        await expect(greetingsPopup(page).locator('.pick-place-picked')).toHaveCount(0);
        await expect(popupRow(page, 3).locator('.alternate_greeting_text')).toHaveValue(delta);

        const blockedPick = popupRow(page, 1).locator('.pick_up_greeting');
        expect(await blockedPick.evaluate(element => getComputedStyle(element).pointerEvents)).toBe('none');
        await blockedPick.dispatchEvent('click');
        await expect(greetingsPopup(page).locator('.pick-place-slot')).toHaveCount(0);
        await expect(greetingsPopup(page).locator('.pick-place-picked')).toHaveCount(0);

        await greetingsPopup(page).locator('.greeting_refresh_retry').click();
        await expect(page.locator('.toast-error', { hasText: 'Greeting list not refreshed' })).toBeVisible({ timeout: 10000 });
        await expect(refreshFailed).toBeVisible();

        await page.unroute('**/api/characters/get');
        await greetingsPopup(page).locator('.greeting_refresh_retry').click();
        await expect(popupRow(page, 3).locator('.alternate_greeting_text')).toHaveValue(deltaChanged, { timeout: 10000 });
        await expect(greetingsPopup(page).locator('.greeting-refresh-failed')).toBeHidden();
        await expect(greetingsPopup(page).locator('.pick_up_greeting.disabled')).toHaveCount(0);

        await popupRow(page, 1).locator('.pick_up_greeting').click();
        const moveResponse = greetingOpResponse(page, 'move');
        await greetingsPopup(page).locator('.pick-place-slot').last().click();
        expect((await moveResponse).ok()).toBe(true);
        expect(await serverGreetings(page, avatar)).toEqual([alpha, charlie, deltaChanged, bravo]);
    });

    test('picking the picked greeting again cancels', async ({ page }) => {
        const s = stamp();
        const avatar = await createCharacter(page, `PickCancel-${s}`, greetingsFor(s));
        await openCharacter(page, avatar);
        await openGreetingsPopup(page, 4);

        const slots = greetingsPopup(page).locator('.pick-place-slot');
        await popupRow(page, 1).locator('.pick_up_greeting').click();
        await expect(slots).not.toHaveCount(0);
        await expect(popupRow(page, 1)).toHaveClass(/(^|\s)pick-place-picked(\s|$)/);

        await popupRow(page, 1).locator('.pick_up_greeting').click();
        await expect(slots).toHaveCount(0);
        await expect(greetingsPopup(page).locator('.pick-place-picked')).toHaveCount(0);
    });
});
