import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// A create or import that overwrites a book under exactly its name writes over the book's own file without deleting
// it first, so a write that fails leaves the old book as it was. The book's cached copy follows the file: the new book
// after a write, the old one after a failed write. Every link to the name stays either way. As for an overwrite that
// deletes, a save of the book pending when the overwrite starts is written before the new book (so a failed write
// keeps it), and one made while that save is in flight is dropped with a warning, so no older save lands after it.
// (An overwrite under a name differing in case deletes first: WorldInfoOverwriteSequence.e2e.js.)

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
 * Creates a book with one entry, so the overwrite (which writes an empty book) can be told apart from it, and loads
 * it into the page's cache.
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
        const { updateWorldInfoList, loadWorldInfo } = await import('./scripts/world-info.js');
        await updateWorldInfoList();
        const cached = await loadWorldInfo(worldName);
        if (Object.keys(cached?.entries ?? {}).length !== 1) throw new Error('world not cached');
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
 * @returns {Promise<string[]|null>} The entries' contents as the server has them, or null if it has no book by that name.
 */
async function serverEntries(page, worldName) {
    return page.evaluate(async (worldName) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        const list = await (await fetch('/api/settings/get', { method: 'POST', headers, body: '{}' })).json();
        if (!list.world_names?.includes(worldName)) return null;
        const response = await fetch('/api/worldinfo/get', { method: 'POST', headers, body: JSON.stringify({ name: worldName }) });
        const book = await response.json();
        return Object.values(book.entries ?? {}).map(entry => entry.content);
    }, worldName);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} worldName
 * @returns {Promise<string[]>} The entries' contents as loadWorldInfo() hands them out.
 */
