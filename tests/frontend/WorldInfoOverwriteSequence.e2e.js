import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

const BOOK_WRITE = /\/api\/worldinfo\/(entries\/apply|create)$/;

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string} world
 * @returns {Promise<string>}
 */
async function createCharacter(page, name, world) {
    return page.evaluate(async ({ name, world }) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders({ omitContentType: true });
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
        const headers = stTest.context().getRequestHeaders();
        await fetch('/api/characters/delete', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, delete_chats: true }) });
    }, avatar);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @returns {Promise<string>}
 */
async function storedWorld(page, avatar) {
    return page.evaluate(async (avatar) => {
        const { flushCharacterFieldSaves } = await import('/script.js');
        await flushCharacterFieldSaves();
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders();
        const response = await fetch('/api/characters/get', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar }) });
        const card = await response.json();
        return String(card?.data?.extensions?.world ?? '');
    }, avatar);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} worldName
 */
async function createWorldWithEntry(page, worldName) {
    await page.evaluate(async (worldName) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders();
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
        const headers = stTest.context().getRequestHeaders();
        await fetch('/api/worldinfo/delete', { method: 'POST', headers, body: JSON.stringify({ name: worldName }) });
    }, worldName);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} worldName
 * @returns {Promise<object|null>}
 */
async function serverWorld(page, worldName) {
    return page.evaluate(async (worldName) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders();
        const list = await (await fetch('/api/settings/get', { method: 'POST', headers, body: '{}' })).json();
        if (!list.world_names?.includes(worldName)) return null;
        const response = await fetch('/api/worldinfo/get', { method: 'POST', headers, body: JSON.stringify({ name: worldName }) });
        return response.json();
    }, worldName);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {'create'|'import'} how
 * @param {string} worldName
 * @returns {Promise<unknown>}
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
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @param {string} worldName
 */
async function linkOpenCharacterAndGlobal(page, avatar, worldName) {
    await openCharacterManagementDrawer(page);
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        await stTest.context().getCharacters();
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

const WRITE_PATH = { create: BOOK_WRITE, import: /\/api\/worldinfo\/import$/ };

const removedToast = (page, worldName) => page.locator('#toast-container .toast-warning .toast-message', { hasText: `Overwritten lorebook ${worldName} no longer exists` });

test.describe('overwriting a lorebook', () => {
    test.beforeEach(testSetup.awaitST);

    for (const how of /** @type {const} */ (['create', 'import'])) {
        test(`${how}: writes the new book only after the old one's deletion is done`, async ({ page }) => {
            const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const worldName = `WI_OVERWRITE_SEQ_${how.toUpperCase()}_${s}`;
            const newName = worldName.toLowerCase();

            await createWorldWithEntry(page, worldName);
            try {
                /** @type {string[]} */
                const events = [];
                await page.route('**/api/worldinfo/delete', async (route) => {
                    events.push('delete sent');
                    const response = await route.fetch();
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    events.push('delete done');
                    await route.fulfill({ response });
                });
                page.on('request', (request) => {
                    if (WRITE_PATH[how].test(new URL(request.url()).pathname)) events.push('write sent');
                });
                try {
                    expect(await overwriteWorld(page, how, newName)).toBeTruthy();
                } finally {
                    await page.unroute('**/api/worldinfo/delete');
                }

                expect(events).toEqual(['delete sent', 'delete done', 'write sent']);

                const book = await serverWorld(page, newName);
                expect(book).not.toBeNull();
                expect(Object.keys(book.entries ?? {})).toEqual([]);
                expect(await serverWorld(page, worldName)).toBeNull();
            } finally {
                await deleteWorld(page, worldName);
                await deleteWorld(page, newName);
            }
        });

        test(`${how}: writes nothing if the deletion request fails outright`, async ({ page }) => {
            const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const worldName = `WI_OVERWRITE_ABORT_${how.toUpperCase()}_${s}`;

            await createWorldWithEntry(page, worldName);
            try {
                let writes = 0;
                page.on('request', (request) => {
                    if (WRITE_PATH[how].test(new URL(request.url()).pathname)) writes++;
                });
                await page.route('**/api/worldinfo/delete', route => route.abort('failed'));
                try {
                    expect(await overwriteWorld(page, how, worldName.toLowerCase())).toBe(false);
                } finally {
                    await page.unroute('**/api/worldinfo/delete');
                }

                expect(writes).toBe(0);
                await expect(page.locator('#toast-container .toast-error .toast-message', { hasText: `Could not delete the existing lorebook ${worldName}, so nothing was written.` })).toHaveCount(1);
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

            await page.route(BOOK_WRITE, route => route.fulfill({ status: 500, body: 'synthetic write failure' }));
            try {
                expect(await overwriteWorld(page, 'create', worldName.toLowerCase())).toBe(false);
            } finally {
                await page.unroute(BOOK_WRITE);
            }

            expect(await serverWorld(page, worldName)).toBeNull();
            expect(await serverWorld(page, worldName.toLowerCase())).toBeNull();
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
