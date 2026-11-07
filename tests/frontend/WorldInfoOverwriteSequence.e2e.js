import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

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
        const response = await fetch('/api/worldinfo/create', { method: 'POST', headers, body: JSON.stringify({ name: worldName, data, unique: false, replace: true }) });
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
        const { saveSettings } = await import('./script.js');
        selected_world_info.push(worldName);
        await saveSettings('world_info_settings');
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

const WRITE_PATH = { create: /\/api\/worldinfo\/create$/, import: /\/api\/worldinfo\/import$/ };

test.describe('overwriting a lorebook', () => {
    test.beforeEach(testSetup.awaitST);

    for (const how of /** @type {const} */ (['create', 'import'])) {
        test(`${how}: under a name of another case replaces the same book in one request, and its links follow the new name`, async ({ page }) => {
            const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const worldName = `WI_OVERWRITE_${how.toUpperCase()}_${s}`;
            const newName = worldName.toLowerCase();
            const characterName = `WIOverwrite-${how}-${s}`;

            await createWorldWithEntry(page, worldName);
            const avatar = await createCharacter(page, characterName, worldName);
            try {
                await linkOpenCharacterAndGlobal(page, avatar, worldName);
                /** @type {string[]} */
                const requests = [];
                page.on('request', (request) => {
                    const pathname = new URL(request.url()).pathname;
                    if (pathname === '/api/worldinfo/delete') requests.push('delete');
                    else if (WRITE_PATH[how].test(pathname)) requests.push('write');
                });

                expect(await overwriteWorld(page, how, newName)).toBeTruthy();

                expect(requests).toEqual(['write']);
                const book = await serverWorld(page, newName);
                expect(Object.keys(book?.entries ?? {})).toEqual([]);
                expect(await serverWorld(page, worldName)).toBeNull();
                expect(await storedWorld(page, avatar)).toBe(newName);
                await expect(page.locator('#character_world')).toHaveValue(newName);
                expect(await globallySelected(page, newName)).toBe(true);
                expect(await globallySelected(page, worldName)).toBe(false);
            } finally {
                await deleteWorld(page, newName);
                await deleteWorld(page, worldName);
                await deleteCharacter(page, avatar);
            }
        });

        test(`${how}: a write the server refuses leaves the book as it was, still linked`, async ({ page }) => {
            const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const worldName = `WI_OVERWRITE_REFUSED_${how.toUpperCase()}_${s}`;
            const avatar = await createCharacter(page, `WIOverwriteRefused-${how}-${s}`, worldName);

            await createWorldWithEntry(page, worldName);
            try {
                await page.route(WRITE_PATH[how], route => route.fulfill({ status: 500, body: 'synthetic write failure' }));
                try {
                    expect(await overwriteWorld(page, how, worldName.toLowerCase())).toBeFalsy();
                } finally {
                    await page.unroute(WRITE_PATH[how]);
                }

                const book = await serverWorld(page, worldName);
                expect(Object.keys(book?.entries ?? {}).length).toBe(1);
                expect(await serverWorld(page, worldName.toLowerCase())).toBeNull();
                expect(await storedWorld(page, avatar)).toBe(worldName);
            } finally {
                await deleteWorld(page, worldName);
                await deleteCharacter(page, avatar);
            }
        });
    }
});
