import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// Restoring a tag backup adds the backup's assignments. It must never remove a tag a character already has on the
// server, whether or not this page has loaded the character or holds a current copy of it. The backup's tag
// definitions are stored by the restore itself.

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
    const id = `tag-restore-${name}`;
    await api(page, '/api/tags/create', { tag: tagDefinition(id, name) });
    return id;
}

/** @param {import('@playwright/test').Page} page @param {string} key @returns {Promise<string[]>} */
async function serverTagsOf(page, key) {
    return (await api(page, '/api/tags/for', { ids: [key] }))[key];
}

/** @param {import('@playwright/test').Page} page @param {string} avatar @returns {Promise<string[] | null>} */
async function residentTagsOf(page, avatar) {
    return page.evaluate(async avatar => {
        // What the page holds, not what extensions are shown (only the current character).
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

/** @param {import('@playwright/test').Page} page */
async function openTagManagement(page) {
    await openCharacterManagementDrawer(page);
    await page.locator('.rm_tag_filter .manageTags:visible').first().click();
    await page.locator('#tag_view_list .tag_view_restore').waitFor({ state: 'visible', timeout: 10000 });
}

/**
 * Restores `backup` through the Manage Tags popup and waits for the result toast.
 * @param {import('@playwright/test').Page} page
 * @param {{ tags: object[], tag_map: Record<string, unknown> }} backup
 * @param {object} [options]
 * @param {boolean} [options.overwrite] Answers the prompt with "Overwrite" instead of "Keep Existing".
 */
async function restoreBackup(page, backup, { overwrite = false } = {}) {
    const chooserPromise = page.waitForEvent('filechooser');
    await page.locator('#tag_view_list .tag_view_restore').click();
    const chooser = await chooserPromise;
    await chooser.setFiles({ name: 'tags_backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    await page.locator('dialog.popup', { hasText: 'You have existing tags' }).locator(overwrite ? '.popup-button-ok' : '.popup-button-cancel').click();
    await expect(page.locator('.toast', { hasText: /Tags restored/ }).first()).toBeVisible({ timeout: 15000 });
}

/** @param {import('@playwright/test').Page} page @param {string} id @returns {Promise<any>} The stored tag, or undefined. */
async function serverTag(page, id) {
    return (await api(page, '/api/tags/by-ids', { ids: [id] })).tags.find(tag => tag.id === id);
}

/** @param {import('@playwright/test').Page} page @param {string} name @returns {Promise<{ id: string, color: string }[]>} */
async function pageTagsNamed(page, name) {
    return page.evaluate(async name => (await import('/scripts/tags.js')).tagsStore.getAll()
        .filter(tag => tag.name === name)
        .map(tag => ({ id: tag.id, color: tag.color })), name);
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

test.describe('Tag restore adds to what a character already has', () => {
    test.setTimeout(180000);

    test('a card this page has not loaded keeps its tags', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withSetupPage(browser, async (setup) => {
            const kept = await createTag(setup, `kept-${stamp}`);
            const added = await createTag(setup, `added-${stamp}`);
            const card = await createCharacter(setup, `TagRestoreUnloaded-${stamp}`);
            await api(setup, '/api/tags/assign', { id: card, tagId: kept });
            return { kept, added, card };
        });

        await hideChangesOf(page, fixture.card);
        await loadApp(page);
        expect(await residentTagsOf(page, fixture.card)).toBeNull();

        await openTagManagement(page);
        await restoreBackup(page, {
            tags: [tagDefinition(fixture.added, `added-${stamp}`)],
            tag_map: { [fixture.card]: [fixture.added] },
        });

        expect((await serverTagsOf(page, fixture.card)).sort()).toEqual([fixture.added, fixture.kept].sort());
    });

    test('a card this page holds an old copy of keeps the tag another tab gave it', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withSetupPage(browser, async (setup) => {
            const kept = await createTag(setup, `stale-kept-${stamp}`);
            const added = await createTag(setup, `stale-added-${stamp}`);
            const card = await createCharacter(setup, `TagRestoreStale-${stamp}`);
            return { kept, added, card };
        });

        await loadApp(page);
        expect(await residentTagsOf(page, fixture.card)).toEqual([]);

        await hideChangesOf(page, fixture.card);
        const other = await page.context().newPage();
        await loadApp(other);
        await api(other, '/api/tags/assign', { id: fixture.card, tagId: fixture.kept });
        await other.close();

        await openTagManagement(page);
        expect(await residentTagsOf(page, fixture.card)).toEqual([]);
        await restoreBackup(page, {
            tags: [tagDefinition(fixture.added, `stale-added-${stamp}`)],
            tag_map: { [fixture.card]: [fixture.added] },
        });

        const expected = [fixture.added, fixture.kept].sort();
        expect((await serverTagsOf(page, fixture.card)).sort()).toEqual(expected);
        // The page takes the server's result for the cards it holds.
        await expect.poll(() => residentTagsOf(page, fixture.card), { timeout: 15000 }).toEqual(expected);
    });

    test('the report names every key and tag that was not assigned', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withSetupPage(browser, async (setup) => {
            const added = await createTag(setup, `report-added-${stamp}`);
            const card = await createCharacter(setup, `TagRestoreReport-${stamp}`);
            return { added, card };
        });

        await loadApp(page);
        await openTagManagement(page);
        const missingKey = `TagRestoreMissing-${stamp}.png`;
        const undefinedTag = `tag-restore-undefined-${stamp}`;
        await restoreBackup(page, {
            tags: [tagDefinition(fixture.added, `report-added-${stamp}`)],
            tag_map: { [fixture.card]: [fixture.added, undefinedTag], [missingKey]: [fixture.added] },
        });

        await page.locator('.toast', { hasText: 'Tags restored with warnings' }).first().click();
        const report = page.locator('dialog.popup', { hasText: 'Tag Restore Warnings' });
        await expect(report).toContainText(`Tag map key ${missingKey} does not exist as character or group.`);
        await expect(report).toContainText(`Tag map key ${fixture.card}: not assigned, no such tag: "${undefinedTag}".`);
        expect(await serverTagsOf(page, fixture.card)).toEqual([fixture.added]);
    });
});

test.describe('Tag restore stores the backup\'s tag definitions', () => {
    test.setTimeout(180000);

    test('a tag only the backup has is stored by the restore and is there after a reload', async ({ browser, page }) => {
        const stamp = Date.now();
        const card = await withSetupPage(browser, setup => createCharacter(setup, `TagRestoreNewTag-${stamp}`));
        const id = `tag-restore-new-${stamp}`;
        const name = `new-${stamp}`;

        await loadApp(page);
        const wholeListSaves = [];
        page.on('request', request => { if (request.url().endsWith('/api/tags/save')) wholeListSaves.push(request.url()); });
        await openTagManagement(page);
        await restoreBackup(page, { tags: [{ ...tagDefinition(id, name), color: 'rgba(17, 34, 51, 1)' }], tag_map: { [card]: [id] } });

        expect((await serverTag(page, id)).color).toBe('rgba(17, 34, 51, 1)');
        expect(await serverTagsOf(page, card)).toEqual([id]);
        expect(await pageTagsNamed(page, name)).toEqual([{ id, color: 'rgba(17, 34, 51, 1)' }]);
        await expect.poll(() => residentTagsOf(page, card), { timeout: 15000 }).toEqual([id]);
        await expect(page.locator(`#tag_view_list .tag_view_item[id="${id}"]`)).toBeVisible();

        await page.reload();
        await loadApp(page);
        expect(await pageTagsNamed(page, name)).toEqual([{ id, color: 'rgba(17, 34, 51, 1)' }]);
        expect(await residentTagsOf(page, card)).toEqual([id]);
        expect(wholeListSaves).toEqual([]);
    });

    test('Overwrite: a backup tag named like an existing one updates that tag instead of adding a second', async ({ browser, page }) => {
        const stamp = Date.now();
        const name = `same-name-${stamp}`;
        const fixture = await withSetupPage(browser, async (setup) => {
            const existing = await createTag(setup, name);
            const tagged = await createCharacter(setup, `TagRestoreSameNameTagged-${stamp}`);
            const untagged = await createCharacter(setup, `TagRestoreSameNameUntagged-${stamp}`);
            await api(setup, '/api/tags/assign', { id: tagged, tagId: existing });
            return { existing, tagged, untagged };
        });
        const backupId = `tag-restore-backup-copy-${stamp}`;

        await loadApp(page);
        expect(await pageTagsNamed(page, `same-name-${stamp}`)).toEqual([{ id: fixture.existing, color: '' }]);
        await openTagManagement(page);
        await restoreBackup(page, {
            tags: [{ ...tagDefinition(backupId, `same-name-${stamp}`), color: 'rgba(68, 85, 102, 1)' }],
            tag_map: { [fixture.untagged]: [backupId] },
        }, { overwrite: true });

        expect(await serverTag(page, backupId)).toBeUndefined();
        expect((await serverTag(page, fixture.existing)).color).toBe('rgba(68, 85, 102, 1)');
        expect(await serverTagsOf(page, fixture.tagged)).toEqual([fixture.existing]);
        expect(await serverTagsOf(page, fixture.untagged)).toEqual([fixture.existing]);
        expect(await pageTagsNamed(page, `same-name-${stamp}`)).toEqual([{ id: fixture.existing, color: 'rgba(68, 85, 102, 1)' }]);
    });
});
