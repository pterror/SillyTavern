import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, holdCharacters, holdGroups } from './frontent-test-utils.js';

/** @param {import('@playwright/test').Page} page */
async function loadApp(page) {
    await testSetup.awaitST({ page });
    await page.evaluate(() => {
        window['__appReady'] = false;
        const { eventSource, eventTypes } = window['stTest'].context();
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
        const headers = window['stTest'].context().getRequestHeaders();
        const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!response.ok) throw new Error(`${path} -> ${response.status}`);
        const text = await response.text();
        try { return JSON.parse(text); } catch { return text; }
    }, { path, body });
}

/**
 * @param {import('@playwright/test').Browser} browser
 * @returns {Promise<{ other: import('@playwright/test').Page, close: () => Promise<void> }>}
 */
async function openOtherTab(browser) {
    const context = await browser.newContext();
    const other = await context.newPage();
    await loadApp(other);
    return { other, close: () => context.close() };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 */
async function createTag(page, id) {
    const answer = await api(page, '/api/tags/create', {
        tag: { id, name: id, folder_type: 'NONE', is_hidden_on_character_card: false, color: '', color2: '', create_date: Date.now() },
    });
    expect(answer.refused).toEqual([]);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @returns {Promise<string>}
 */
async function createCharacter(page, name) {
    return page.evaluate(async (name) => {
        const headers = window['stTest'].context().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.append('ch_name', name);
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create -> ${response.status}`);
        return response.text();
    }, name);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string[]} members
 * @returns {Promise<string>}
 */
async function createGroup(page, name, members) {
    const group = await api(page, '/api/groups/create', { name, members });
    return String(group.id);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} key
 * @returns {Promise<string[] | null>}
 */
async function heldTagIds(page, key) {
    return page.evaluate(async (key) => {
        const { charactersStore } = await import('/scripts/character-store.js');
        const { groupsStore } = await import('/scripts/group-store.js');
        const entity = charactersStore.get(key) ?? groupsStore.get(key);
        return entity ? [...(entity.tag_ids ?? [])].sort() : null;
    }, key);
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<boolean>}
 */
async function listDrawerOpen(page) {
    return page.evaluate(() => document.getElementById('right-nav-panel').classList.contains('openDrawer'));
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {{ path: string, body: any }[]}
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
                window['__tagIds'] = window['stTest'].context().characters.find(c => c.avatar === avatar).tag_ids;
            }, avatar);

            expect(await api(other, '/api/tags/assign', { id: avatar, tagId })).toEqual({ result: 'ok', assigned: tagId, reason: null, defined: true });
            await expect.poll(() => heldTagIds(page, avatar), { timeout: 15000 }).toEqual([tagId]);
            await expect(page.locator(`#tagList .tag[id="${tagId}"]`)).toHaveCount(1);
            expect(await page.evaluate(avatar => window['stTest'].context().characters.find(c => c.avatar === avatar).tag_ids === window['__tagIds'], avatar)).toBe(true);
            expect(await listDrawerOpen(page)).toBe(false);

            await api(other, '/api/tags/unassign', { id: avatar, tagId });
            await expect.poll(() => heldTagIds(page, avatar), { timeout: 15000 }).toEqual([]);
            await expect(page.locator(`#tagList .tag[id="${tagId}"]`)).toHaveCount(0);
        } finally {
            await close();
        }
    });

    test('a character edited elsewhere, with no tag changed, is not asked about', async ({ page, browser }) => {
        const { other, close } = await openOtherTab(browser);
        try {
            const avatar = await createCharacter(other, 'TagAssignOtherTabsPlainEdit');
            await loadApp(page);
            await openCharacterManagementDrawer(page);
            await holdCharacters(page, [avatar]);
            await page.waitForTimeout(STREAM_SETTLE_MS);
            const asked = [];
            const listReads = [];
            page.on('request', (request) => {
                const path = new URL(request.url()).pathname;
                if (path === '/api/tags/assignment-changes') asked.push(path);
                else if (path.startsWith('/api/characters/') && path !== '/api/characters/merge-attributes') listReads.push(path);
            });
            await api(other, '/api/characters/merge-attributes', { avatar, description: 'edited elsewhere', data: { description: 'edited elsewhere' } });
            await expect.poll(() => listReads.length, { timeout: 15000 }).toBeGreaterThan(0);
            await page.waitForTimeout(STREAM_SETTLE_MS);
            expect(asked).toEqual([]);
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
            await holdGroups(page, [groupId]);
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

    test('a restore made elsewhere reaches the characters and groups held here', async ({ page, browser }) => {
        const { other, close } = await openOtherTab(browser);
        try {
            const tagId = 'tag-assign-other-tabs-bulk';
            const a = await createCharacter(other, 'TagAssignOtherTabsBulkA');
            const g1 = await createGroup(other, 'TagAssignOtherTabsBulkG1', [a]);
            await createTag(other, tagId);

            await loadApp(page);
            await holdCharacters(page, [a]);
            await holdGroups(page, [g1]);
            expect(await listDrawerOpen(page)).toBe(false);

            await api(other, '/api/tags/restore', { tags: [], tagMap: { [a]: [tagId], [g1]: [tagId] }, overwrite: false });
            await expect.poll(() => heldTagIds(page, a), { timeout: 15000 }).toEqual([tagId]);
            await expect.poll(() => heldTagIds(page, g1), { timeout: 15000 }).toEqual([tagId]);
        } finally {
            await close();
        }
    });

    test('an ask that fails leaves the cursors where they were: the next ask brings what both changed', async ({ page, browser }) => {
        const { other, close } = await openOtherTab(browser);
        try {
            const tagId = 'tag-assign-other-tabs-retry';
            const first = await createCharacter(other, 'TagAssignOtherTabsRetryA');
            const second = await createCharacter(other, 'TagAssignOtherTabsRetryB');
            await createTag(other, tagId);
            await loadApp(page);
            await holdCharacters(page, [first, second]);
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
            await holdCharacters(page, [avatar]);
            await page.waitForTimeout(STREAM_SETTLE_MS);

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
            await expect.poll(() => heldTagIds(page, avatar), { timeout: 15000 }).toEqual([tagId]);
            const asks = requests.filter(r => r.path === '/api/tags/assignment-changes');
            expect(asks).toHaveLength(1);
            const held = await page.evaluate(async () => {
                const { characters } = await import('/scripts/character-store.js');
                const { groups } = await import('/scripts/group-store.js');
                const { getUnheldRowTagIds } = await import('/scripts/character-list.js');
                return characters.length + groups.length + getUnheldRowTagIds().size;
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

            await page.addInitScript((ids) => {
                for (const id of ids) localStorage.setItem(`CharacterList_tag_${id}`, 'EXCLUDED');
            }, [merged, gone]);
            await loadApp(page);
            await openCharacterManagementDrawer(page);
            await page.evaluate(async (avatar) => {
                const { selectCharacterByAvatar } = await import('/script.js');
                await selectCharacterByAvatar(avatar);
            }, avatar);
            await expect.poll(() => page.evaluate(async (ids) => {
                const { tagsStore } = await import('/scripts/tags.js');
                return ids.every(id => tagsStore.has(id));
            }, [merged, gone])).toBe(true);
            await page.route('**/api/tags/changes', route => route.fulfill({ status: 500 }));
            await api(other, '/api/tags/delete', { id: merged, mergeInto: target });
            await api(other, '/api/tags/delete', { id: gone });
            await expect.poll(async () => {
                const answer = await api(other, '/api/tags/by-ids', { ids: [merged, gone] });
                return [answer.gone, answer.merged];
            }, { timeout: 15000 }).toEqual([[gone], { [merged]: target }]);
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
            await expect(toast).toContainText(`'${merged}' was deleted and merged into '${target}', so TagAssignOtherTabsDeleted got '${target}'.`);
            await expect(toast).toContainText(`'${gone}' was not added to TagAssignOtherTabsDeleted: the tag was deleted.`);
            expect(await heldDefinitions()).toBe(0);
            await expect(page.locator(`#tagList .tag[id="${merged}"], #tagList .tag[id="${gone}"]`)).toHaveCount(0);
            expect(await heldTagIds(page, avatar)).toEqual((await api(page, '/api/tags/for', { ids: [avatar] }))[avatar]);
        } finally {
            await close();
        }
    });
});
