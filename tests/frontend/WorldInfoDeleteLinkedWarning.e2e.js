import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// deleteWorldInfo() unlinks only the open character, as upstream does. Every other character whose primary
// lorebook is the deleted one keeps its link, and a warning names the first 20 of them and counts the rest.
// A create or import that overwrites a book deletes it too, but warns only if no book has that name afterwards.

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * Creates characters through the API, each with `world` as its primary lorebook ('' for none).
 * @param {import('@playwright/test').Page} page
 * @param {string[]} names
 * @param {string} world
 * @returns {Promise<string[]>} The avatar filenames, in the order of `names`.
 */
async function createCharacters(page, names, world) {
    return page.evaluate(async ({ names, world }) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders({ omitContentType: true });
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
        const headers = SillyTavern.getContext().getRequestHeaders();
        for (const avatar of avatars) {
            await fetch('/api/characters/delete', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, delete_chats: true }) });
        }
    }, avatars);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @returns {Promise<string>} The stored card's primary lorebook.
 */
async function storedWorld(page, avatar) {
    return page.evaluate(async (avatar) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
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
 * Overwrites an existing book through createNewWorldInfo() or importWorldInfo(), confirming the overwrite prompt.
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
 * @returns {Promise<boolean>} Whether the server lists a book with exactly this name.
 */
async function worldExists(page, worldName) {
    return page.evaluate(async (worldName) => {
        const worldInfo = await import('./scripts/world-info.js');
        await worldInfo.updateWorldInfoList();
        // Read off the module namespace after the reload: world_names is reassigned, not mutated.
        return worldInfo.world_names.includes(worldName);
    }, worldName);
}

/**
 * Records, from here on, every `/api/characters/query` request filtered to `worldName`: the still-linked warning's
 * lookup.
 * @param {import('@playwright/test').Page} page
 * @param {string} worldName
 * @returns {object[]} The request bodies, filled in as they are sent.
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

// Before the overwrite paths awaited their deletion, its warning could show after the create or import had
// returned; this is long enough for one that is going to show to have been looked up.
const QUIET_MS = 2500;

const stillLinkedToast = (page, worldName) => page.locator('#toast-container .toast-warning .toast-message', { hasText: `Deleted lorebook ${worldName} is still the primary lorebook of` });

test.describe('deleting a lorebook other characters still link to', () => {
    test.beforeEach(testSetup.awaitST);

    test('leaves the other characters linked and names the first 20, counting the rest', async ({ page }) => {
        const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const worldName = `WI_DELETE_LINKED_${s}`;
        // Index 00 is opened in the editor; 01 to 21 are the other 21 linked characters.
        const names = Array.from({ length: 22 }, (_, i) => `WIDeleteLinked-${s}-${String(i).padStart(2, '0')}`);

        await createWorld(page, worldName);
        const avatars = await createCharacters(page, names, worldName);
        try {
            await openCharacterManagementDrawer(page);
            await page.evaluate(async (avatar) => {
                // @ts-ignore
                await SillyTavern.getContext().getCharacters();
                const { selectCharacterByAvatar } = await import('/script.js');
                await selectCharacterByAvatar(avatar);
            }, avatars[0]);
            await expect(page.locator('#avatar_url_pole')).toHaveValue(avatars[0], { timeout: 10000 });
            await expect(page.locator('#character_world')).toHaveValue(worldName);

            expect(await deleteWorld(page, worldName)).toBe(true);

            const toast = stillLinkedToast(page, worldName);
            await expect(toast).toHaveCount(1);
            const text = await toast.innerText();
            expect(text).toContain(`Deleted lorebook ${worldName} is still the primary lorebook of 21 other character(s):`);
            expect(text).toContain(names.slice(1, 21).join(', '));
            expect(text).not.toContain(names[0]);
            expect(text).not.toContain(names[21]);
            expect(text).toContain('and 1 more.');

            // The other characters keep their link, as upstream leaves them.
            expect(await storedWorld(page, avatars[1])).toBe(worldName);
            expect(await storedWorld(page, avatars[21])).toBe(worldName);

            // The open character is the one deleteWorldInfo() unlinked, so it is the one left out of the warning.
            await page.evaluate(async () => {
                const { flushCharacterFieldSaves } = await import('/script.js');
                await flushCharacterFieldSaves();
            });
            expect(await storedWorld(page, avatars[0])).toBe('');
        } finally {
            await deleteWorld(page, worldName);
            await deleteCharacters(page, avatars);
        }
    });

    test('shows no warning when no other character links to it', async ({ page }) => {
        const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const worldName = `WI_DELETE_UNLINKED_${s}`;

        await createWorld(page, worldName);
        const avatars = await createCharacters(page, [`WIDeleteUnlinked-${s}`], '');
        try {
            expect(await deleteWorld(page, worldName)).toBe(true);
            await expect(stillLinkedToast(page, worldName)).toHaveCount(0);
            await expect(page.locator('#toast-container .toast-warning .toast-message', { hasText: 'could not check which other characters' })).toHaveCount(0);
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
                const deleted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/worldinfo/delete');
                await overwriteWorld(page, how, worldName);
                await deleted;
                await page.waitForTimeout(QUIET_MS);

                expect(await worldExists(page, worldName)).toBe(true);
                expect(lookups).toEqual([]);
                await expect(stillLinkedToast(page, worldName)).toHaveCount(0);
                expect(await storedWorld(page, avatars[0])).toBe(worldName);
                expect(await storedWorld(page, avatars[1])).toBe(worldName);
            } finally {
                await deleteWorld(page, worldName);
                await deleteCharacters(page, avatars);
            }
        });
    }

    test('warns when the write after an overwrite fails and the book is gone', async ({ page }) => {
        const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const worldName = `WI_OVERWRITE_FAILED_${s}`;
        const names = [`WIOverwriteFailed-${s}-00`, `WIOverwriteFailed-${s}-01`];

        await createWorld(page, worldName);
        const avatars = await createCharacters(page, names, worldName);
        try {
            await page.route('**/api/worldinfo/edit', route => route.fulfill({ status: 500, body: 'synthetic write failure' }));
            try {
                await overwriteWorld(page, 'create', worldName);
            } finally {
                await page.unroute('**/api/worldinfo/edit');
            }

            expect(await worldExists(page, worldName)).toBe(false);
            const toast = stillLinkedToast(page, worldName);
            await expect(toast).toHaveCount(1);
            const text = await toast.innerText();
            expect(text).toContain(`Deleted lorebook ${worldName} is still the primary lorebook of 2 other character(s):`);
            expect(text).toContain(names.join(', '));
            expect(text).not.toContain('more.');
        } finally {
            await deleteWorld(page, worldName);
            await deleteCharacters(page, avatars);
        }
    });
});
