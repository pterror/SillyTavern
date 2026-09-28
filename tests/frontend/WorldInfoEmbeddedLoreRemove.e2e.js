import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/** The embedded lorebook editor's save debounce (debounce_timeout.relaxed). */
const SAVE_DEBOUNCE_MS = 1000;
/** That debounce plus room for the save itself. */
const PENDING_SAVE_WINDOW_MS = 2500;

/**
 * Creates a character through the API, with an embedded lorebook holding one entry when `comment` is given.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string} [comment] The entry's title/memo.
 * @returns {Promise<string>} The new character's avatar filename.
 */
async function createCharacter(page, name, comment) {
    return page.evaluate(async ({ name, comment }) => {
        const { getRequestHeaders } = await import('./script.js');
        const form = new FormData();
        form.set('ch_name', name);
        if (comment !== undefined) {
            const characterBook = {
                extensions: {},
                entries: [
                    { id: 0, keys: ['embeddedlorekeyword'], secondary_keys: [], comment, content: 'embedded lore content', constant: false, selective: false, insertion_order: 0, enabled: true, position: 'before_char', extensions: {} },
                ],
            };
            form.set('json_data', JSON.stringify({ data: { character_book: characterBook } }));
        }
        const response = await fetch('/api/characters/create', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, { name, comment });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @returns {Promise<any>} The stored card's embedded lorebook, or undefined.
 */
async function storedCharacterBook(page, avatar) {
    return page.evaluate(async (avatarUrl) => {
        const { getRequestHeaders } = await import('./script.js');
        const response = await fetch('/api/characters/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar_url: avatarUrl }) });
        const character = await response.json();
        return character?.data?.character_book;
    }, avatar);
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
 * Clicks the World Info editor's delete button and confirms.
 * @param {import('@playwright/test').Page} page
 * @param {string} characterName The name the confirmation must name.
 */
async function removeAndConfirm(page, characterName) {
    await page.locator('#world_popup_delete').click();
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toContainText(`Remove the embedded lorebook from ${characterName}?`);
    await dialog.locator('.popup-button-ok').click();
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
 * Types into the first entry's title, then clicks the delete button and confirms, all inside the page so the
 * edit's debounced save is still waiting when the removal starts.
 * @param {import('@playwright/test').Page} page
 * @param {string} text
 * @param {string} characterName The name the confirmation must name.
 * @returns {Promise<number>} Milliseconds from the edit to the confirmation.
 */
async function editThenRemoveAndConfirm(page, text, characterName) {
    return page.evaluate(async ({ text, characterName }) => {
        const started = performance.now();
        const comment = /** @type {HTMLTextAreaElement} */ (document.querySelector('#world_popup_entries_list textarea[name="comment"]'));
        comment.value = text;
        comment.dispatchEvent(new Event('input', { bubbles: true }));
        /** @type {HTMLElement} */ (document.querySelector('#world_popup_delete')).click();
        let ok;
        while (!(ok = /** @type {HTMLElement} */ (document.querySelector('dialog[open] .popup-button-ok')))) {
            if (performance.now() - started > 5000) throw new Error('no confirmation dialog');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        const dialogText = document.querySelector('dialog[open]')?.textContent ?? '';
        if (!dialogText.includes(`Remove the embedded lorebook from ${characterName}?`)) {
            throw new Error(`the confirmation does not name ${characterName}: ${dialogText}`);
        }
        ok.click();
        return performance.now() - started;
    }, { text, characterName });
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

test.describe('removing an embedded lorebook acts on the card it belongs to', () => {
    test.beforeEach(testSetup.awaitST);

    test('removing it after the character panel moved to another character removes it from the first character\'s card', async ({ page }) => {
        const stamp = Date.now();
        const nameA = `EmbeddedLoreRemoveA-${stamp}`;
        const avatarA = await createCharacter(page, nameA, 'A original');
        const avatarB = await createCharacter(page, `EmbeddedLoreRemoveB-${stamp}`);
        try {
            await openCharacterManagementDrawer(page);
            await switchCharacterPanel(page, avatarA);
            await openEmbeddedLoreEditor(page, avatarA);
            const comment = page.locator('#world_popup_entries_list textarea[name="comment"]');
            await expect(comment).toHaveValue('A original');

            await switchCharacterPanel(page, avatarB);
            await page.locator('#WIDrawerIcon').click();
            await expect(page.locator('#WorldInfo')).toBeVisible();
            await expect(comment).toHaveValue('A original');

            await removeAndConfirm(page, nameA);

            await expect.poll(() => storedCharacterBook(page, avatarA), { timeout: 10000 }).toBeUndefined();
            await expect(page.locator('#world_popup_entries_list')).toBeHidden();
            expect(await storedCharacterBook(page, avatarB)).toBeUndefined();
            await expect(page.locator('#character_book_json')).toHaveValue('');
        } finally {
            await deleteCharacters(page, [avatarA, avatarB]);
        }
    });

    test('an edit still waiting to be saved is not sent after the embedded lorebook is removed', async ({ page }) => {
        const stamp = Date.now();
        const name = `EmbeddedLoreRemovePending-${stamp}`;
        const avatar = await createCharacter(page, name, 'original');
        try {
            await openCharacterManagementDrawer(page);
            await switchCharacterPanel(page, avatar);
            await openEmbeddedLoreEditor(page, avatar);
            const comment = page.locator('#world_popup_entries_list textarea[name="comment"]');
            await expect(comment).toHaveValue('original');

            const mergeBodies = recordMergeRequests(page);
            const elapsed = await editThenRemoveAndConfirm(page, 'edited just before removing', name);
            expect(elapsed).toBeLessThan(SAVE_DEBOUNCE_MS);

            await expect.poll(() => storedCharacterBook(page, avatar), { timeout: 10000 }).toBeUndefined();
            // Nothing observable marks the cancelled debounce; wait out the window it would have fired in.
            // eslint-disable-next-line playwright/no-wait-for-timeout
            await page.waitForTimeout(PENDING_SAVE_WINDOW_MS);
            // The edit would either put the lorebook back or, with its pre-removal baseline, raise a conflict.
            expect(mergeBodies.map(body => body.data?.character_book === '__@@UNSET@@__' ? 'removal' : 'edit')).toEqual(['removal']);
            expect(await storedCharacterBook(page, avatar)).toBeUndefined();
            await expect(page.locator('dialog[open]')).toHaveCount(0);
        } finally {
            await deleteCharacters(page, [avatar]);
        }
    });

    test('a removal that fails says so, leaves the editor open, and still saves an edit that was waiting', async ({ page }) => {
        const stamp = Date.now();
        const name = `EmbeddedLoreRemoveFails-${stamp}`;
        const avatar = await createCharacter(page, name, 'original');
        try {
            await openCharacterManagementDrawer(page);
            await switchCharacterPanel(page, avatar);
            await openEmbeddedLoreEditor(page, avatar);
            const comment = page.locator('#world_popup_entries_list textarea[name="comment"]');
            await expect(comment).toHaveValue('original');

            await page.route('**/api/characters/merge-attributes', async (route) => {
                if (route.request().postDataJSON()?.data?.character_book === '__@@UNSET@@__') {
                    await route.fulfill({ status: 500, body: 'refused by the test' });
                    return;
                }
                await route.continue();
            });

            const elapsed = await editThenRemoveAndConfirm(page, 'kept edit', name);
            expect(elapsed).toBeLessThan(SAVE_DEBOUNCE_MS);

            await expect(page.locator('#toast-container .toast-error', { hasText: `The embedded lorebook of ${name} was not removed.` })).toBeVisible();
            await expect(comment).toBeVisible();
            await expect(comment).toHaveValue('kept edit');
            await expect.poll(async () => (await storedCharacterBook(page, avatar))?.entries?.map(entry => entry.comment), { timeout: 10000 })
                .toEqual(['kept edit']);
        } finally {
            await page.unrouteAll({ behavior: 'ignoreErrors' });
            await deleteCharacters(page, [avatar]);
        }
    });
});
