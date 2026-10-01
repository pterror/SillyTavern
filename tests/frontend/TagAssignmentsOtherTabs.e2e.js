import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// A tag put on or taken off a character or group from another tab reaches this one without a reload, whether or not
// the character list is showing: the changes stream says something changed, and the page asks
// /api/tags/assignment-changes which entities' tags may have changed past its cursors.

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

/** @param {import('@playwright/test').Page} page @param {string} id */
async function createTag(page, id) {
    const answer = await api(page, '/api/tags/create', {
        tag: { id, name: id, folder_type: 'NONE', is_hidden_on_character_card: false, color: '', color2: '', create_date: Date.now() },
    });
    expect(answer.refused).toEqual([]);
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

/** @param {import('@playwright/test').Page} page @param {string} name @param {string[]} members @returns {Promise<string>} group id */
async function createGroup(page, name, members) {
    const group = await api(page, '/api/groups/create', { name, members });
    return String(group.id);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} key A character avatar or a group id.
 * @returns {Promise<string[] | null>} The tag ids this tab's own copy of the entity carries; null when it holds none.
 */
async function heldTagIds(page, key) {
    return page.evaluate(async (key) => {
        const { charactersStore } = await import('/scripts/character-store.js');
        const { groupsStore } = await import('/scripts/group-store.js');
        const entity = charactersStore.get(key) ?? groupsStore.get(key);
        return entity ? [...(entity.tag_ids ?? [])].sort() : null;
    }, key);
}

/** @param {import('@playwright/test').Page} page @returns {Promise<boolean>} whether the drawer holding the character list is open */
async function listDrawerOpen(page) {
    return page.evaluate(() => document.getElementById('right-nav-panel').classList.contains('openDrawer'));
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {{ path: string, body: any }[]} every /api/tags/ request the page sends from now on
 */
function recordTagRequests(page) {
    /** @type {{ path: string, body: any }[]} */
    const requests = [];
    page.on('request', (request) => {
        const { pathname } = new URL(request.url());
        if (!pathname.startsWith('/api/tags/')) return;
        let body = null;
        try { body = request.postDataJSON(); } catch { /* not JSON */ }
        requests.push({ path: pathname, body });
    });
    return requests;
}

// The stream holds a change message back for up to 2s; past this, one that was coming has come.
const STREAM_SETTLE_MS = 4000;

test.describe('tag assignments changed in another tab', () => {
    test.setTimeout(180000);

    test('a character open here, with the list hidden, gains and loses the tag in its data and its tag list', async ({ page, browser }) => {
        const { other, close } = await openOtherTab(browser);
        try {
            const tagId = 'tag-assign-other-tabs-char';
            const avatar = await createCharacter(other, 'TagAssignOtherTabsChar');
            await createTag(other, tagId);

            await loadApp(page);
            await page.evaluate(async (avatar) => {
                const { selectCharacterByAvatar } = await import('/script.js');
                await selectCharacterByAvatar(avatar);
            }, avatar);
            expect(await listDrawerOpen(page)).toBe(false);
            expect(await heldTagIds(page, avatar)).toEqual([]);
            await page.evaluate((avatar) => {
                window['__tagIds'] = window['SillyTavern'].getContext().characters.find(c => c.avatar === avatar).tag_ids;
            }, avatar);

            expect(await api(other, '/api/tags/assign', { id: avatar, tagId })).toEqual({ result: 'ok', assigned: tagId, reason: null, defined: true });
            await expect.poll(() => heldTagIds(page, avatar), { timeout: 15000 }).toEqual([tagId]);
            await expect(page.locator(`#tagList .tag[id="${tagId}"]`)).toHaveCount(1);
            // The same array: what an extension holds through tag_map stays current.
            expect(await page.evaluate(avatar => window['SillyTavern'].getContext().characters.find(c => c.avatar === avatar).tag_ids === window['__tagIds'], avatar)).toBe(true);
            expect(await listDrawerOpen(page)).toBe(false);

            await api(other, '/api/tags/unassign', { id: avatar, tagId });
            await expect.poll(() => heldTagIds(page, avatar), { timeout: 15000 }).toEqual([]);
            await expect(page.locator(`#tagList .tag[id="${tagId}"]`)).toHaveCount(0);
        } finally {
            await close();
        }
    });

    test('a group held here gains and loses the tag, with the list hidden', async ({ page, browser }) => {
        const { other, close } = await openOtherTab(browser);
        try {
            const tagId = 'tag-assign-other-tabs-group';
            const member = await createCharacter(other, 'TagAssignOtherTabsMember');
            const groupId = await createGroup(other, 'TagAssignOtherTabsGroup', [member]);
            await createTag(other, tagId);

            await loadApp(page);
            expect(await listDrawerOpen(page)).toBe(false);
            expect(await heldTagIds(page, groupId)).toEqual([]);

            await api(other, '/api/tags/assign', { id: groupId, tagId });
            await expect.poll(() => heldTagIds(page, groupId), { timeout: 15000 }).toEqual([tagId]);

            await api(other, '/api/tags/unassign', { id: groupId, tagId });
            await expect.poll(() => heldTagIds(page, groupId), { timeout: 15000 }).toEqual([]);
        } finally {
            await close();
        }
    });

    test('a restore, a copy and a key rename made elsewhere reach the characters and groups held here', async ({ page, browser }) => {
        const { other, close } = await openOtherTab(browser);
        try {
            const tagId = 'tag-assign-other-tabs-bulk';
            const a = await createCharacter(other, 'TagAssignOtherTabsBulkA');
            const b = await createCharacter(other, 'TagAssignOtherTabsBulkB');
            const c = await createCharacter(other, 'TagAssignOtherTabsBulkC');
            const g1 = await createGroup(other, 'TagAssignOtherTabsBulkG1', [a]);
            const g2 = await createGroup(other, 'TagAssignOtherTabsBulkG2', [a]);
            const g3 = await createGroup(other, 'TagAssignOtherTabsBulkG3', [a]);
            await createTag(other, tagId);

            await loadApp(page);
            expect(await listDrawerOpen(page)).toBe(false);

            await api(other, '/api/tags/restore', { tags: [], tagMap: { [a]: [tagId], [g1]: [tagId] }, overwrite: false });
            await expect.poll(() => heldTagIds(page, a), { timeout: 15000 }).toEqual([tagId]);
            await expect.poll(() => heldTagIds(page, g1), { timeout: 15000 }).toEqual([tagId]);

            await api(other, '/api/tags/copy', { from: a, to: b });
            await api(other, '/api/tags/copy', { from: g1, to: g2 });
            await expect.poll(() => heldTagIds(page, b), { timeout: 15000 }).toEqual([tagId]);
            await expect.poll(() => heldTagIds(page, g2), { timeout: 15000 }).toEqual([tagId]);

            await api(other, '/api/tags/rename-key', { from: b, to: c });
            await api(other, '/api/tags/rename-key', { from: g2, to: g3 });
            await expect.poll(() => heldTagIds(page, c), { timeout: 15000 }).toEqual([tagId]);
            await expect.poll(() => heldTagIds(page, b), { timeout: 15000 }).toEqual([]);
            await expect.poll(() => heldTagIds(page, g3), { timeout: 15000 }).toEqual([tagId]);
            await expect.poll(() => heldTagIds(page, g2), { timeout: 15000 }).toEqual([]);
        } finally {
            await close();
        }
    });

    test('this tab\'s own assign is not applied a second time, and only that entity is re-read', async ({ page }) => {
        await loadApp(page);
        const tagId = 'tag-assign-other-tabs-own';
        const avatar = await createCharacter(page, 'TagAssignOtherTabsOwn');
        await createTag(page, tagId);
        await page.reload();
        await loadApp(page);
        await expect.poll(() => heldTagIds(page, avatar), { timeout: 15000 }).toEqual([]);
        // The current character is the one `tag_map` has an entry for.
        await page.evaluate(async (avatar) => {
            const { selectCharacterByAvatar } = await import('/script.js');
            await selectCharacterByAvatar(avatar);
        }, avatar);
        await expect.poll(() => page.evaluate(avatar => Object.hasOwn(window['SillyTavern'].getContext().tagMap, avatar), avatar)).toBe(true);
        await page.waitForTimeout(STREAM_SETTLE_MS);

        const requests = recordTagRequests(page);
        await page.evaluate(({ avatar, tagId }) => {
            const context = window['SillyTavern'].getContext();
            window['__tagIds'] = context.characters.find(c => c.avatar === avatar).tag_ids;
            context.tagMap[avatar].push(tagId);
            context.saveSettingsDebounced();
        }, { avatar, tagId });
        await expect.poll(async () => (await api(page, '/api/tags/for', { ids: [avatar] }))[avatar], { timeout: 15000 }).toEqual([tagId]);
        requests.length = 0;

        await page.waitForTimeout(STREAM_SETTLE_MS);
        // The feed was asked, and found this tab already current.
        expect(requests.map(r => r.path)).toContain('/api/tags/assignment-changes');
        expect(requests.filter(r => r.path === '/api/tags/assign')).toEqual([]);
        for (const request of requests.filter(r => r.path === '/api/tags/for')) {
            expect(request.body.ids).toEqual([avatar]);
        }
        expect(await heldTagIds(page, avatar)).toEqual([tagId]);
        expect(await page.evaluate(avatar => window['SillyTavern'].getContext().characters.find(c => c.avatar === avatar).tag_ids === window['__tagIds'], avatar)).toBe(true);
    });

    test('an ask that fails leaves the cursors where they were: the next ask brings what both changed', async ({ page, browser }) => {
        const { other, close } = await openOtherTab(browser);
        try {
            const tagId = 'tag-assign-other-tabs-retry';
            const first = await createCharacter(other, 'TagAssignOtherTabsRetryA');
            const second = await createCharacter(other, 'TagAssignOtherTabsRetryB');
            await createTag(other, tagId);
            await loadApp(page);
            await page.waitForTimeout(STREAM_SETTLE_MS);

            let failed = 0;
            await page.route('**/api/tags/assignment-changes', async (route) => {
                if (failed === 0) {
                    failed++;
                    await route.fulfill({ status: 500, body: '' });
                } else {
                    await route.continue();
                }
            });

            await api(other, '/api/tags/assign', { id: first, tagId });
            await expect.poll(() => failed, { timeout: 15000 }).toBe(1);
            await page.waitForTimeout(500);
            expect(await heldTagIds(page, first)).toEqual([]);

            await api(other, '/api/tags/assign', { id: second, tagId });
            await expect.poll(() => heldTagIds(page, second), { timeout: 15000 }).toEqual([tagId]);
            expect(await heldTagIds(page, first)).toEqual([tagId]);
        } finally {
            await close();
        }
    });

    test('with more log rows left than entities held, everything held is re-read and the cursors jump to the end', async ({ page, browser }) => {
        const { other, close } = await openOtherTab(browser);
        try {
            const tagId = 'tag-assign-other-tabs-far-behind';
            const avatar = await createCharacter(other, 'TagAssignOtherTabsFarBehind');
            await createTag(other, tagId);
            await loadApp(page);
            await page.waitForTimeout(STREAM_SETTLE_MS);

            // The first answer is made to say a million rows remain past its page.
            let rewritten = 0;
            await page.route('**/api/tags/assignment-changes', async (route) => {
                if (rewritten > 0) return route.continue();
                rewritten++;
                const response = await route.fetch();
                const body = await response.json();
                await route.fulfill({ response, json: { ...body, ids: [], hasMore: true, endSeq: body.endSeq + 1000000 } });
            });
            const requests = recordTagRequests(page);

            await api(other, '/api/tags/assign', { id: avatar, tagId });
            // The page listed no entity, so only a re-read of everything held can bring the tag.
            await expect.poll(() => heldTagIds(page, avatar), { timeout: 15000 }).toEqual([tagId]);
            const asks = requests.filter(r => r.path === '/api/tags/assignment-changes');
            expect(asks).toHaveLength(1);
            const held = await page.evaluate(async () => {
                const { characters } = await import('/scripts/character-store.js');
                const { groups } = await import('/scripts/group-store.js');
                return characters.length + groups.length;
            });
            const reread = requests.filter(r => r.path === '/api/tags/for').flatMap(r => r.body.ids);
            expect(reread).toHaveLength(held);
            expect(reread).toContain(avatar);
        } finally {
            await close();
        }
    });

    test('assigning a tag another tab deleted says so at once, and the tag is dropped here', async ({ page, browser }) => {
        const { other, close } = await openOtherTab(browser);
        try {
            const merged = 'tag-assign-other-tabs-merged';
            const target = 'tag-assign-other-tabs-target';
            const gone = 'tag-assign-other-tabs-gone';
            const avatar = await createCharacter(other, 'TagAssignOtherTabsDeleted');
            for (const id of [merged, target, gone]) await createTag(other, id);

            await loadApp(page);
            await page.evaluate(async (avatar) => {
                const { selectCharacterByAvatar } = await import('/script.js');
                await selectCharacterByAvatar(avatar);
            }, avatar);
            // The tags are read here as a picker reads what it offers.
            await page.evaluate(async (ids) => {
                const { readTagsForIds } = await import('/scripts/tags.js');
                await readTagsForIds(ids);
            }, [merged, gone]);
            // Cut off from the tag definition feed, so this tab still holds the two tags when they are deleted.
            await page.route('**/api/tags/changes', route => route.fulfill({ status: 500 }));
            await api(other, '/api/tags/delete', { id: merged, mergeInto: target });
            await api(other, '/api/tags/delete', { id: gone });
            // Both deletes have finished once neither tag can be read any more.
            await expect.poll(async () => (await api(other, '/api/tags/by-ids', { ids: [merged, gone] })).tags.length, { timeout: 15000 }).toBe(0);
            await page.waitForTimeout(STREAM_SETTLE_MS);
            const heldDefinitions = () => page.evaluate(async (ids) => {
                const { tagsStore } = await import('/scripts/tags.js');
                return ids.filter(id => tagsStore.has(id)).length;
            }, [merged, gone]);
            expect(await heldDefinitions()).toBe(2);

            await page.evaluate(async ({ avatar, merged, gone }) => {
                const { addTagsToEntity, tagsStore } = await import('/scripts/tags.js');
                addTagsToEntity([tagsStore.get(merged), tagsStore.get(gone)], avatar);
            }, { avatar, merged, gone });

            const toast = page.locator('#toast-container .toast-warning', { hasText: 'Tag was deleted' });
            await expect(toast).toBeVisible({ timeout: 15000 });
            await expect(toast).toContainText(`'${merged}' was deleted, so it does not show on TagAssignOtherTabsDeleted.`);
            await expect(toast).toContainText(`'${gone}' was deleted, so it does not show on TagAssignOtherTabsDeleted.`);
            expect(await heldDefinitions()).toBe(0);
            await expect(page.locator(`#tagList .tag[id="${merged}"], #tagList .tag[id="${gone}"]`)).toHaveCount(0);
            // What the server has: the two ids, with no tag behind them.
            expect(await heldTagIds(page, avatar)).toEqual((await api(page, '/api/tags/for', { ids: [avatar] }))[avatar]);
        } finally {
            await close();
        }
    });
});
