import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

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
 * Opens the character and waits for its chat's opening to be in place.
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
 * Every opening the server has for the character, stored and card-only, in order.
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function storedOpenings(page, avatar) {
    return page.evaluate(async (avatar) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        const response = await fetch('/api/chats/openings', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, offset: 0, limit: 100 }) });
        const body = await response.json();
        return body.alternatives.map((/** @type {any} */ a) => ({ stored: a.node_id != null, mes: a.mes }));
    }, avatar);
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function opening(page) {
    return page.evaluate(() => {
        // @ts-ignore
        const m = SillyTavern.getContext().chat[0];
        return { mes: m.mes, node_id: m.node_id, swipes: [...m.swipes] };
    });
}

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test.describe('editing a card greeting in the chat', () => {
    test.beforeEach(testSetup.awaitST);

    test('saves the edit as a stored opening, and the card\'s untouched greeting stays offered, after a reload too', async ({ page }) => {
        const s = stamp();
        const g = [`Zero ${s}`, `One ${s}`, `Two ${s}`];
        const avatar = await createCharacter(page, `ChatEditsOpening-${s}`, g);
        await openCharacter(page, avatar);
        expect((await opening(page)).node_id.startsWith('card:')).toBe(true);

        const edited = `Zero edited in chat ${s}`;
        await page.locator('#chat .mes[mesid="0"] .mes_edit').click();
        await page.locator('#curEditTextarea').fill(edited);
        await page.locator('#chat .mes[mesid="0"] .mes_edit_done').click();
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(edited, { timeout: 10000 });

        await expect.poll(() => storedOpenings(page, avatar), { timeout: 10000 }).toEqual([
            { stored: true, mes: edited },
            { stored: false, mes: g[0] },
            { stored: false, mes: g[1] },
            { stored: false, mes: g[2] },
        ]);
        await expect.poll(async () => (await opening(page)).swipes, { timeout: 10000 }).toEqual([edited, g[0], g[1], g[2]]);
        const now = await opening(page);
        expect(now.mes).toBe(edited);
        expect(now.node_id.startsWith('card:')).toBe(false);

        await page.reload();
        await testSetup.awaitST({ page });
        await openCharacter(page, avatar);
        await expect(page.locator('#chat .mes[mesid="0"] .mes_text')).toHaveText(edited, { timeout: 10000 });
        const reloaded = await opening(page);
        expect(reloaded.node_id).toBe(now.node_id);
        expect(reloaded.swipes).toEqual([edited, g[0], g[1], g[2]]);
    });
});
