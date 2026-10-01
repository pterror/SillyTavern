import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// `tags` is an upstream export of tags.js that extensions push to, splice and edit in place, and upstream stores it
// with the settings. The page holds a tag only while something on screen shows it, so the tests open a character
// carrying the tags they look at. Here a tag put in is created on the server as soon as a settings save is asked for, and a
// changed field is stored with the save itself, each as its own request about that one tag. A tag taken out is put
// back and named in a warning.

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

/** @param {import('@playwright/test').Page} page @param {string} id @param {object} [fields] */
async function createTag(page, id, fields = {}) {
    await api(page, '/api/tags/create', {
        tag: {
            id, name: id, folder_type: 'NONE', sort_order: 1000,
            is_hidden_on_character_card: false, color: '', color2: '', create_date: 1, ...fields,
        },
    });
    return id;
}

/**
 * @param {import('@playwright/test').Page} page @param {string} id
 * @returns {Promise<object | null>} the tag as the server stores it
 */
async function serverTag(page, id) {
    return (await api(page, '/api/tags/by-ids', { ids: [id] })).tags.find(tag => tag.id === id) ?? null;
}

/**
 * Runs `fn` from a throwaway browser context, the way another tab would.
 * @param {import('@playwright/test').Browser} browser
 * @param {(page: import('@playwright/test').Page) => Promise<T>} fn
 * @template T
 */
