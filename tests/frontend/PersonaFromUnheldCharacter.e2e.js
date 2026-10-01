import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// convertCharacterToPersona takes upstream's index into getContext().characters or an avatar key, and converts a
// character the page doesn't hold from its full card on the server.

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/** @param {import('@playwright/test').Page} page */
async function loadApp(page) {
    await testSetup.awaitST({ page });
    await page.evaluate(() => {
        window['__appReady'] = false;
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, () => { window['__appReady'] = true; });
    });
    await page.waitForFunction(() => window['__appReady'], null, { timeout: 60000 });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string} description
 * @returns {Promise<string>} its avatar key
 */
async function createCharacter(page, name, description) {
    return page.evaluate(async ({ name, description }) => {
        const { getRequestHeaders } = await import('./script.js');
        const form = new FormData();
        form.set('ch_name', name);
        form.set('description', description);
        const response = await fetch('/api/characters/create', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, { name, description });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string|number} characterId
 * @returns {Promise<{ converted: boolean, persona: any }>}
 */
async function convert(page, characterId, personaKey) {
    return page.evaluate(async ({ characterId, personaKey }) => {
        const { convertCharacterToPersona } = await import('./scripts/personas.js');
        const { personaStore } = await import('./scripts/power-user.js');
        const converted = await convertCharacterToPersona(characterId);
        return { converted, persona: personaStore.get(personaKey) ?? null };
    }, { characterId, personaKey });
}

test.describe('convertCharacterToPersona', () => {
    test.beforeEach(async ({ page }) => {
        await loadApp(page);
    });

    test('converts a character the page does not hold, with its description', async ({ page }) => {
        await page.route('**/api/characters/changes', route => route.fulfill({ status: 500 }));
        const name = `PersonaUnheld ${Date.now()}`;
        const avatar = await createCharacter(page, name, 'A quiet librarian.');
        const held = await page.evaluate(async (avatar) => {
            const { charactersStore } = await import('./scripts/character-store.js');
            return charactersStore.has(avatar);
        }, avatar);
        expect(held).toBe(false);

        const result = await convert(page, avatar, `${name} (Persona).png`);

        expect(result.converted).toBe(true);
        expect(result.persona?.name).toBe(name);
        expect(result.persona?.description).toBe('A quiet librarian.');
    });

    test('takes an index into getContext().characters, as upstream does', async ({ page }) => {
        const name = `PersonaIndex ${Date.now()}`;
        const avatar = await createCharacter(page, name, 'Keeps the lighthouse.');
        // Extensions are shown the current character, so that is the one an index can name.
        await page.evaluate(async (avatar) => {
            const { getCharacters } = await import('./scripts/character-list.js');
            await getCharacters();
            const { selectCharacterByAvatar } = await import('./script.js');
            await selectCharacterByAvatar(avatar);
        }, avatar);
        const index = await page.evaluate(avatar => window['SillyTavern'].getContext().characters.findIndex(c => c.avatar === avatar), avatar);
        expect(index).toBeGreaterThanOrEqual(0);

        const result = await convert(page, index, `${name} (Persona).png`);

        expect(result.converted).toBe(true);
        expect(result.persona?.description).toBe('Keeps the lighthouse.');
    });
});
