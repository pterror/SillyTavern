import { test, expect } from './fixtures.js';
import { testSetup, holdCharacters } from './frontent-test-utils.js';

// Duplicating a character copies its tags on the server, from what the server has. The page sends no tag list of
// its own, so a copy of the original it holds that is out of date can't decide what the duplicate gets.

/**
 * Loads the app and waits for APP_READY.
 * @param {import('@playwright/test').Page} page
 */
async function loadApp(page) {
    await testSetup.awaitST({ page });
    // APP_READY is an auto-fire event: a listener added after it was emitted still runs.
    await page.evaluate(() => {
        window['__appReady'] = false;
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, () => { window['__appReady'] = true; });
    });
    await page.waitForFunction(() => window['__appReady'], null, { timeout: 60000 });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} path
 * @param {object} [body]
 */
async function api(page, path, body = {}) {
    return page.evaluate(async ({ path, body }) => {
        const headers = window['SillyTavern'].getContext().getRequestHeaders();
        const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!response.ok) throw new Error(`${path} -> ${response.status}`);
        const text = await response.text();
        try { return JSON.parse(text); } catch { return text; }
    }, { path, body });
}

/** @param {import('@playwright/test').Page} page @param {string} name @returns {Promise<string>} avatar */
async function createCharacter(page, name) {
    return page.evaluate(async (name) => {
        const headers = window['SillyTavern'].getContext().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.append('ch_name', name);
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create -> ${response.status}`);
        return response.text();
    }, name);
}

/** @param {string} id @param {string} name */
function tagDefinition(id, name) {
    return {
        id, name, folder_type: 'NONE', filter_state: 'UNDEFINED', sort_order: 1000,
        is_hidden_on_character_card: false, color: '', color2: '', create_date: Date.now(),
    };
}

/** @param {import('@playwright/test').Page} page @param {string} name @returns {Promise<string>} tag id */
async function createTag(page, name) {
    const id = `tag-copy-${name}`;
    await api(page, '/api/tags/create', { tag: tagDefinition(id, name) });
    return id;
}

/** @param {import('@playwright/test').Page} page @param {string} key @returns {Promise<string[]>} */
async function serverTagsOf(page, key) {
    return (await api(page, '/api/tags/for', { ids: [key] }))[key];
}

/** @param {import('@playwright/test').Page} page @param {string} avatar @returns {Promise<string[] | null>} */
async function residentTagsOf(page, avatar) {
    return page.evaluate(async (avatar) => {
        const { charactersStore } = await import('/scripts/character-store.js');
        const character = charactersStore.get(avatar);
        return character ? [...character.tag_ids].sort() : null;
    }, avatar);
}

/**
 * Creates the fixture data from a throwaway browser context, so the page under test learns about everything only
 * through its own boot.
 * @param {import('@playwright/test').Browser} browser
 * @param {(page: import('@playwright/test').Page) => Promise<T>} fn
 * @template T
 */
async function withSetupPage(browser, fn) {
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        await loadApp(page);
        return await fn(page);
    } finally {
        await context.close();
    }
}

/**
 * Keeps changes to `avatar` from reaching the page.
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function hideChangesOf(page, avatar) {
    await page.route('**/api/characters/changes', async route => {
        const response = await route.fetch();
        const json = await response.json();
        json.changes = json.changes.filter(c => c.id !== avatar);
        await route.fulfill({ response, json });
    });
    await page.route('**/api/characters/batch', async route => {
        const response = await route.fetch();
        const json = await response.json();
        await route.fulfill({ response, json: json.filter(c => c.avatar !== avatar) });
    });
}

/**
 * Duplicates `avatar` the way the character panel's Duplicate button does, without its confirmation popup.
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @returns {Promise<string>} The duplicate's avatar.
 */
async function duplicate(page, avatar) {
    return page.evaluate(async (avatar) => {
        const { duplicateCharacter } = await import('/script.js');
        return duplicateCharacter({ avatar, silent: true });
    }, avatar);
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {{ path: string, body: any }[]} Filled with every tag write the page sends from now on.
 */
function recordTagWrites(page) {
    /** @type {{ path: string, body: any }[]} */
    const writes = [];
    page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (/^\/api\/tags\/(copy|assign|unassign|assign-many)$/.test(path)) writes.push({ path, body: request.postDataJSON() });
    });
    return writes;
}

test.describe('Duplicating a character copies its tags on the server', () => {
    test.setTimeout(180000);

    test('the duplicate gets the tag another tab gave the original, which this page has not seen', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withSetupPage(browser, async (setup) => {
            const seen = await createTag(setup, `seen-${stamp}`);
            const unseen = await createTag(setup, `unseen-${stamp}`);
            const card = await createCharacter(setup, `TagCopyStale-${stamp}`);
            await api(setup, '/api/tags/assign', { id: card, tagId: seen });
            return { seen, unseen, card };
        });

        await loadApp(page);
        await holdCharacters(page, [fixture.card]);
        expect(await residentTagsOf(page, fixture.card)).toEqual([fixture.seen]);

        await hideChangesOf(page, fixture.card);
        const other = await page.context().newPage();
        await loadApp(other);
        await api(other, '/api/tags/assign', { id: fixture.card, tagId: fixture.unseen });
        await other.close();
        expect(await residentTagsOf(page, fixture.card)).toEqual([fixture.seen]);

        const writes = recordTagWrites(page);
        const copy = await duplicate(page, fixture.card);
        expect(copy).toBeTruthy();

        expect(writes).toEqual([{ path: '/api/tags/copy', body: { from: fixture.card, to: copy } }]);
        const expected = [fixture.seen, fixture.unseen].sort();
        expect((await serverTagsOf(page, copy)).sort()).toEqual(expected);
        expect((await serverTagsOf(page, fixture.card)).sort()).toEqual(expected);
    });

    test('a failed copy is reported', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withSetupPage(browser, async (setup) => {
            const card = await createCharacter(setup, `TagCopyFails-${stamp}`);
            return { card };
        });

        await loadApp(page);
        await page.route('**/api/tags/copy', route => route.fulfill({ status: 500, body: '' }));
        expect(await duplicate(page, fixture.card)).toBeTruthy();
        await expect(page.locator('.toast-error', { hasText: 'Tags could not be copied to the duplicate.' })).toBeVisible({ timeout: 15000 });
    });
});
