import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

const BOOK_WRITE = /\/api\/worldinfo\/(entries\/apply|create)$/;

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string[]} names
 * @param {string} world
 * @returns {Promise<string[]>}
 */
async function createCharacters(page, names, world) {
    return page.evaluate(async ({ names, world }) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders({ omitContentType: true });
        const avatars = [];
        for (const name of names) {
            const form = new FormData();
            form.set('ch_name', name);
            form.set('first_mes', 'Hello');
            form.set('world', world);
            const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
            if (!response.ok) throw new Error(`create failed: ${response.status}`);
            avatars.push(await response.text());
        }
        return avatars;
    }, { names, world });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string[]} avatars
 */
async function deleteCharacters(page, avatars) {
    await page.evaluate(async (avatars) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders();
        for (const avatar of avatars) {
            await fetch('/api/characters/delete', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, delete_chats: true }) });
        }
    }, avatars);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @returns {Promise<string>}
 */
async function storedWorld(page, avatar) {
    return page.evaluate(async (avatar) => {
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
async function createWorld(page, worldName) {
    await page.evaluate(async (worldName) => {
        const { createNewWorldInfo } = await import('./scripts/world-info.js');
        if (!await createNewWorldInfo(worldName, { interactive: false })) {
            throw new Error(`Failed to create world info '${worldName}'`);
        }
    }, worldName);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} worldName
 * @returns {Promise<boolean>}
 */
async function deleteWorld(page, worldName) {
    return page.evaluate(async (worldName) => {
        const { deleteWorldInfo, world_names } = await import('./scripts/world-info.js');
        if (!world_names.includes(worldName)) {
            return false;
        }
        return deleteWorldInfo(worldName);
    }, worldName);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {'create'|'import'} how
 * @param {string} worldName
 */
async function overwriteWorld(page, how, worldName) {
    await page.evaluate(async ({ how, worldName }) => {
        const { createNewWorldInfo, importWorldInfo } = await import('./scripts/world-info.js');
        const { Popup, POPUP_RESULT } = await import('./scripts/popup.js');
        const originalConfirm = Popup.show.confirm;
        Popup.show.confirm = async () => POPUP_RESULT.AFFIRMATIVE;
        try {
            if (how === 'create') {
                await createNewWorldInfo(worldName, { interactive: true });
            } else {
                const file = new File([JSON.stringify({ entries: {} })], `${worldName}.json`, { type: 'application/json' });
                await importWorldInfo(file, { interactive: true });
            }
        } finally {
            Popup.show.confirm = originalConfirm;
        }
    }, { how, worldName });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} worldName
 * @returns {Promise<boolean>}
 */
async function worldExists(page, worldName) {
    return page.evaluate(async (worldName) => {
        const worldInfo = await import('./scripts/world-info.js');
        await worldInfo.updateWorldInfoList();
        return worldInfo.world_names.includes(worldName);
    }, worldName);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} worldName
 * @returns {object[]}
 */
function recordStillLinkedQueries(page, worldName) {
    const bodies = [];
    page.on('request', (request) => {
        if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/characters/query') return;
        let body;
        try { body = request.postDataJSON(); } catch { return; }
        if (body?.filter?.world === worldName) bodies.push(body);
    });
    return bodies;
}

const QUIET_MS = 2500;

const anyWarning = (page) => page.locator('#toast-container .toast-warning .toast-message');

test.describe('deleting a lorebook characters link to', () => {
    test.beforeEach(testSetup.awaitST);

    test('unlinks it from every character, the open one included, and warns of nothing', async ({ page }) => {
        const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const worldName = `WI_DELETE_LINKED_${s}`;
        const names = Array.from({ length: 22 }, (_, i) => `WIDeleteLinked-${s}-${String(i).padStart(2, '0')}`);

        await createWorld(page, worldName);
        const avatars = await createCharacters(page, names, worldName);
        try {
            await openCharacterManagementDrawer(page);
            await page.evaluate(async (avatar) => {
                // @ts-ignore
                await stTest.context().getCharacters();
                const { selectCharacterByAvatar } = await import('/script.js');
                await selectCharacterByAvatar(avatar);
            }, avatars[0]);
            await expect(page.locator('#avatar_url_pole')).toHaveValue(avatars[0], { timeout: 10000 });
            await expect(page.locator('#character_world')).toHaveValue(worldName);
            const lookups = recordStillLinkedQueries(page, worldName);

            expect(await deleteWorld(page, worldName)).toBe(true);

            await expect(page.locator('#character_world')).toHaveValue('');
            await expect(page.locator('#set_character_world')).not.toHaveClass(/world_set/);
            for (const avatar of [avatars[0], avatars[1], avatars[21]]) {
                expect(await storedWorld(page, avatar)).toBe('');
            }
            expect(lookups).toEqual([]);
            await expect(anyWarning(page)).toHaveCount(0);
        } finally {
            await deleteWorld(page, worldName);
            await deleteCharacters(page, avatars);
        }
    });

    for (const how of /** @type {const} */ (['create', 'import'])) {
        test(`shows no warning when ${how === 'create' ? 'a create' : 'an import'} overwrites the book under the same name`, async ({ page }) => {
            const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const worldName = `WI_OVERWRITE_${how.toUpperCase()}_${s}`;
            const names = [`WIOverwrite-${s}-00`, `WIOverwrite-${s}-01`];

            await createWorld(page, worldName);
            const avatars = await createCharacters(page, names, worldName);
            try {
                const lookups = recordStillLinkedQueries(page, worldName);
                let deletes = 0;
                page.on('request', (request) => {
                    if (new URL(request.url()).pathname === '/api/worldinfo/delete') deletes++;
                });
                await overwriteWorld(page, how, worldName);
                await page.waitForTimeout(QUIET_MS);

                expect(deletes).toBe(0);
                expect(await worldExists(page, worldName)).toBe(true);
                expect(lookups).toEqual([]);
                await expect(anyWarning(page)).toHaveCount(0);
                expect(await storedWorld(page, avatars[0])).toBe(worldName);
                expect(await storedWorld(page, avatars[1])).toBe(worldName);
            } finally {
                await deleteWorld(page, worldName);
                await deleteCharacters(page, avatars);
            }
        });
    }

    test('a write after an overwrite that fails leaves the old book deleted and unlinked', async ({ page }) => {
        const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const worldName = `WI_OVERWRITE_FAILED_${s}`;
        const newName = worldName.toLowerCase();
        const names = [`WIOverwriteFailed-${s}-00`, `WIOverwriteFailed-${s}-01`];

        await createWorld(page, worldName);
        const avatars = await createCharacters(page, names, worldName);
        try {
            const lookups = recordStillLinkedQueries(page, worldName);
            await page.route(BOOK_WRITE, route => route.fulfill({ status: 500, body: 'synthetic write failure' }));
            try {
                await overwriteWorld(page, 'create', newName);
            } finally {
                await page.unroute(BOOK_WRITE);
            }

            expect(await worldExists(page, worldName)).toBe(false);
            expect(await worldExists(page, newName)).toBe(false);
            expect(await storedWorld(page, avatars[0])).toBe('');
            expect(await storedWorld(page, avatars[1])).toBe('');
            expect(lookups).toEqual([]);
        } finally {
            await deleteWorld(page, worldName);
            await deleteWorld(page, newName);
            await deleteCharacters(page, avatars);
        }
    });
});
