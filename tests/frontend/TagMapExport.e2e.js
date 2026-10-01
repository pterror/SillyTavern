import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// `tag_map` is an upstream export of tags.js that extensions import, read and write. Here it covers the
// characters and groups extensions are shown (the current character, or the open group and its members), and a
// write to it reaches the server as assigns and unassigns. A key added
// or deleted is found when a settings save is asked for, which is what upstream's extensions do after a write.

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

/** @param {import('@playwright/test').Page} page @param {string} id */
async function createTag(page, id) {
    await api(page, '/api/tags/create', {
        tag: {
            id, name: id, folder_type: 'NONE', filter_state: 'UNDEFINED', sort_order: 1000,
            is_hidden_on_character_card: false, color: '', color2: '', create_date: Date.now(),
        },
    });
    return id;
}

/** @param {import('@playwright/test').Page} page @param {string} key @returns {Promise<string[]>} */
async function serverTagsOf(page, key) {
    return [...(await api(page, '/api/tags/for', { ids: [key] }))[key] ?? []].sort();
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
 * Keeps `avatar` from ever reaching the page, so the page doesn't hold it.
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function hideCharacter(page, avatar) {
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
 * Makes the character the current one, which is what gives it a `tag_map` entry.
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function selectCharacter(page, avatar) {
    await page.evaluate(async (avatar) => {
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect.poll(() => page.evaluate(() => window['SillyTavern'].getContext().characterAvatar)).toBe(avatar);
    await expect.poll(() => page.evaluate(avatar => Object.hasOwn((window['SillyTavern'].getContext().tagMap), avatar), avatar)).toBe(true);
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {string[]} every tag assignment write the page sends from now on, as `path body`
 */
function recordWrites(page) {
    /** @type {string[]} */
    const writes = [];
    page.on('request', request => {
        const path = new URL(request.url()).pathname;
        if (/^\/api\/tags\/(assign|unassign|assign-many)$/.test(path)) writes.push(`${path} ${request.postData()}`);
    });
    return writes;
}

/**
 * Runs `fn` in the page with the exported `tag_map`, the way an extension module would use it.
 * @param {import('@playwright/test').Page} page
 * @param {string} fn Body of `(tag_map, arg, saveSettingsDebounced) => ...`
 * @param {any} [arg]
 */
async function withTagMap(page, fn, arg) {
    return page.evaluate(async ({ fn, arg }) => {
        const { tag_map } = await import('/scripts/tags.js');
        const { saveSettingsDebounced } = await import('/script.js');
        return new Function('tag_map', 'arg', 'saveSettingsDebounced', fn)(tag_map, arg, saveSettingsDebounced);
    }, { fn, arg });
}

// Long enough for a request the page should not send to have shown up.
const NO_WRITE_SETTLE_MS = 1500;

test.describe('the tag_map export', () => {
    test.setTimeout(180000);

    test('is one object, the same one context hands out, and has entries only for the characters extensions are shown', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withSetupPage(browser, async (setup) => {
            const tag = await createTag(setup, `tagmap-read-${stamp}`);
            const tagged = await createCharacter(setup, `TagMapRead-${stamp}`);
            const untagged = await createCharacter(setup, `TagMapReadBare-${stamp}`);
            await api(setup, '/api/tags/assign', { id: tagged, tagId: tag });
            return { tag, tagged, untagged };
        });
        await loadApp(page);
        await selectCharacter(page, fixture.tagged);

        const seen = await page.evaluate(async ({ tagged, untagged }) => {
            const { tag_map } = await import('/scripts/tags.js');
            const context = window['SillyTavern'].getContext();
            return {
                same: tag_map === context.tagMap && context.tagMap === window['SillyTavern'].getContext().tagMap,
                tagged: [...tag_map[tagged]],
                isArray: Array.isArray(tag_map[tagged]),
                untagged: tag_map[untagged],
                missing: tag_map['no-such-character.png'],
                keys: Object.keys(tag_map),
                entry: Object.entries(tag_map).find(([key]) => key === tagged)?.[1],
                json: JSON.parse(JSON.stringify(tag_map))[tagged],
            };
        }, fixture);

        expect(seen.same).toBe(true);
        expect(seen.tagged).toEqual([fixture.tag]);
        expect(seen.isArray).toBe(true);
        // Held by the page, but not the current character: extensions are not shown it.
        expect(seen.untagged).toBeUndefined();
        expect(seen.missing).toBeUndefined();
        expect(seen.keys).toEqual([fixture.tagged]);
        expect(seen.entry).toEqual([fixture.tag]);
        expect(seen.json).toEqual([fixture.tag]);
    });

    test('a module importing it by name loads', async ({ page }) => {
        await loadApp(page);
        await page.evaluate(() => {
            const script = document.createElement('script');
            script.type = 'module';
            script.textContent = 'import { tags, tag_map, removeTagFromEntity } from "/scripts/tags.js"; window["__tagMapImport"] = [Array.isArray(tags), typeof tag_map, typeof removeTagFromEntity];';
            document.head.append(script);
        });
        await expect.poll(() => page.evaluate(() => window['__tagMapImport'])).toEqual([true, 'object', 'function']);
    });

    test('a push into an entry is stored by one assign', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withSetupPage(browser, async (setup) => {
            const had = await createTag(setup, `tagmap-push-had-${stamp}`);
            const pushed = await createTag(setup, `tagmap-push-new-${stamp}`);
            const card = await createCharacter(setup, `TagMapPush-${stamp}`);
            await api(setup, '/api/tags/assign', { id: card, tagId: had });
            return { had, pushed, card };
        });
        await loadApp(page);
        await selectCharacter(page, fixture.card);
        const writes = recordWrites(page);

        await withTagMap(page, `
            tag_map[arg.card] ||= [];
            if (!tag_map[arg.card].includes(arg.pushed)) tag_map[arg.card].push(arg.pushed);
            if (!tag_map[arg.card].includes(arg.pushed)) tag_map[arg.card].push(arg.pushed);
        `, fixture);

        await expect.poll(() => serverTagsOf(page, fixture.card)).toEqual([fixture.had, fixture.pushed].sort());
        expect(writes).toEqual([`/api/tags/assign ${JSON.stringify({ id: fixture.card, tagId: fixture.pushed })}`]);
        const resident = await page.evaluate(card => [...window['SillyTavern'].getContext().characters.find(c => c.avatar === card).tag_ids].sort(), fixture.card);
        expect(resident).toEqual([fixture.had, fixture.pushed].sort());
    });

    test('a write survives the reload an extension starts right after it', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withSetupPage(browser, async (setup) => {
            const pushed = await createTag(setup, `tagmap-reload-${stamp}`);
            const card = await createCharacter(setup, `TagMapReload-${stamp}`);
            return { pushed, card };
        });
        await loadApp(page);
        await selectCharacter(page, fixture.card);

        await page.evaluate(async ({ card, pushed }) => {
            const { tag_map } = await import('/scripts/tags.js');
            const { getCharacters } = await import('/script.js');
            tag_map[card].push(pushed);
            await getCharacters();
        }, fixture);

        await expect.poll(() => serverTagsOf(page, fixture.card)).toEqual([fixture.pushed]);
        const resident = await page.evaluate(card => [...window['SillyTavern'].getContext().characters.find(c => c.avatar === card).tag_ids], fixture.card);
        expect(resident).toEqual([fixture.pushed]);
    });

    test('replacing an entry sends only what changed', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withSetupPage(browser, async (setup) => {
            const stays = await createTag(setup, `tagmap-set-stays-${stamp}`);
            const goes = await createTag(setup, `tagmap-set-goes-${stamp}`);
            const card = await createCharacter(setup, `TagMapSet-${stamp}`);
            await api(setup, '/api/tags/assign', { id: card, tagId: stays });
            await api(setup, '/api/tags/assign', { id: card, tagId: goes });
            return { stays, goes, card };
        });
        await loadApp(page);
        await selectCharacter(page, fixture.card);
        const writes = recordWrites(page);

        await withTagMap(page, 'tag_map[arg.card] = tag_map[arg.card].filter(id => id !== arg.goes);', fixture);

        await expect.poll(() => serverTagsOf(page, fixture.card)).toEqual([fixture.stays]);
        expect(writes).toEqual([`/api/tags/unassign ${JSON.stringify({ id: fixture.card, tagId: fixture.goes })}`]);
    });

    test('clearing every entry and putting the same ones back sends nothing', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withSetupPage(browser, async (setup) => {
            const tag = await createTag(setup, `tagmap-same-${stamp}`);
            const card = await createCharacter(setup, `TagMapSame-${stamp}`);
            await api(setup, '/api/tags/assign', { id: card, tagId: tag });
            return { tag, card };
        });
        await loadApp(page);
        const writes = recordWrites(page);

        await withTagMap(page, `
            const copy = JSON.parse(JSON.stringify(tag_map));
            Object.keys(tag_map).forEach(key => delete tag_map[key]);
            Object.assign(tag_map, copy);
            saveSettingsDebounced();
        `);

        await page.waitForTimeout(NO_WRITE_SETTLE_MS);
        expect(writes).toEqual([]);
        expect(await serverTagsOf(page, fixture.card)).toEqual([fixture.tag]);
    });

    test('an entry deleted and given back with other tags sends only the difference', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withSetupPage(browser, async (setup) => {
            const stays = await createTag(setup, `tagmap-back-stays-${stamp}`);
            const goes = await createTag(setup, `tagmap-back-goes-${stamp}`);
            const comes = await createTag(setup, `tagmap-back-comes-${stamp}`);
            const card = await createCharacter(setup, `TagMapBack-${stamp}`);
            await api(setup, '/api/tags/assign', { id: card, tagId: stays });
            await api(setup, '/api/tags/assign', { id: card, tagId: goes });
            return { stays, goes, comes, card };
        });
        await loadApp(page);
        await selectCharacter(page, fixture.card);
        const writes = recordWrites(page);

        await withTagMap(page, `
            delete tag_map[arg.card];
            tag_map[arg.card] = [arg.stays, arg.comes];
            saveSettingsDebounced();
        `, fixture);

        await expect.poll(() => serverTagsOf(page, fixture.card)).toEqual([fixture.stays, fixture.comes].sort());
        expect([...writes].sort()).toEqual([
            `/api/tags/assign ${JSON.stringify({ id: fixture.card, tagId: fixture.comes })}`,
            `/api/tags/unassign ${JSON.stringify({ id: fixture.card, tagId: fixture.goes })}`,
        ].sort());
    });

    test('a change to an array kept from an earlier turn is sent when a settings save is asked for', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withSetupPage(browser, async (setup) => {
            const pushed = await createTag(setup, `tagmap-kept-${stamp}`);
            const card = await createCharacter(setup, `TagMapKept-${stamp}`);
            return { pushed, card };
        });
        await loadApp(page);
        await selectCharacter(page, fixture.card);
        const writes = recordWrites(page);

        await page.evaluate(async ({ card, pushed }) => {
            const { tag_map } = await import('/scripts/tags.js');
            const { saveSettingsDebounced } = await import('/script.js');
            const kept = tag_map[card];
            await new Promise(resolve => setTimeout(resolve, 50));
            kept.push(pushed);
            saveSettingsDebounced();
        }, fixture);

        await expect.poll(() => serverTagsOf(page, fixture.card)).toEqual([fixture.pushed]);
        expect(writes).toEqual([`/api/tags/assign ${JSON.stringify({ id: fixture.card, tagId: fixture.pushed })}`]);
    });

    test('deleting the current character\'s entry unassigns its tags', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withSetupPage(browser, async (setup) => {
            const tag = await createTag(setup, `tagmap-delete-${stamp}`);
            const card = await createCharacter(setup, `TagMapDelete-${stamp}`);
            await api(setup, '/api/tags/assign', { id: card, tagId: tag });
            return { tag, card };
        });
        await loadApp(page);
        await selectCharacter(page, fixture.card);

        await withTagMap(page, 'delete tag_map[arg.card]; saveSettingsDebounced();', fixture);

        await expect.poll(() => serverTagsOf(page, fixture.card)).toEqual([]);
        // It is still the current character, so it has an entry again.
        expect(await withTagMap(page, 'return tag_map[arg.card];', fixture)).toEqual([]);
    });

    test('a write for a character the page does not hold only adds', async ({ browser, page }) => {
        const stamp = Date.now();
        const fixture = await withSetupPage(browser, async (setup) => {
            const kept = await createTag(setup, `tagmap-unheld-kept-${stamp}`);
            const added = await createTag(setup, `tagmap-unheld-added-${stamp}`);
            const card = await createCharacter(setup, `TagMapUnheld-${stamp}`);
            await api(setup, '/api/tags/assign', { id: card, tagId: kept });
            return { kept, added, card };
        });
        await hideCharacter(page, fixture.card);
        await loadApp(page);
        const writes = recordWrites(page);

        const before = await withTagMap(page, 'return tag_map[arg.card];', fixture);
        expect(before).toBeUndefined();

        const readBack = await withTagMap(page, 'tag_map[arg.card] = [arg.added]; saveSettingsDebounced(); return [...tag_map[arg.card]];', fixture);
        expect(readBack).toEqual([fixture.added]);
        await expect.poll(() => serverTagsOf(page, fixture.card)).toEqual([fixture.kept, fixture.added].sort());

        await withTagMap(page, 'delete tag_map[arg.card]; saveSettingsDebounced();', fixture);
        await page.waitForTimeout(NO_WRITE_SETTLE_MS);
        expect(writes).toEqual([`/api/tags/assign ${JSON.stringify({ id: fixture.card, tagId: fixture.added })}`]);
        expect(await serverTagsOf(page, fixture.card)).toEqual([fixture.kept, fixture.added].sort());
        expect(await withTagMap(page, 'return tag_map[arg.card];', fixture)).toBeUndefined();
    });
});
