import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// A tag definition changed from another tab reaches this one without a reload: the changes stream says tags
// changed, and the page asks /api/tags/changes for what changed past its cursor.

/** @param {import('@playwright/test').Page} page */
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

/**
 * A second tab, in a browser context of its own: the page under test learns of what it does only from the server.
 * @param {import('@playwright/test').Browser} browser
 * @returns {Promise<{ other: import('@playwright/test').Page, close: () => Promise<void> }>}
 */
async function openOtherTab(browser) {
    const context = await browser.newContext();
    const other = await context.newPage();
    await loadApp(other);
    return { other, close: () => context.close() };
}

/** @param {string} id @param {number} sortOrder @param {Record<string, unknown>} [fields] */
function tagBody(id, sortOrder, fields = {}) {
    return {
        tag: {
            id, name: id, folder_type: 'NONE', sort_order: sortOrder,
            is_hidden_on_character_card: false, color: '', color2: '', create_date: Date.now(), ...fields,
        },
    };
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

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 * @returns {Promise<Record<string, any> | null>} This tab's copy of the tag, or null when it has none.
 */
async function heldTag(page, id) {
    return page.evaluate((id) => {
        const tag = window['SillyTavern'].getContext().tags.find(t => t.id === id);
        return tag ? JSON.parse(JSON.stringify(tag)) : null;
    }, id);
}

/** @param {import('@playwright/test').Page} page @param {string} id @returns {Promise<number>} */
async function heldCount(page, id) {
    return page.evaluate(id => window['SillyTavern'].getContext().tags.filter(t => t.id === id).length, id);
}

/** @param {import('@playwright/test').Page} page */
async function openTagManagement(page) {
    await openCharacterManagementDrawer(page);
    await page.locator('.rm_tag_filter .manageTags:visible').first().click();
    await page.locator('#tag_view_list .tag_view_prune').waitFor({ state: 'visible', timeout: 10000 });
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {string[]} the path of every /api/tags/ request the page sends from now on
 */
function recordTagRequests(page) {
    /** @type {string[]} */
    const paths = [];
    page.on('request', (request) => {
        const { pathname } = new URL(request.url());
        if (pathname.startsWith('/api/tags/')) paths.push(pathname);
    });
    return paths;
}

/**
 * Makes a character carrying `tagIds`. The page holds a tag only while something on screen shows it, so a test opens
 * this character (selectCharacter()) to have the page hold the tags it looks at.
 * @param {import('@playwright/test').Page} other @param {string} name @param {string[]} tagIds
 * @returns {Promise<string>} avatar
 */
async function createHolder(other, name, tagIds) {
    const avatar = await createCharacter(other, name);
    for (const tagId of tagIds) await api(other, '/api/tags/assign', { id: avatar, tagId });
    return avatar;
}

/** @param {import('@playwright/test').Page} page @param {string} avatar */
async function selectCharacter(page, avatar) {
    await page.evaluate(async (avatar) => {
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
}

// The stream holds a 'tags-changed' message back for up to 2s; past this, one that was coming has come.
const STREAM_SETTLE_MS = 4000;

test.describe('tag changes from another tab', () => {
    test.setTimeout(180000);

    test('a tag created, edited and deleted in another tab is created, edited and dropped here, in place', async ({ page, browser }) => {
        await loadApp(page);
        const { other, close } = await openOtherTab(browser);
        try {
            const id = 'tag-other-tabs-lifecycle';
            await openTagManagement(page);
            await page.evaluate(() => { window['__tagsArray'] = window['SillyTavern'].getContext().tags; });

            await api(other, '/api/tags/create', tagBody(id, 1000));
            await expect.poll(() => heldTag(page, id), { timeout: 15000 }).toMatchObject({ id, name: id });
            await expect(page.locator(`#tag_view_list .tag_view_item[id="${id}"]`)).toBeVisible();
            await page.evaluate((id) => { window['__tagObject'] = window['SillyTavern'].getContext().tags.find(t => t.id === id); }, id);

            await api(other, '/api/tags/edit', { id, patch: { name: 'renamed elsewhere', color: '#112233', is_hidden_on_character_card: true } });
            await expect.poll(() => heldTag(page, id), { timeout: 15000 })
                .toMatchObject({ name: 'renamed elsewhere', color: '#112233', is_hidden_on_character_card: true });
            await expect(page.locator(`#tag_view_list .tag_view_item[id="${id}"] .tag_view_name`)).toHaveText('renamed elsewhere');
            // The same array and the same object: what an extension holds stays current.
            expect(await page.evaluate((id) => {
                const { tags } = window['SillyTavern'].getContext();
                return tags === window['__tagsArray'] && tags.find(t => t.id === id) === window['__tagObject'];
            }, id)).toBe(true);

            await api(other, '/api/tags/delete', { id });
            await expect.poll(() => heldTag(page, id), { timeout: 15000 }).toBeNull();
            await expect(page.locator(`#tag_view_list .tag_view_item[id="${id}"]`)).toHaveCount(0);
        } finally {
            await close();
        }
    });

    test('a tag merged into another in another tab: a character held here gets the target', async ({ page, browser }) => {
        const { other, close } = await openOtherTab(browser);
        try {
            const from = 'tag-other-tabs-merge-from';
            const into = 'tag-other-tabs-merge-into';
            const avatar = await createCharacter(other, 'TagOtherTabsMerge');
            await api(other, '/api/tags/create', tagBody(from, 1000));
            await api(other, '/api/tags/create', tagBody(into, 1001));
            await api(other, '/api/tags/assign', { id: avatar, tagId: from });

            await loadApp(page);
            await openCharacterManagementDrawer(page);
            const heldIds = () => page.evaluate(async (avatar) => {
                const { charactersStore } = await import('/scripts/character-store.js');
                return charactersStore.get(avatar)?.tag_ids ?? null;
            }, avatar);
            await expect.poll(heldIds, { timeout: 15000 }).toEqual([from]);

            await api(other, '/api/tags/delete', { id: from, mergeInto: into });
            await expect.poll(heldIds, { timeout: 15000 }).toEqual([into]);
            expect(await heldTag(page, from)).toBeNull();
        } finally {
            await close();
        }
    });

    test('this tab\'s own create and edit are not applied a second time', async ({ page }) => {
        await loadApp(page);
        await openTagManagement(page);
        const paths = recordTagRequests(page);

        await page.locator('#tag_view_list .tag_view_create').click();
        const row = page.locator('#tag_view_list .tag_view_item').filter({ has: page.locator('.tag_view_name', { hasText: /^New Tag/ }) }).first();
        await expect(row).toBeVisible({ timeout: 10000 });
        const id = await row.getAttribute('id');
        await page.evaluate((id) => { window['__tagObject'] = window['SillyTavern'].getContext().tags.find(t => t.id === id); }, id);

        const name = page.locator(`#tag_view_list .tag_view_item[id="${id}"] .tag_view_name`);
        await name.click();
        await name.fill('own rename');
        await name.press('Enter');
        await expect.poll(async () => (await api(page, '/api/tags/by-ids', { ids: [id] })).tags[0]?.name, { timeout: 10000 }).toBe('own rename');

        await page.waitForTimeout(STREAM_SETTLE_MS);
        // The feed was asked, and found this tab already current.
        expect(paths).toContain('/api/tags/changes');
        expect(await heldCount(page, id)).toBe(1);
        expect(await page.evaluate(id => window['SillyTavern'].getContext().tags.find(t => t.id === id) === window['__tagObject'], id)).toBe(true);
        expect(await heldTag(page, id)).toMatchObject({ name: 'own rename' });
        await expect(page.locator(`#tag_view_list .tag_view_item[id="${id}"]`)).toHaveCount(1);
        // No whole re-read of the tags was needed for it.
        expect(paths).not.toContain('/api/tags/digest');
        expect(paths).not.toContain('/api/tags/get');
    });

    test('a reorder made in another tab shows here in the server\'s order', async ({ page, browser }) => {
        const { other, close } = await openOtherTab(browser);
        try {
            const ids = ['tag-other-tabs-order-a', 'tag-other-tabs-order-b', 'tag-other-tabs-order-c'];
            for (const [i, id] of ids.entries()) await api(other, '/api/tags/create', tagBody(id, 5000 + i));
            const holder = await createHolder(other, 'TagOtherTabsOrder', ids);
            await loadApp(page);
            await selectCharacter(page, holder);
            await expect.poll(async () => (await Promise.all(ids.map(id => heldTag(page, id)))).every(Boolean), { timeout: 15000 }).toBe(true);

            const answer = await api(other, '/api/tags/move', { id: ids[2], before: ids[0] });
            expect(answer.refused).toEqual([]);

            const heldOrder = () => page.evaluate(ids => window['SillyTavern'].getContext().tags
                .filter(tag => ids.includes(tag.id)).sort((a, b) => a.sort_order - b.sort_order).map(tag => tag.id), ids);
            await expect.poll(heldOrder, { timeout: 15000 }).toEqual([ids[2], ids[0], ids[1]]);
        } finally {
            await close();
        }
    });

    test('an ask that fails leaves the cursor where it was: the next ask brings what both changed', async ({ page, browser }) => {
        const { other, close } = await openOtherTab(browser);
        try {
            const first = 'tag-other-tabs-retry-first';
            const second = 'tag-other-tabs-retry-second';
            // The character carries both ids before any tag has them, so it is drawn here without them.
            const holder = await createHolder(other, 'TagOtherTabsRetry', [first, second]);
            await loadApp(page);
            await selectCharacter(page, holder);
            await expect(page.locator('#tagList')).toBeAttached();
            let failed = 0;
            await page.route('**/api/tags/changes', async (route) => {
                if (failed === 0) {
                    failed++;
                    await route.fulfill({ status: 500, body: '' });
                } else {
                    await route.continue();
                }
            });

            await api(other, '/api/tags/create', tagBody(first, 1000));
            await expect.poll(() => failed, { timeout: 15000 }).toBe(1);
            await page.waitForTimeout(500);
            expect(await heldTag(page, first)).toBeNull();

            await api(other, '/api/tags/create', tagBody(second, 1001));
            await expect.poll(() => heldTag(page, second), { timeout: 15000 }).toMatchObject({ id: second });
            expect(await heldTag(page, first)).toMatchObject({ id: first });
        } finally {
            await close();
        }
    });

    test('a field an extension changed here and hasn\'t stored yet survives another tab\'s edit of the same tag', async ({ page, browser }) => {
        const { other, close } = await openOtherTab(browser);
        try {
            const id = 'tag-other-tabs-unstored';
            await api(other, '/api/tags/create', tagBody(id, 1000));
            const holder = await createHolder(other, 'TagOtherTabsUnstored', [id]);
            await loadApp(page);
            await selectCharacter(page, holder);
            await expect.poll(() => heldTag(page, id), { timeout: 15000 }).toMatchObject({ id });

            await page.evaluate((id) => { window['SillyTavern'].getContext().tags.find(t => t.id === id).color2 = '#abcdef'; }, id);
            await api(other, '/api/tags/edit', { id, patch: { name: 'renamed elsewhere' } });
            await expect.poll(() => heldTag(page, id), { timeout: 15000 }).toMatchObject({ name: 'renamed elsewhere', color2: '#abcdef' });

            // The extension's change is still stored when it asks for a settings save.
            await page.evaluate(() => window['SillyTavern'].getContext().saveSettingsDebounced());
            await expect.poll(async () => (await api(page, '/api/tags/by-ids', { ids: [id] })).tags[0], { timeout: 15000 })
                .toMatchObject({ name: 'renamed elsewhere', color2: '#abcdef' });
        } finally {
            await close();
        }
    });
});
