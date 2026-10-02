import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, openInfoTab } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string[]} greetings The first one is the default.
 * @returns {Promise<string>} The avatar filename.
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
 * The greetings in the server's order, while the default is position 0.
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
 * Changes a greeting the way another session would, behind the open popup's back.
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @param {number} position
 * @param {string} oldText
 * @param {string} newText
 */
async function editElsewhere(page, avatar, position, oldText, newText) {
    const status = await page.evaluate(async ({ avatar, position, oldText, newText }) => {
        const { getStringHash } = await import('/scripts/hash-utils.js');
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        const body = { avatar_url: avatar, position, expected_hash: getStringHash(JSON.stringify(oldText)), text: newText };
        const response = await fetch('/api/characters/greetings/edit', { method: 'POST', headers, body: JSON.stringify(body) });
        return response.status;
    }, { avatar, position, oldText, newText });
    expect(status).toBe(200);
}

/**
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
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} op
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
 * @param {number} count
 */
async function openGreetingsPopup(page, count) {
    await openInfoTab(page, 'greeting');
    await page.locator('.open_alternate_greetings').click();
    await expect(greetingsPopup(page).locator('.alternate_greetings_list .alternate_greeting')).toHaveCount(count, { timeout: 10000 });
}

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test.describe('greetings popup: a change made elsewhere', () => {
    test.beforeEach(testSetup.awaitST);

    test('a refused edit shows the current version, and the typed text is kept across a reload until applied', async ({ page }) => {
        const s = stamp();
        const greetings = [`Alpha ${s}`, `Bravo ${s}`, `Charlie ${s}`];
        const avatar = await createCharacter(page, `ConflictEdit-${s}`, greetings);
        await openCharacter(page, avatar);
        await openGreetingsPopup(page, 3);

        const elsewhere = `Bravo elsewhere ${s}`;
        await editElsewhere(page, avatar, 1, greetings[1], elsewhere);

        const typed = `Bravo typed here ${s}`;
        const refused = greetingOpResponse(page, 'edit');
        await popupRow(page, 1).locator('.alternate_greeting_text').fill(typed);
        expect((await refused).status()).toBe(409);

        await expect(page.locator('.toast-warning', { hasText: 'Greeting not saved' })).toBeVisible({ timeout: 10000 });
        await expect(popupRow(page, 1).locator('.alternate_greeting_text')).toHaveValue(elsewhere, { timeout: 10000 });
        const kept = greetingsPopup(page).locator('.greeting-conflict-draft');
        await expect(kept).toHaveCount(1);
        await expect(kept.locator('.greeting-conflict-draft-text')).toHaveValue(typed);
        expect(await serverGreetings(page, avatar)).toEqual([greetings[0], elsewhere, greetings[2]]);

        await page.reload();
        await testSetup.awaitST({ page });
        await openCharacter(page, avatar);
        await openGreetingsPopup(page, 3);
        await expect(greetingsPopup(page).locator('.greeting-conflict-draft-text')).toHaveValue(typed);

        const applied = greetingOpResponse(page, 'edit');
        await greetingsPopup(page).locator('.greeting-conflict-draft-apply').click();
        expect((await applied).ok()).toBe(true);
        await expect(popupRow(page, 1).locator('.alternate_greeting_text')).toHaveValue(typed, { timeout: 10000 });
        await expect(greetingsPopup(page).locator('.greeting-conflict-draft')).toHaveCount(0);
        expect(await serverGreetings(page, avatar)).toEqual([greetings[0], typed, greetings[2]]);
    });

    test('a kept edit can be discarded', async ({ page }) => {
        const s = stamp();
        const greetings = [`Alpha ${s}`, `Bravo ${s}`];
        const avatar = await createCharacter(page, `ConflictDiscard-${s}`, greetings);
        await openCharacter(page, avatar);
        await openGreetingsPopup(page, 2);

        const elsewhere = `Bravo elsewhere ${s}`;
        await editElsewhere(page, avatar, 1, greetings[1], elsewhere);
        const refused = greetingOpResponse(page, 'edit');
        await popupRow(page, 1).locator('.alternate_greeting_text').fill(`typed ${s}`);
        expect((await refused).status()).toBe(409);

        await expect(greetingsPopup(page).locator('.greeting-conflict-draft')).toHaveCount(1, { timeout: 10000 });
        await greetingsPopup(page).locator('.greeting-conflict-draft-discard').click();
        await expect(greetingsPopup(page).locator('.greeting-conflict-draft')).toHaveCount(0);
        const stored = await page.evaluate((avatar) => localStorage.getItem(`GreetingConflictDrafts:${avatar}`), avatar);
        expect(stored).toBeNull();
        expect(await serverGreetings(page, avatar)).toEqual([greetings[0], elsewhere]);
    });

    test('a refused delete shows the current version in place', async ({ page }) => {
        const s = stamp();
        const greetings = [`Alpha ${s}`, `Bravo ${s}`, `Charlie ${s}`];
        const avatar = await createCharacter(page, `ConflictDelete-${s}`, greetings);
        await openCharacter(page, avatar);
        await openGreetingsPopup(page, 3);

        const elsewhere = `Charlie elsewhere ${s}`;
        await editElsewhere(page, avatar, 2, greetings[2], elsewhere);

        const refused = greetingOpResponse(page, 'delete');
        await popupRow(page, 2).locator('.delete_alternate_greeting').click();
        await page.locator('dialog[open] .popup-button-ok').last().click();
        expect((await refused).status()).toBe(409);

        await expect(page.locator('.toast-warning', { hasText: 'Greeting not deleted' })).toBeVisible({ timeout: 10000 });
        await expect(popupRow(page, 2).locator('.alternate_greeting_text')).toHaveValue(elsewhere, { timeout: 10000 });
        expect(await serverGreetings(page, avatar)).toEqual([greetings[0], greetings[1], elsewhere]);
    });

    test('a refused set-default shows the current version in place', async ({ page }) => {
        const s = stamp();
        const greetings = [`Alpha ${s}`, `Bravo ${s}`, `Charlie ${s}`];
        const avatar = await createCharacter(page, `ConflictDefault-${s}`, greetings);
        await openCharacter(page, avatar);
        await openGreetingsPopup(page, 3);

        const elsewhere = `Charlie elsewhere ${s}`;
        await editElsewhere(page, avatar, 2, greetings[2], elsewhere);

        const refused = greetingOpResponse(page, 'default/set');
        await popupRow(page, 2).locator('.set_default_greeting').click();
        expect((await refused).status()).toBe(409);

        await expect(page.locator('.toast-warning', { hasText: 'Default not changed' })).toBeVisible({ timeout: 10000 });
        await expect(popupRow(page, 2).locator('.alternate_greeting_text')).toHaveValue(elsewhere, { timeout: 10000 });
        expect(await serverGreetings(page, avatar)).toEqual([greetings[0], greetings[1], elsewhere]);
    });
});
