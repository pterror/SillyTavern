import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// Things upstream exports around tags that extensions can call: `renameTagKey` and `loadTagsSettings(settings)` from
// tags.js, `accountStorage.getState()`, and the `filter_state` field of a tag object. Upstream keeps all of it in the
// settings file. Here tags are the server's and a tag's filter is this browser's, so each is backed by that.

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

/** @param {import('@playwright/test').Page} page @param {string} key @returns {Promise<string[]>} */
async function serverTagsOf(page, key) {
    return [...(await api(page, '/api/tags/for', { ids: [key] }))[key] ?? []].sort();
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
 * @returns {string[]} every tag write the page sends from now on, as `path body`
 */
function recordWrites(page) {
    /** @type {string[]} */
    const writes = [];
    page.on('request', request => {
        const path = new URL(request.url()).pathname;
        if (/^\/api\/tags\/(create|edit|delete|assign|unassign|rename-key|restore)$/.test(path)) writes.push(`${path} ${request.postData()}`);
    });
    return writes;
}

/**
 * Runs `fn` in the page with the tags.js module, the way an extension module would use its exports.
 * @param {import('@playwright/test').Page} page
 * @param {string} fn Body of `async (tagsModule, arg, saveSettingsDebounced) => ...`
 * @param {any} [arg]
 */
async function withTagsModule(page, fn, arg) {
    return page.evaluate(async ({ fn, arg }) => {
        const tagsModule = await import('/scripts/tags.js');
        const { saveSettingsDebounced } = await import('/script.js');
        const AsyncFunction = Object.getPrototypeOf(async () => { }).constructor;
        return new AsyncFunction('tagsModule', 'arg', 'saveSettingsDebounced', fn)(tagsModule, arg, saveSettingsDebounced);
    }, { fn, arg });
}

/** @param {import('@playwright/test').Page} page @param {string} card @returns {Promise<string[]>} */
async function residentTagsOf(page, card) {
    return page.evaluate(async (card) => {
        const { charactersStore } = await import('/scripts/character-store.js');
        return [...charactersStore.get(card).tag_ids].sort();
    }, card);
}

/** @param {import('@playwright/test').Page} page @param {string} id @returns {Promise<string | undefined>} */
async function filterStateOf(page, id) {
    return withTagsModule(page, 'return tagsModule.tags.find(tag => tag.id === arg)?.filter_state;', id);
}

/**
 * Opens `avatar`: extensions are shown the tags of the current character (`tags`, D17).
 * @param {import('@playwright/test').Page} page @param {string} avatar @param {string[]} tagIds - shown once opened
 */
async function selectCharacter(page, avatar, tagIds) {
    await page.evaluate(async (avatar) => {
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect.poll(() => withTagsModule(page, 'return arg.filter(id => !tagsModule.tags.some(tag => tag.id === id));', tagIds)).toEqual([]);
}

/** @param {import('@playwright/test').Page} page @param {string} id @returns {Promise<string | null>} */
async function savedFilterOf(page, id) {
    return page.evaluate(id => localStorage.getItem(`CharacterList_tag_${id}`), id);
}

// Long enough for a request the page should not send to have shown up.
const NO_WRITE_SETTLE_MS = 1500;

test.describe('upstream tag exports', () => {
    test.setTimeout(180000);

    test('accountStorage.getState() is a copy of what getItem() reads', async ({ page }) => {
        await loadApp(page);

        const result = await page.evaluate(async () => {
            const { accountStorage } = await import('/scripts/util/AccountStorage.js');
            accountStorage.setItem('TagCompat_state_probe', 'one');
            const state = accountStorage.getState();
            const agrees = Object.entries(state).every(([key, value]) => accountStorage.getItem(key) === value);
            state.TagCompat_state_probe = 'changed';
            state.TagCompat_state_added = 'x';
            const result = {
                probe: accountStorage.getState().TagCompat_state_probe,
                agrees,
                cloneable: structuredClone(accountStorage.getState()).TagCompat_state_probe,
                untouched: accountStorage.getItem('TagCompat_state_probe'),
                notAdded: accountStorage.getItem('TagCompat_state_added'),
            };
            accountStorage.removeItem('TagCompat_state_probe');
            return { ...result, removed: Object.hasOwn(accountStorage.getState(), 'TagCompat_state_probe') };
        });
        expect(result).toEqual({ probe: 'one', agrees: true, cloneable: 'one', untouched: 'one', notAdded: null, removed: false });
    });

    test('renameTagKey moves what the server has for the old key onto the new key', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withOtherTab(browser, async (setup) => {
            const seen = await createTag(setup, `tagcompat-rename-seen-${stamp}`);
            const unseen = await createTag(setup, `tagcompat-rename-unseen-${stamp}`);
            const kept = await createTag(setup, `tagcompat-rename-kept-${stamp}`);
            const from = await createCharacter(setup, `TagCompatRenameFrom-${stamp}`);
            const to = await createCharacter(setup, `TagCompatRenameTo-${stamp}`);
            await api(setup, '/api/tags/assign', { id: from, tagId: seen });
            await api(setup, '/api/tags/assign', { id: to, tagId: kept });
            return { seen, unseen, kept, from, to };
        });
        await loadApp(page);
        // The current character is the one `tag_map` has an entry for.
        await page.evaluate(async (to) => {
            const { selectCharacterByAvatar } = await import('/script.js');
            await selectCharacterByAvatar(to);
        }, fixture.to);
        // Assigned after this page read the character, so its copy of the old key lacks it.
        await withOtherTab(browser, setup => api(setup, '/api/tags/assign', { id: fixture.from, tagId: fixture.unseen }));
        expect(await residentTagsOf(page, fixture.from)).toEqual([fixture.seen]);
        const writes = recordWrites(page);

        const returned = await page.evaluate(async ({ from, to }) => {
            window['__settingsUpdated'] = 0;
            const { eventSource, eventTypes } = window['SillyTavern'].getContext();
            eventSource.on(eventTypes.SETTINGS_UPDATED, () => { window['__settingsUpdated']++; });
            // A module that imports it by name loads only if tags.js exports it.
            const source = `import { renameTagKey } from "${location.origin}/scripts/tags.js"; export default renameTagKey;`;
            const { default: renameTagKey } = await import(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
            return String(renameTagKey(from, to));
        }, fixture);
        expect(returned).toBe('undefined');

        await expect.poll(() => serverTagsOf(page, fixture.to)).toEqual([fixture.seen, fixture.unseen, fixture.kept].sort());
        expect(await serverTagsOf(page, fixture.from)).toEqual([]);
        await expect.poll(() => residentTagsOf(page, fixture.to)).toEqual([fixture.seen, fixture.unseen, fixture.kept].sort());
        expect(await residentTagsOf(page, fixture.from)).toEqual([]);
        const mapped = await withTagsModule(page, 'return { from: tagsModule.tag_map[arg.from], to: [...tagsModule.tag_map[arg.to]].sort() };', fixture);
        expect(mapped).toEqual({ from: undefined, to: [fixture.seen, fixture.unseen, fixture.kept].sort() });
        expect(writes).toEqual([`/api/tags/rename-key ${JSON.stringify({ from: fixture.from, to: fixture.to })}`]);
        await expect.poll(() => page.evaluate(() => window['__settingsUpdated'])).toBeGreaterThanOrEqual(1);
    });

    test('renameTagKey to a key that is no character or group leaves the old key its tags and says so', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withOtherTab(browser, async (setup) => {
            const tag = await createTag(setup, `tagcompat-rename-nowhere-${stamp}`);
            const from = await createCharacter(setup, `TagCompatRenameNowhere-${stamp}`);
            await api(setup, '/api/tags/assign', { id: from, tagId: tag });
            return { tag, from };
        });
        await loadApp(page);

        await withTagsModule(page, 'tagsModule.renameTagKey(arg.from, `TagCompatNobody-${arg.from}`);', fixture);

        await expect(page.locator('#toast-container .toast-error')).toContainText('could not be moved');
        expect(await serverTagsOf(page, fixture.from)).toEqual([fixture.tag]);
        expect(await residentTagsOf(page, fixture.from)).toEqual([fixture.tag]);
    });

    test('loadTagsSettings(settings) takes in the given tags and adds the given tag_map', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withOtherTab(browser, async (setup) => {
            const had = await createTag(setup, `tagcompat-load-had-${stamp}`);
            const leftOut = await createTag(setup, `tagcompat-load-leftout-${stamp}`);
            const card = await createCharacter(setup, `TagCompatLoad-${stamp}`);
            await api(setup, '/api/tags/assign', { id: card, tagId: leftOut });
            return { had, leftOut, card, added: `tagcompat-load-added-${stamp}` };
        });
        await loadApp(page);
        await selectCharacter(page, fixture.card, [fixture.leftOut]);
        const writes = recordWrites(page);

        const atOnce = await withTagsModule(page, `
            const given = tagsModule.tags.filter(tag => tag.id !== arg.leftOut);
            given.push({ id: arg.added, name: arg.added, folder_type: 'NONE', color: '#445566' });
            const returned = tagsModule.loadTagsSettings({ tags: given, tag_map: { [arg.card]: [arg.had, arg.added] } });
            const atOnce = {
                isPromise: typeof returned?.then === 'function',
                holdsAdded: tagsModule.tags.some(tag => tag.id === arg.added),
                sameArray: tagsModule.tags === window['SillyTavern'].getContext().tags,
            };
            await returned;
            return atOnce;
        `, fixture);
        expect(atOnce).toEqual({ isPromise: true, holdsAdded: true, sameArray: true });

        await expect.poll(() => serverTag(page, fixture.added)).toMatchObject({ id: fixture.added, color: '#445566' });
        // The character keeps the tag the given map didn't name, and gains the two it did.
        await expect.poll(() => serverTagsOf(page, fixture.card)).toEqual([fixture.had, fixture.leftOut, fixture.added].sort());
        // The tag the given list left out is still a tag, here and on the server.
        expect(await serverTag(page, fixture.leftOut)).not.toBeNull();
        expect(await withTagsModule(page, 'return tagsModule.tags.some(tag => tag.id === arg);', fixture.leftOut)).toBe(true);
        expect(writes.filter(w => w.startsWith('/api/tags/delete') || w.startsWith('/api/tags/unassign'))).toEqual([]);
        expect(writes.map(w => w.split(' ')[0]).sort()).toEqual(['/api/tags/assign', '/api/tags/assign', '/api/tags/create']);
    });

    test('a tag\'s filter_state is the filter this browser saved for it, not what the stored tag carries', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withOtherTab(browser, async (setup) => {
            // As a tag saved by upstream, or by another browser, carries it.
            const tag = await createTag(setup, `tagcompat-filter-${stamp}`, { filter_state: 'EXCLUDED' });
            const card = await createCharacter(setup, `TagCompatFilter-${stamp}`);
            await api(setup, '/api/tags/assign', { id: card, tagId: tag });
            return { tag, card };
        });
        await loadApp(page);
        await selectCharacter(page, fixture.card, [fixture.tag]);
        expect(await filterStateOf(page, fixture.tag)).toBe('UNDEFINED');
        // The bar reads the used tags once it is on screen and shows them.
        await openCharacterManagementDrawer(page);
        const showTags = page.locator('#rm_characters_block .rm_tag_filter .showTagList');
        if (!(await showTags.evaluate(el => el.classList.contains('selected')))) await showTags.click();
        const writes = recordWrites(page);

        await page.locator(`#rm_characters_block .rm_tag_filter [id="${fixture.tag}"]`).click();
        await expect.poll(() => filterStateOf(page, fixture.tag)).toBe('SELECTED');
        expect(await savedFilterOf(page, fixture.tag)).toBe('SELECTED');

        await page.reload();
        await loadApp(page);
        await selectCharacter(page, fixture.card, [fixture.tag]);
        expect(await filterStateOf(page, fixture.tag)).toBe('SELECTED');
        await expect(page.locator(`#rm_characters_block .rm_tag_filter [id="${fixture.tag}"]`)).toHaveClass(/selected/);
        // The stored tag is every browser's: the click changed nothing on it.
        expect((await serverTag(page, fixture.tag)).filter_state).toBe('EXCLUDED');
        expect(writes).toEqual([]);
    });

    test('filter_state set on a tag object becomes the tag\'s filter once a settings save is asked for', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withOtherTab(browser, async (setup) => {
            const tag = await createTag(setup, `tagcompat-filterset-${stamp}`);
            const card = await createCharacter(setup, `TagCompatFilterSet-${stamp}`);
            await api(setup, '/api/tags/assign', { id: card, tagId: tag });
            return { tag, card };
        });
        await loadApp(page);
        await selectCharacter(page, fixture.card, [fixture.tag]);
        const writes = recordWrites(page);

        await withTagsModule(page, `
            tagsModule.tags.find(tag => tag.id === arg).filter_state = 'EXCLUDED';
            saveSettingsDebounced();
        `, fixture.tag);

        await expect.poll(() => savedFilterOf(page, fixture.tag)).toBe('EXCLUDED');
        await expect(page.locator(`#rm_characters_block .rm_tag_filter [id="${fixture.tag}"]`)).toHaveClass(/excluded/);
        await expect(page.locator(`#rm_print_characters_block .character_select[data-avatar="${fixture.card}"]`)).toHaveCount(0);

        await page.waitForTimeout(NO_WRITE_SETTLE_MS);
        expect(writes).toEqual([]);
        expect(Object.hasOwn(await serverTag(page, fixture.tag), 'filter_state')).toBe(false);

        await page.reload();
        await loadApp(page);
        await selectCharacter(page, fixture.card, [fixture.tag]);
        expect(await filterStateOf(page, fixture.tag)).toBe('EXCLUDED');
    });

    test('a tag the page creates is stored without a filter_state', async ({ browser, page }) => {
        const stamp = Date.now();
        const tagName = `tagcompat-created-${stamp}`;
        const charName = `TagCompatCreated-${stamp}`;
        await withOtherTab(browser, setup => createCharacter(setup, charName));
        await loadApp(page);

        const id = await withTagsModule(page, `
            const context = window['SillyTavern'].getContext();
            await context.executeSlashCommandsWithOptions('/tag-add name="' + arg.charName + '" ' + arg.tagName);
            return tagsModule.tagsStore.getAll().find(tag => tag.name === arg.tagName)?.id;
        `, { charName, tagName });

        expect(typeof id).toBe('string');
        await expect.poll(() => serverTag(page, id)).toMatchObject({ id, name: tagName });
        expect(Object.hasOwn(await serverTag(page, id), 'filter_state')).toBe(false);
        // No filter is saved for it in this browser.
        expect(await savedFilterOf(page, id)).toBeNull();
    });
});

test.describe('what the tags export holds', () => {
    test('the current character\'s tags, not every tag the page holds', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withOtherTab(browser, async (setup) => {
            const mine = await createTag(setup, `tagcompat-d17-mine-${stamp}`);
            const other = await createTag(setup, `tagcompat-d17-other-${stamp}`);
            const card = await createCharacter(setup, `TagCompatD17-${stamp}`);
            const otherCard = await createCharacter(setup, `TagCompatD17Other-${stamp}`);
            await api(setup, '/api/tags/assign', { id: card, tagId: mine });
            await api(setup, '/api/tags/assign', { id: otherCard, tagId: other });
            return { mine, other, card, otherCard };
        });
        await loadApp(page);
        await selectCharacter(page, fixture.otherCard, [fixture.other]);
        await selectCharacter(page, fixture.card, [fixture.mine]);

        const seen = await withTagsModule(page, `
            const ids = window['SillyTavern'].getContext().tags.map(tag => tag.id);
            return { mine: ids.includes(arg.mine), other: ids.includes(arg.other) };
        `, fixture);
        expect(seen).toEqual({ mine: true, other: false });
    });
});
