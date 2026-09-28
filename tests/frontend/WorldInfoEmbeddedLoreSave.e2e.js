import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * Creates a character through the API with an embedded lorebook holding one entry.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string} comment The entry's title/memo.
 * @returns {Promise<string>} The new character's avatar filename.
 */
async function createCharacterWithEmbeddedLorebook(page, name, comment) {
    return page.evaluate(async ({ name, comment }) => {
        const { getRequestHeaders } = await import('./script.js');
        const characterBook = {
            extensions: {},
            entries: [
                { id: 0, keys: ['embeddedlorekeyword'], secondary_keys: [], comment, content: 'embedded lore content', constant: false, selective: false, insertion_order: 0, enabled: true, position: 'before_char', extensions: {} },
            ],
        };
        const form = new FormData();
        form.set('ch_name', name);
        form.set('json_data', JSON.stringify({ data: { character_book: characterBook } }));
        const response = await fetch('/api/characters/create', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, { name, comment });
}

/**
 * Creates a character through the API with no embedded lorebook.
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
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @returns {Promise<any>} The character card as stored on the server.
 */
async function fetchStoredCharacter(page, avatar) {
    return page.evaluate(async (avatarUrl) => {
        const { getRequestHeaders } = await import('./script.js');
        const response = await fetch('/api/characters/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar_url: avatarUrl }) });
        return response.json();
    }, avatar);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @returns {Promise<string[]>} The titles of the entries in the stored card's embedded lorebook.
 */
async function storedEntryComments(page, avatar) {
    const stored = await fetchStoredCharacter(page, avatar);
    return (stored?.data?.character_book?.entries ?? []).map(entry => entry.comment);
}

/**
 * Collects the JSON body of every /api/characters/merge-attributes request from here on.
 * @param {import('@playwright/test').Page} page
 * @returns {any[]}
 */
function recordMergeRequests(page) {
    const bodies = [];
    page.on('request', (request) => {
        if (request.method() === 'POST' && request.url().endsWith('/api/characters/merge-attributes')) {
            bodies.push(request.postDataJSON());
        }
    });
    return bodies;
}

/**
 * Loads the character into the character panel. That closes the World Info drawer if it is open; this waits
 * until it has finished closing.
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function switchCharacterPanel(page, avatar) {
    await page.evaluate(async (avatar) => {
        const { selectCharacterByAvatar } = await import('./script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar);
    await expect(page.locator('#WorldInfo')).toBeHidden();
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function openEmbeddedLoreEditor(page, avatar) {
    await page.evaluate(async (avatar) => {
        const { openEmbeddedLoreEditor } = await import('./scripts/world-info.js');
        await openEmbeddedLoreEditor(avatar);
    }, avatar);
    await expect(page.locator('#WorldInfo')).toBeVisible();
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

test.describe('embedded lorebook edits are saved into the card they were made on', () => {
    test.beforeEach(testSetup.awaitST);

    test('an edit made after the character panel moved to another character goes into the first character\'s card', async ({ page }) => {
        const stamp = Date.now();
        const avatarA = await createCharacterWithEmbeddedLorebook(page, `EmbeddedLoreOwnerA-${stamp}`, 'A original');
        const avatarB = await createCharacter(page, `EmbeddedLoreOwnerB-${stamp}`);
        try {
            await openCharacterManagementDrawer(page);
            await switchCharacterPanel(page, avatarA);
            await openEmbeddedLoreEditor(page, avatarA);
            const comment = page.locator('#world_popup_entries_list textarea[name="comment"]');
            await expect(comment).toHaveValue('A original');

            await switchCharacterPanel(page, avatarB);
            // Reopening the drawer shows the editor as it was left: still A's embedded lorebook.
            await page.locator('#WIDrawerIcon').click();
            await expect(page.locator('#WorldInfo')).toBeVisible();
            await expect(comment).toHaveValue('A original');

            const mergeBodies = recordMergeRequests(page);
            await comment.fill('A edited after the panel moved');

            await expect.poll(() => storedEntryComments(page, avatarA), { timeout: 10000 }).toEqual(['A edited after the panel moved']);
            expect(mergeBodies.map(body => body.avatar)).toEqual([avatarA]);
            expect(mergeBodies[0]._loadedFieldHashes).toEqual({ 'data.character_book': expect.any(Number) });

            // B's card and B's form are left alone.
            expect(await storedEntryComments(page, avatarB)).toEqual([]);
            await expect(page.locator('#character_book_json')).toHaveValue('');
        } finally {
            await deleteCharacters(page, [avatarA, avatarB]);
        }
    });

    test('edits to two characters\' embedded lorebooks made one right after the other each go into their own card', async ({ page }) => {
        const stamp = Date.now();
        const avatarA = await createCharacterWithEmbeddedLorebook(page, `EmbeddedLoreTwoA-${stamp}`, 'A original');
        const avatarB = await createCharacterWithEmbeddedLorebook(page, `EmbeddedLoreTwoB-${stamp}`, 'B original');
        try {
            const comment = page.locator('#world_popup_entries_list textarea[name="comment"]');

            await openCharacterManagementDrawer(page);
            await switchCharacterPanel(page, avatarA);
            await openEmbeddedLoreEditor(page, avatarA);
            await expect(comment).toHaveValue('A original');
            await comment.fill('A edit');

            await switchCharacterPanel(page, avatarB);
            await openEmbeddedLoreEditor(page, avatarB);
            await expect(comment).toHaveValue('B original');
            await comment.fill('B edit');

            await expect.poll(async () => [await storedEntryComments(page, avatarA), await storedEntryComments(page, avatarB)], { timeout: 10000 })
                .toEqual([['A edit'], ['B edit']]);
        } finally {
            await deleteCharacters(page, [avatarA, avatarB]);
        }
    });

    test('a conflict on an embedded lorebook edit made after the panel moved names the character the lorebook belongs to', async ({ page }) => {
        const stamp = Date.now();
        const nameA = `EmbeddedLoreConflictA-${stamp}`;
        const nameB = `EmbeddedLoreConflictB-${stamp}`;
        const avatarA = await createCharacterWithEmbeddedLorebook(page, nameA, 'A original');
        const avatarB = await createCharacter(page, nameB);
        try {
            const comment = page.locator('#world_popup_entries_list textarea[name="comment"]');
            await openCharacterManagementDrawer(page);
            await switchCharacterPanel(page, avatarA);
            await openEmbeddedLoreEditor(page, avatarA);
            await expect(comment).toHaveValue('A original');

            await switchCharacterPanel(page, avatarB);
            await page.locator('#WIDrawerIcon').click();
            await expect(page.locator('#WorldInfo')).toBeVisible();
            await expect(comment).toHaveValue('A original');

            // Another session changes A's lorebook, so this session's edit meets a conflict.
            await page.evaluate(async (avatar) => {
                const { getRequestHeaders } = await import('./script.js');
                const stored = await (await fetch('/api/characters/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }) })).json();
                const characterBook = stored.data.character_book;
                characterBook.entries[0].comment = 'A edited elsewhere';
                const response = await fetch('/api/characters/merge-attributes', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar, data: { character_book: characterBook } }) });
                if (!response.ok) throw new Error(`merge failed: ${response.status}`);
            }, avatarA);

            await comment.fill('A edited here');

            const popup = page.locator('dialog.popup[open]', { hasText: 'Character edited in another session' });
            await expect(popup).toBeVisible({ timeout: 10000 });
            await expect(popup.locator('.popup-content')).toContainText(`The following fields of ${nameA} were changed by another session:`);
            await expect(popup.locator('.popup-content')).not.toContainText(nameB);

            await popup.locator('.popup-button-ok').click();
            await expect.poll(() => storedEntryComments(page, avatarA), { timeout: 10000 }).toEqual(['A edited here']);
        } finally {
            await deleteCharacters(page, [avatarA, avatarB]);
        }
    });

    test('embedded lorebook edits that belong to no character are reported as not saved', async ({ page }) => {
        const mergeBodies = recordMergeRequests(page);
        await page.evaluate(async () => {
            const { saveWorldInfo, EMBEDDED_WORLD_NAME } = await import('./scripts/world-info.js');
            await saveWorldInfo(EMBEDDED_WORLD_NAME, { entries: {} }, true);
        });

        await expect(page.locator('#toast-container .toast-error', { hasText: 'not saved' })).toBeVisible();
        expect(mergeBodies).toEqual([]);
    });
});
