import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// A create or import that overwrites a book waits for the old book's deletion before it writes the new one, so the
// deletion can never land after the write and remove the new book. The links to the name (the open character's
// primary lorebook, the global selection, the persona's lorebook) stay while a book has that name after the write;
// if none does, they are removed and a warning lists each one.

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string} world
 * @returns {Promise<string>} The avatar filename.
 */
async function createCharacter(page, name, world) {
    return page.evaluate(async ({ name, world }) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', 'Hello');
        form.set('world', world);
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, { name, world });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function deleteCharacter(page, avatar) {
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        await fetch('/api/characters/delete', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, delete_chats: true }) });
    }, avatar);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @returns {Promise<string>} The stored card's primary lorebook, once the open character's pending field saves land.
 */
async function storedWorld(page, avatar) {
    return page.evaluate(async (avatar) => {
        const { flushCharacterFieldSaves } = await import('/script.js');
        await flushCharacterFieldSaves();
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        const response = await fetch('/api/characters/get', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar }) });
        const card = await response.json();
        return String(card?.data?.extensions?.world ?? '');
    }, avatar);
}

/**
 * Creates a book with one entry, so the overwrite (which writes an empty book) can be told apart from it.
 * @param {import('@playwright/test').Page} page
 * @param {string} worldName
 */
async function createWorldWithEntry(page, worldName) {
    await page.evaluate(async (worldName) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        const data = { entries: { 0: { uid: 0, key: ['old'], content: 'old book' } } };
        const response = await fetch('/api/worldinfo/edit', { method: 'POST', headers, body: JSON.stringify({ name: worldName, data }) });
        if (!response.ok) throw new Error(`world create failed: ${response.status}`);
        const { updateWorldInfoList } = await import('./scripts/world-info.js');
        await updateWorldInfoList();
    }, worldName);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} worldName
 */
async function deleteWorld(page, worldName) {
    await page.evaluate(async (worldName) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        await fetch('/api/worldinfo/delete', { method: 'POST', headers, body: JSON.stringify({ name: worldName }) });
    }, worldName);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} worldName
 * @returns {Promise<object|null>} The book as the server has it, or null if it has none by that name.
 */
async function serverWorld(page, worldName) {
    return page.evaluate(async (worldName) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        const list = await (await fetch('/api/settings/get', { method: 'POST', headers, body: '{}' })).json();
        if (!list.world_names?.includes(worldName)) return null;
        const response = await fetch('/api/worldinfo/get', { method: 'POST', headers, body: JSON.stringify({ name: worldName }) });
        return response.json();
    }, worldName);
}

/**
 * Overwrites an existing book through createNewWorldInfo() or importWorldInfo(), confirming the overwrite prompt.
 * @param {import('@playwright/test').Page} page
 * @param {'create'|'import'} how
 * @param {string} worldName
 * @returns {Promise<unknown>} What the create or import returned.
 */
async function overwriteWorld(page, how, worldName) {
    return page.evaluate(async ({ how, worldName }) => {
        const { createNewWorldInfo, importWorldInfo } = await import('./scripts/world-info.js');
        const { Popup, POPUP_RESULT } = await import('./scripts/popup.js');
        const originalConfirm = Popup.show.confirm;
        Popup.show.confirm = async () => POPUP_RESULT.AFFIRMATIVE;
        try {
            if (how === 'create') {
                return await createNewWorldInfo(worldName, { interactive: true });
            }
            const file = new File([JSON.stringify({ entries: {} })], `${worldName}.json`, { type: 'application/json' });
            return await importWorldInfo(file, { interactive: true });
        } finally {
            Popup.show.confirm = originalConfirm;
        }
    }, { how, worldName });
}

/**
 * Opens the character in the editor and adds `worldName` to the global lorebook selection.
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @param {string} worldName
 */
async function linkOpenCharacterAndGlobal(page, avatar, worldName) {
    await openCharacterManagementDrawer(page);
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        await SillyTavern.getContext().getCharacters();
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
    await expect(page.locator('#character_world')).toHaveValue(worldName);
    await page.evaluate(async (worldName) => {
        const { selected_world_info } = await import('./scripts/world-info.js');
        selected_world_info.push(worldName);
    }, worldName);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} worldName
 * @returns {Promise<boolean>}
 */
async function globallySelected(page, worldName) {
    return page.evaluate(async (worldName) => {
        const { selected_world_info } = await import('./scripts/world-info.js');
        return selected_world_info.includes(worldName);
    }, worldName);
}

const WRITE_PATH = { create: '/api/worldinfo/edit', import: '/api/worldinfo/import' };

