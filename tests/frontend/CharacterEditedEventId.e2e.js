import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * Creates a character through the API.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @returns {Promise<string>} The new character's avatar filename.
 */
async function createCharacter(page, name) {
    return page.evaluate(async (name) => {
        const { getRequestHeaders } = await import('./script.js');
        const form = new FormData();
        form.set('ch_name', name);
        const response = await fetch('/api/characters/create', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, name);
}

/**
 * Selects the character, which also loads it into the character panel.
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function selectCharacter(page, avatar) {
    await page.evaluate(async (avatar) => {
        const { selectCharacterByAvatar } = await import('./script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar);
}

/**
 * Records every CHARACTER_EDITED from here on as the avatar it carries, the id it carries, and the avatar of
 * the character that id indexes in `characters` at the time it fires.
 * @param {import('@playwright/test').Page} page
 */
async function recordCharacterEdited(page) {
    await page.evaluate(async () => {
        const { eventSource, event_types } = await import('./script.js');
        const { characters } = await import('./scripts/character-store.js');
        // @ts-ignore
        window.__characterEdited = [];
        eventSource.on(event_types.CHARACTER_EDITED, (event) => {
            const id = event?.detail?.id;
            // @ts-ignore
            window.__characterEdited.push({
                avatar: event?.detail?.character?.avatar,
                id: id === undefined ? 'undefined' : String(id),
                idAvatar: id === undefined ? 'undefined' : characters[id]?.avatar,
            });
        });
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{avatar: string, id: string, idAvatar: string}[]>}
 */
async function recordedCharacterEdited(page) {
    // @ts-ignore
    return page.evaluate(() => window.__characterEdited);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string[]} avatars
 */
async function deleteCharacters(page, avatars) {
    await page.evaluate(async (avatars) => {
        const { getRequestHeaders } = await import('./script.js');
        for (const avatar of avatars) {
            await fetch('/api/characters/delete', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar, delete_chats: true }),
            });
        }
    }, avatars);
}

test.describe('CHARACTER_EDITED never carries an id that names a different character', () => {
    test.beforeEach(testSetup.awaitST);

    test('a field save for the current character carries the current character\'s id', async ({ page }) => {
        const stamp = Date.now();
        const avatar = await createCharacter(page, `EditedIdCurrent-${stamp}`);
        try {
            await openCharacterManagementDrawer(page);
            await selectCharacter(page, avatar);
            await recordCharacterEdited(page);

            const saved = await page.evaluate(async (avatar) => {
                const { saveCharacterField } = await import('./script.js');
                return saveCharacterField(avatar, '#description_textarea', 'edited description');
            }, avatar);
            expect(saved).toBe(true);

            const edited = await recordedCharacterEdited(page);
            expect(edited).toHaveLength(1);
            expect(edited[0].avatar).toBe(avatar);
            expect(edited[0].id).not.toBe('undefined');
            expect(edited[0].idAvatar).toBe(avatar);
        } finally {
            await deleteCharacters(page, [avatar]);
        }
    });

    test('a field save that finishes after another character was selected does not carry that other character\'s id', async ({ page }) => {
        const stamp = Date.now();
        const avatarA = await createCharacter(page, `EditedIdA-${stamp}`);
        const avatarB = await createCharacter(page, `EditedIdB-${stamp}`);
        try {
            await openCharacterManagementDrawer(page);
            await selectCharacter(page, avatarA);

            // Hold A's field save at the server until B has been selected.
            const marker = `saved while A was selected ${stamp}`;
            let heldCount = 0;
            let release;
            const released = new Promise(resolve => { release = resolve; });
            await page.route('**/api/characters/merge-attributes', async (route) => {
                if (route.request().postDataJSON()?.data?.description === marker) {
                    heldCount++;
                    await released;
                }
                await route.continue();
            });

            await recordCharacterEdited(page);
            await page.evaluate(async ({ avatar, marker }) => {
                const { saveCharacterField } = await import('./script.js');
                // @ts-ignore
                window.__heldSave = saveCharacterField(avatar, '#description_textarea', marker);
            }, { avatar: avatarA, marker });
            await expect.poll(() => heldCount).toBe(1);

            await selectCharacter(page, avatarB);
            release();

            // @ts-ignore
            const saved = await page.evaluate(() => window.__heldSave);
            expect(saved).toBe(true);

            const edited = (await recordedCharacterEdited(page)).filter(event => event.avatar === avatarA);
            expect(edited).toHaveLength(1);
            expect(edited[0].id).toBe('undefined');
        } finally {
            await page.unrouteAll({ behavior: 'ignoreErrors' });
            await deleteCharacters(page, [avatarA, avatarB]);
        }
    });
});