async function loadedEntries(page, worldName) {
    return page.evaluate(async (worldName) => {
        const { loadWorldInfo } = await import('./scripts/world-info.js');
        const book = await loadWorldInfo(worldName);
        return Object.values(book?.entries ?? {}).map(entry => entry.content);
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

/** How long the tests wait after the overwrite: longer than debounce_timeout.relaxed, so a stray save would fire. */
const AFTER_DEBOUNCE_MS = 2000;

/**
 * Schedules a debounced whole-book save of the old book with an edited entry.
 * @param {import('@playwright/test').Page} page
 * @param {string} worldName
 */
async function saveOldBookDebounced(page, worldName) {
    await page.evaluate(async (worldName) => {
        const { saveWorldInfo } = await import('./scripts/world-info.js');
        const data = { entries: { 0: { uid: 0, key: ['old'], content: 'old book, edited' } } };
        await saveWorldInfo(worldName, data, false);
    }, worldName);
}

/**
 * Records, in order, the book's saves, any deletion and the new book's write.
 * @param {import('@playwright/test').Page} page
 * @param {'create'|'import'} how
 * @param {string} worldName
 * @returns {string[]}
 */
function recordRequests(page, how, worldName) {
    /** @type {string[]} */
    const events = [];
    page.on('request', (request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname === '/api/worldinfo/delete') {
            events.push('delete sent');
        } else if (pathname === '/api/worldinfo/import') {
            events.push('new book sent');
        } else if (pathname === '/api/worldinfo/edit') {
            const body = JSON.parse(request.postData() ?? '{}');
            if (body.name !== worldName) return;
            const isOld = Object.keys(body.data?.entries ?? {}).length > 0;
            events.push(isOld ? 'old save sent' : (how === 'create' ? 'new book sent' : 'empty save sent'));
        }
    });
    return events;
}

const droppedToast = (page, worldName) => page.locator('#toast-container .toast-warning .toast-message', { hasText: `Changes to lorebook ${worldName} made while it was being overwritten were not saved.` });

/**
 * Asserts every link to the name is still there and no link-removed warning showed.
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @param {string} worldName
 */
async function expectLinksKept(page, avatar, worldName) {
    await expect(page.locator('#character_world')).toHaveValue(worldName);
    expect(await globallySelected(page, worldName)).toBe(true);
    expect(await storedWorld(page, avatar)).toBe(worldName);
    await expect(page.locator('#toast-container .toast-warning .toast-message', { hasText: `Overwritten lorebook ${worldName} no longer exists` })).toHaveCount(0);
}

const WRITE_PATH = { create: '/api/worldinfo/edit', import: '/api/worldinfo/import' };

test.describe('overwriting a lorebook under exactly its name', () => {
    test.beforeEach(testSetup.awaitST);

    for (const how of /** @type {const} */ (['create', 'import'])) {
        test(`${how}: writes over the book without deleting it, and keeps every link`, async ({ page }) => {
            const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const worldName = `WI_OVERWRITE_SAME_${how.toUpperCase()}_${s}`;

            await createWorldWithEntry(page, worldName);
            const avatar = await createCharacter(page, `WIOverwriteSame-${s}`, worldName);
            try {
                await linkOpenCharacterAndGlobal(page, avatar, worldName);

                let deletes = 0;
                page.on('request', (request) => {
                    if (new URL(request.url()).pathname === '/api/worldinfo/delete') deletes++;
                });
                expect(await overwriteWorld(page, how, worldName)).toBeTruthy();
                expect(deletes).toBe(0);

                // The new, empty book is what the server has and what the page hands out.
                expect(await serverEntries(page, worldName)).toEqual([]);
                expect(await loadedEntries(page, worldName)).toEqual([]);

                await expectLinksKept(page, avatar, worldName);
            } finally {
                await deleteWorld(page, worldName);
                await deleteCharacter(page, avatar);
            }
        });

        test(`${how}: a write that fails leaves the old book, and keeps every link`, async ({ page }) => {
            const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const worldName = `WI_OVERWRITE_SAME_FAIL_${how.toUpperCase()}_${s}`;

            await createWorldWithEntry(page, worldName);
            const avatar = await createCharacter(page, `WIOverwriteSameFail-${s}`, worldName);
            try {
                await linkOpenCharacterAndGlobal(page, avatar, worldName);

                let deletes = 0;
                page.on('request', (request) => {
                    if (new URL(request.url()).pathname === '/api/worldinfo/delete') deletes++;
                });
                // A save pending when the overwrite starts is written first, so the failed write doesn't cost it.
                await saveOldBookDebounced(page, worldName);
                await page.route(`**${WRITE_PATH[how]}`, route => {
                    const body = how === 'create' ? JSON.parse(route.request().postData() ?? '{}') : null;
                    if (body && Object.keys(body.data?.entries ?? {}).length > 0) return route.continue();
                    return route.fulfill({ status: 500, body: 'synthetic write failure' });
                });
                try {
                    expect(await overwriteWorld(page, how, worldName)).toBeFalsy();
                } finally {
                    await page.unroute(`**${WRITE_PATH[how]}`);
                }
                expect(deletes).toBe(0);

                // The old book, with its pending edit, is what the server has and what the page hands out, not the new
                // book that wasn't written.
                expect(await serverEntries(page, worldName)).toEqual(['old book, edited']);
                expect(await loadedEntries(page, worldName)).toEqual(['old book, edited']);
                await expect(droppedToast(page, worldName)).toHaveCount(0);

                await expectLinksKept(page, avatar, worldName);
            } finally {
                await deleteWorld(page, worldName);
                await deleteCharacter(page, avatar);
            }
        });

        test(`${how}: a save pending before the overwrite is written before the new book, and never after it`, async ({ page }) => {
            const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const worldName = `WI_OVERWRITE_SAME_PENDING_${how.toUpperCase()}_${s}`;

            await createWorldWithEntry(page, worldName);
            try {
                const events = recordRequests(page, how, worldName);
                await saveOldBookDebounced(page, worldName);
                expect(await overwriteWorld(page, how, worldName)).toBeTruthy();
                // eslint-disable-next-line playwright/no-wait-for-timeout
                await page.waitForTimeout(AFTER_DEBOUNCE_MS);

                expect(events).toEqual(['old save sent', 'new book sent']);
                expect(await serverEntries(page, worldName)).toEqual([]);
                expect(await loadedEntries(page, worldName)).toEqual([]);
                await expect(droppedToast(page, worldName)).toHaveCount(0);
            } finally {
                await deleteWorld(page, worldName);
            }
        });

        test(`${how}: a save made while the pending one is in flight is dropped with a warning`, async ({ page }) => {
            const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const worldName = `WI_OVERWRITE_SAME_DURING_${how.toUpperCase()}_${s}`;

            await createWorldWithEntry(page, worldName);
            try {
                const events = recordRequests(page, how, worldName);
                // The pending save's write is held back until the book has been saved again meanwhile.
                let releaseSave = () => {};
                const saveReleased = new Promise(resolve => { releaseSave = () => resolve(undefined); });
                let saveSeen = () => {};
                const saveArrived = new Promise(resolve => { saveSeen = () => resolve(undefined); });
                await page.route('**/api/worldinfo/edit', async (route) => {
                    const body = JSON.parse(route.request().postData() ?? '{}');
                    if (Object.keys(body.data?.entries ?? {}).length > 0) {
                        saveSeen();
                        await saveReleased;
                    }
                    await route.continue();
                });
                try {
                    await saveOldBookDebounced(page, worldName);
                    const overwrite = overwriteWorld(page, how, worldName);
                    await saveArrived;
                    await saveOldBookDebounced(page, worldName);
                    releaseSave();
                    expect(await overwrite).toBeTruthy();
                } finally {
                    releaseSave();
                    await page.unroute('**/api/worldinfo/edit');
                }
                // eslint-disable-next-line playwright/no-wait-for-timeout
                await page.waitForTimeout(AFTER_DEBOUNCE_MS);

                expect(events).toEqual(['old save sent', 'new book sent']);
                expect(await serverEntries(page, worldName)).toEqual([]);
                await expect(droppedToast(page, worldName)).toHaveCount(1);
                // The dropped save's data isn't handed out as the book's.
                expect(await loadedEntries(page, worldName)).toEqual([]);
            } finally {
                await deleteWorld(page, worldName);
            }
        });
    }
});