const removedToast = (page, worldName) => page.locator('#toast-container .toast-warning .toast-message', { hasText: `Overwritten lorebook ${worldName} no longer exists` });

test.describe('overwriting a lorebook', () => {
    test.beforeEach(testSetup.awaitST);

    for (const how of /** @type {const} */ (['create', 'import'])) {
        test(`${how}: writes the new book only after the old one's deletion is done, and keeps every link`, async ({ page }) => {
            const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const worldName = `WI_OVERWRITE_SEQ_${how.toUpperCase()}_${s}`;

            await createWorldWithEntry(page, worldName);
            const avatar = await createCharacter(page, `WIOverwriteSeq-${s}`, worldName);
            try {
                await linkOpenCharacterAndGlobal(page, avatar, worldName);

                /** @type {string[]} */
                const events = [];
                // The deletion's response is held back, so a write sent without waiting for it would be seen first.
                await page.route('**/api/worldinfo/delete', async (route) => {
                    events.push('delete sent');
                    const response = await route.fetch();
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    events.push('delete done');
                    await route.fulfill({ response });
                });
                page.on('request', (request) => {
                    if (new URL(request.url()).pathname === WRITE_PATH[how]) events.push('write sent');
                });
                try {
                    expect(await overwriteWorld(page, how, worldName)).toBeTruthy();
                } finally {
                    await page.unroute('**/api/worldinfo/delete');
                }

                expect(events).toEqual(['delete sent', 'delete done', 'write sent']);

                // The new, empty book is what the server has.
                const book = await serverWorld(page, worldName);
                expect(book).not.toBeNull();
                expect(Object.keys(book.entries ?? {})).toEqual([]);

                // Nothing was unlinked.
                await expect(page.locator('#character_world')).toHaveValue(worldName);
                expect(await globallySelected(page, worldName)).toBe(true);
                expect(await storedWorld(page, avatar)).toBe(worldName);
                await expect(removedToast(page, worldName)).toHaveCount(0);
            } finally {
                await deleteWorld(page, worldName);
                await deleteCharacter(page, avatar);
            }
        });

        test(`${how}: writes nothing if the deletion request fails outright`, async ({ page }) => {
            const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const worldName = `WI_OVERWRITE_ABORT_${how.toUpperCase()}_${s}`;

            await createWorldWithEntry(page, worldName);
            try {
                let writes = 0;
                page.on('request', (request) => {
                    if (new URL(request.url()).pathname === WRITE_PATH[how]) writes++;
                });
                await page.route('**/api/worldinfo/delete', route => route.abort('failed'));
                try {
                    expect(await overwriteWorld(page, how, worldName)).toBe(false);
                } finally {
                    await page.unroute('**/api/worldinfo/delete');
                }

                expect(writes).toBe(0);
                await expect(page.locator('#toast-container .toast-error .toast-message', { hasText: `Could not delete the existing lorebook ${worldName}, so nothing was written.` })).toHaveCount(1);
                // The deletion never reached the server, so the old book is still there.
                const book = await serverWorld(page, worldName);
                expect(Object.keys(book?.entries ?? {}).length).toBe(1);
            } finally {
                await deleteWorld(page, worldName);
            }
        });
    }

    test('lists every link it removes when no book has the name after the write', async ({ page }) => {
        const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const worldName = `WI_OVERWRITE_GONE_${s}`;
        const characterName = `WIOverwriteGone-${s}`;

        await createWorldWithEntry(page, worldName);
        const avatar = await createCharacter(page, characterName, worldName);
        try {
            await linkOpenCharacterAndGlobal(page, avatar, worldName);

            await page.route('**/api/worldinfo/edit', route => route.fulfill({ status: 500, body: 'synthetic write failure' }));
            try {
                expect(await overwriteWorld(page, 'create', worldName)).toBe(false);
            } finally {
                await page.unroute('**/api/worldinfo/edit');
            }

            expect(await serverWorld(page, worldName)).toBeNull();
            const toast = removedToast(page, worldName);
            await expect(toast).toHaveCount(1);
            const text = await toast.innerText();
            expect(text).toContain('the global lorebook selection');
            expect(text).toContain(`the primary lorebook of ${characterName}`);

            await expect(page.locator('#character_world')).toHaveValue('');
            expect(await globallySelected(page, worldName)).toBe(false);
            expect(await storedWorld(page, avatar)).toBe('');
        } finally {
            await deleteWorld(page, worldName);
            await deleteCharacter(page, avatar);
        }
    });
});