async function withOtherTab(browser, fn) {
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
 * @param {import('@playwright/test').Page} page
 * @returns {{ sent: string[], answered: string[] }} every tag write the page makes from now on, as `path body`, in
 *   the order sent and in the order answered
 */
function recordWrites(page) {
    const log = { sent: /** @type {string[]} */ ([]), answered: /** @type {string[]} */ ([]) };
    const isTagWrite = (/** @type {import('@playwright/test').Request} */ request) =>
        /^\/api\/tags\/(create|edit|delete|assign|unassign|assign-many|restore)$/.test(new URL(request.url()).pathname);
    const line = (/** @type {import('@playwright/test').Request} */ request) => `${new URL(request.url()).pathname} ${request.postData()}`;
    page.on('request', request => { if (isTagWrite(request)) log.sent.push(line(request)); });
    page.on('requestfinished', request => { if (isTagWrite(request)) log.answered.push(line(request)); });
    return log;
}

/**
 * Runs `fn` in the page with the exported `tags` and `tag_map`, the way an extension module would use them.
 * @param {import('@playwright/test').Page} page
 * @param {string} fn Body of `async (tags, tag_map, arg, saveSettingsDebounced) => ...`
 * @param {any} [arg]
 */
async function withTags(page, fn, arg) {
    return page.evaluate(async ({ fn, arg }) => {
        const { tags, tag_map } = await import('/scripts/tags.js');
        const { saveSettingsDebounced } = await import('/script.js');
        const AsyncFunction = Object.getPrototypeOf(async () => { }).constructor;
        return new AsyncFunction('tags', 'tag_map', 'arg', 'saveSettingsDebounced', fn)(tags, tag_map, arg, saveSettingsDebounced);
    }, { fn, arg });
}

/** @param {import('@playwright/test').Page} page */
async function saveSettingsNow(page) {
    await page.evaluate(async () => {
        const { saveSettings } = await import('/script.js');
        await saveSettings();
    });
}

/** @param {import('@playwright/test').Page} page @returns {Promise<string[]>} ids of the tags the page holds */
async function heldTagIds(page) {
    return withTags(page, 'return tags.map(tag => tag.id);');
}

/**
 * Makes a character carrying `tagIds` from another tab, before the page loads. The page holds a tag only while
 * something on screen shows it, so selectHolder() then opens that character to have the page hold them.
 * @param {import('@playwright/test').Browser} browser
 * @param {string[]} tagIds
 * @returns {Promise<string>} the character's avatar
 */
async function createHolder(browser, tagIds) {
    return withOtherTab(browser, async (setup) => {
        const card = await createCharacter(setup, `TagsExpHolder-${Date.now()}`);
        for (const tagId of tagIds) await api(setup, '/api/tags/assign', { id: card, tagId });
        return card;
    });
}

/**
 * Opens `card` and waits until the page holds `tagIds`.
 * @param {import('@playwright/test').Page} page @param {string} card @param {string[]} tagIds
 */
async function selectHolder(page, card, tagIds) {
    await page.evaluate(async (card) => {
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(card);
    }, card);
    await expect.poll(async () => {
        const held = await heldTagIds(page);
        return tagIds.filter(id => !held.includes(id));
    }).toEqual([]);
}

// Long enough for a request the page should not send to have shown up.
const NO_WRITE_SETTLE_MS = 1500;

test.describe('the tags export', () => {
    test.setTimeout(180000);

    test('is one array, the same one context hands out', async ({ browser, page }) => {
        const stamp = Date.now();
        const id = await withOtherTab(browser, setup => createTag(setup, `tagsexp-same-${stamp}`));
        const card = await createHolder(browser, [id]);
        await loadApp(page);
        await selectHolder(page, card, [id]);

        const result = await withTags(page, `
            const context = window['SillyTavern'].getContext();
            return {
                same: context.tags === tags,
                isArray: Array.isArray(tags),
                holds: tags.some(tag => tag.id === arg),
                json: JSON.parse(JSON.stringify(tags)).some(tag => tag.id === arg),
            };
        `, id);
        expect(result).toEqual({ same: true, isArray: true, holds: true, json: true });
    });

    test('a pushed tag is created on the server once a settings save is asked for', async ({ page }) => {
        const stamp = Date.now();
        const id = `tagsexp-push-${stamp}`;
        await loadApp(page);
        const writes = recordWrites(page);

        await withTags(page, `
            window['__settingsUpdated'] = 0;
            const { eventSource, eventTypes } = window['SillyTavern'].getContext();
            eventSource.on(eventTypes.SETTINGS_UPDATED, () => { window['__settingsUpdated']++; });
            tags.push({ id: arg, name: arg, color: '#112233', color2: '', folder_type: 'NONE' });
            // Found by id before it has been taken in.
            window['__foundAtOnce'] = window['SillyTavern'].getContext().getTagById(arg)?.id;
            saveSettingsDebounced();
        `, id);

        await expect.poll(() => serverTag(page, id)).toMatchObject({ id, name: id, color: '#112233' });
        expect(writes.sent.filter(w => !w.includes(id))).toEqual([]);
        expect(writes.sent.map(w => w.split(' ')[0])).toEqual(['/api/tags/create']);
        expect(await page.evaluate(() => window['__foundAtOnce'])).toBe(id);
        // The settings save asked for may emit it as well.
        await expect.poll(() => page.evaluate(() => window['__settingsUpdated'])).toBeGreaterThanOrEqual(1);
        // The server gave it a sort_order, and the page's copy has it.
        const stored = await serverTag(page, id);
        expect(typeof stored.sort_order).toBe('number');
        await expect.poll(() => withTags(page, 'return tags.find(tag => tag.id === arg)?.sort_order;', id)).toBe(stored.sort_order);

        // Nothing more is sent for it by a later settings save.
        await saveSettingsNow(page);
        await page.waitForTimeout(NO_WRITE_SETTLE_MS);
        expect(writes.sent.length).toBe(1);

        await page.reload();
        await loadApp(page);
        expect(await serverTag(page, id)).toMatchObject({ id, name: id, color: '#112233' });
    });

    test('a tag pushed and assigned in one turn is created before it is assigned', async ({ browser, page }) => {
        const stamp = Date.now();
        const id = `tagsexp-order-${stamp}`;
        const card = await withOtherTab(browser, setup => createCharacter(setup, `TagsExpOrder-${stamp}`));
        await loadApp(page);
        // The current character is the one `tag_map` has an entry for.
        await page.evaluate(async (card) => {
            const { selectCharacterByAvatar } = await import('/script.js');
            await selectCharacterByAvatar(card);
        }, card);
        await expect.poll(() => page.evaluate(card => Object.hasOwn(window['SillyTavern'].getContext().tagMap, card), card)).toBe(true);
        const writes = recordWrites(page);

        await withTags(page, `
            (tag_map[arg.card] ||= []).push(arg.id);
            tags.push({ id: arg.id, name: arg.id, folder_type: 'NONE' });
        `, { card, id });

        await expect.poll(async () => (await api(page, '/api/tags/for', { ids: [card] }))[card]).toEqual([id]);
        expect(writes.answered.map(w => w.split(' ')[0])).toEqual(['/api/tags/create', '/api/tags/assign']);
        // The assign was not sent until the create had been answered.
        expect(writes.sent.map(w => w.split(' ')[0])).toEqual(['/api/tags/create', '/api/tags/assign']);
        expect(await serverTag(page, id)).toMatchObject({ id });
    });

    test('a changed field is stored with the next settings save, as an edit of that field', async ({ browser, page }) => {
        const stamp = Date.now();
        const id = await withOtherTab(browser, setup => createTag(setup, `tagsexp-edit-${stamp}`, { color: '#aaaaaa' }));
        const card = await createHolder(browser, [id]);
        await loadApp(page);
        await selectHolder(page, card, [id]);
        // Another tab renames it; this tab's copy keeps the old name.
        await withOtherTab(browser, other => api(other, '/api/tags/edit', { id, patch: { name: 'renamed elsewhere' } }));
        const writes = recordWrites(page);

        await withTags(page, 'tags.find(tag => tag.id === arg).color = \'#123456\';', id);
        await saveSettingsNow(page);

        await expect.poll(async () => (await serverTag(page, id)).color).toBe('#123456');
        expect(writes.sent).toEqual([`/api/tags/edit ${JSON.stringify({ id, patch: { color: '#123456' } })}`]);
        expect((await serverTag(page, id)).name).toBe('renamed elsewhere');

        // Stored once: the next save sends nothing.
        await saveSettingsNow(page);
        await page.waitForTimeout(NO_WRITE_SETTLE_MS);
        expect(writes.sent.length).toBe(1);
    });

    test('a tag taken out is not deleted: it is put back and named in a warning', async ({ browser, page }) => {
        const stamp = Date.now();
        const id = await withOtherTab(browser, setup => createTag(setup, `tagsexp-out-${stamp}`));
        const card = await createHolder(browser, [id]);
        await loadApp(page);
        await selectHolder(page, card, [id]);
        const writes = recordWrites(page);

        await withTags(page, 'tags.splice(tags.findIndex(tag => tag.id === arg), 1);', id);
        await saveSettingsNow(page);
        await page.waitForTimeout(NO_WRITE_SETTLE_MS);

        expect(writes.sent).toEqual([]);
        expect(await serverTag(page, id)).toMatchObject({ id });
        expect(await heldTagIds(page)).toContain(id);
        await expect(page.locator('.toast-warning', { hasText: id })).toBeVisible();
    });

    test('a tag taken out and put back in one turn sends nothing and warns of nothing', async ({ browser, page }) => {
        const stamp = Date.now();
        const id = await withOtherTab(browser, setup => createTag(setup, `tagsexp-back-${stamp}`));
        const card = await createHolder(browser, [id]);
        await loadApp(page);
        await selectHolder(page, card, [id]);
        const writes = recordWrites(page);

        await withTags(page, `
            const [tag] = tags.splice(tags.findIndex(tag => tag.id === arg), 1);
            tags.push(tag);
        `, id);
        await saveSettingsNow(page);
        await page.waitForTimeout(NO_WRITE_SETTLE_MS);

        expect(writes.sent).toEqual([]);
        expect((await heldTagIds(page)).filter(held => held === id)).toEqual([id]);
        await expect(page.locator('.toast-warning', { hasText: id })).toHaveCount(0);
    });

    test('clearing the array and putting the same tags back sends nothing', async ({ browser, page }) => {
        const stamp = Date.now();
        await withOtherTab(browser, setup => createTag(setup, `tagsexp-same-refill-${stamp}`));
        await loadApp(page);
        const before = await heldTagIds(page);
        const writes = recordWrites(page);

        await withTags(page, `
            const copy = tags.map(tag => ({ ...tag }));
            tags.length = 0;
            for (const tag of copy) tags.push(tag);
        `);
        await saveSettingsNow(page);
        await page.waitForTimeout(NO_WRITE_SETTLE_MS);

        expect(writes.sent).toEqual([]);
        expect(await heldTagIds(page)).toEqual(before);
    });

    test('a clear and refill creates what is new, edits what changed and keeps what it left out', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withOtherTab(browser, async (setup) => ({
            same: await createTag(setup, `tagsexp-refill-same-${stamp}`),
            changed: await createTag(setup, `tagsexp-refill-changed-${stamp}`, { color: '#aaaaaa', sort_order: 77 }),
            leftOut: await createTag(setup, `tagsexp-refill-leftout-${stamp}`),
            added: `tagsexp-refill-added-${stamp}`,
        }));
        const card = await createHolder(browser, [fixture.same, fixture.changed, fixture.leftOut]);
        await loadApp(page);
        await selectHolder(page, card, [fixture.same, fixture.changed, fixture.leftOut]);
        const elsewhere = await withOtherTab(browser, other => createTag(other, `tagsexp-refill-elsewhere-${stamp}`));
        const writes = recordWrites(page);

        // The refill's objects carry only some fields, as a backup written by an extension does.
        await withTags(page, `
            const refill = tags
                .filter(tag => tag.id !== arg.leftOut)
                .map(tag => ({ id: tag.id, name: tag.name, color: tag.id === arg.changed ? '#bbbbbb' : tag.color, color2: tag.color2, folder_type: tag.folder_type }));
            refill.push({ id: arg.added, name: arg.added, color: '', color2: '', folder_type: 'NONE' });
            tags.length = 0;
            for (const tag of refill) tags.push(tag);
        `, fixture);
        await saveSettingsNow(page);

        await expect.poll(async () => (await serverTag(page, fixture.changed))?.color).toBe('#bbbbbb');
        expect(await serverTag(page, fixture.leftOut)).toMatchObject({ id: fixture.leftOut });
        expect(await heldTagIds(page)).toContain(fixture.leftOut);
        await expect(page.locator('.toast-warning', { hasText: fixture.leftOut })).toBeVisible();
        expect(await serverTag(page, fixture.added)).toMatchObject({ id: fixture.added });
        // A field the refill's objects don't carry is kept on the server, and comes back onto the page's copy.
        expect((await serverTag(page, fixture.changed)).sort_order).toBe(77);
        await expect.poll(() => withTags(page, 'return tags.find(tag => tag.id === arg)?.sort_order;', fixture.changed)).toBe(77);
        expect(await serverTag(page, fixture.same)).toMatchObject({ id: fixture.same });
        expect(await serverTag(page, elsewhere)).toMatchObject({ id: elsewhere });

        await page.waitForTimeout(NO_WRITE_SETTLE_MS);
        expect([...writes.sent].sort()).toEqual([
            `/api/tags/create ${JSON.stringify({ tag: { id: fixture.added, name: fixture.added, color: '', color2: '', folder_type: 'NONE' } })}`,
            `/api/tags/edit ${JSON.stringify({ id: fixture.changed, patch: { color: '#bbbbbb' } })}`,
        ].sort());
    });
});
