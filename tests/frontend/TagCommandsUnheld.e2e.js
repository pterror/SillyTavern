import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// The tag slash commands work on a character the page doesn't hold: they find it through the server, read its tags
// from the server and write through the server's assign and unassign. Each test makes its characters after the page
// has loaded and keeps the page from hearing of them.

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/** @param {import('@playwright/test').Page} page */
async function loadApp(page) {
    await testSetup.awaitST({ page });
    await page.evaluate(() => {
        window['__appReady'] = false;
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, () => { window['__appReady'] = true; });
    });
    await page.waitForFunction(() => window['__appReady'], null, { timeout: 60000 });
}

/**
 * Creates a character the page doesn't hold.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string} [cardTags] - the card's own tags, comma-separated
 * @returns {Promise<string>} its avatar key
 */
async function createUnheldCharacter(page, name, cardTags = '') {
    const avatar = await page.evaluate(async ({ name, cardTags }) => {
        const { getRequestHeaders } = await import('./script.js');
        const form = new FormData();
        form.set('ch_name', name);
        form.set('tags', cardTags);
        const response = await fetch('/api/characters/create', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, { name, cardTags });
    const held = await page.evaluate(async (avatar) => {
        const { charactersStore } = await import('./scripts/character-store.js');
        return charactersStore.has(avatar);
    }, avatar);
    expect(held).toBe(false);
    return avatar;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} command
 * @returns {Promise<string>} the command's result
 */
async function run(page, command) {
    return page.evaluate(async (command) => (await window['SillyTavern'].getContext().executeSlashCommandsWithOptions(command)).pipe, command);
}

/**
 * The names of the tags the server stores for `key`.
 * @param {import('@playwright/test').Page} page
 * @param {string} key
 * @returns {Promise<string[]>}
 */
async function serverTagNames(page, key) {
    return page.evaluate(async (key) => {
        const { getRequestHeaders } = await import('./script.js');
        const post = async (path, body) => {
            const response = await fetch(path, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
            if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
            return response.json();
        };
        const ids = (await post('/api/tags/for', { ids: [key] }))[key] ?? [];
        if (!ids.length) return [];
        const { tags } = await post('/api/tags/by-ids', { ids });
        return tags.map(tag => tag.name).sort();
    }, key);
}

test.describe('tag slash commands on a character the page does not hold', () => {
    test.beforeEach(async ({ page }) => {
        await loadApp(page);
        await page.route('**/api/characters/changes', route => route.fulfill({ status: 500 }));
    });

    test('/tag-add, /tag-exists, /tag-list and /tag-remove act on the server', async ({ page }) => {
        const stamp = `${Date.now()}`;
        const name = `TagCmdUnheld ${stamp}`;
        const avatar = await createUnheldCharacter(page, name);
        const tagA = `cmdtag a ${stamp}`;
        const tagB = `cmdtag b ${stamp}`;

        expect(await run(page, `/tag-add name="${name}" "${tagA}"`)).toBe('true');
        expect(await run(page, `/tag-add name="${avatar}" "${tagB}"`)).toBe('true');
        expect(await serverTagNames(page, avatar)).toEqual([tagA, tagB].sort());

        // Already there: nothing to add.
        expect(await run(page, `/tag-add name="${name}" "${tagA}"`)).toBe('false');

        expect(await run(page, `/tag-exists name="${name}" "${tagA}"`)).toBe('true');
        expect((await run(page, `/tag-list name="${name}"`)).split(', ').sort()).toEqual([tagA, tagB].sort());

        expect(await run(page, `/tag-remove name="${name}" "${tagA}"`)).toBe('true');
        expect(await serverTagNames(page, avatar)).toEqual([tagB]);
        expect(await run(page, `/tag-exists name="${name}" "${tagA}"`)).toBe('false');
        expect(await run(page, `/tag-remove name="${name}" "${tagA}"`)).toBe('false');

        // Still not held: none of this needed the page to hold the character.
        const held = await page.evaluate(async (avatar) => {
            const { charactersStore } = await import('./scripts/character-store.js');
            return charactersStore.has(avatar);
        }, avatar);
        expect(held).toBe(false);
    });

    test('/tag-import imports the card tags of a character the page does not hold', async ({ page }) => {
        const stamp = `${Date.now()}`;
        const name = `TagCmdImport ${stamp}`;
        const cardTags = [`cardtag a ${stamp}`, `cardtag b ${stamp}`];
        const avatar = await createUnheldCharacter(page, name, cardTags.join(','));

        expect(await run(page, `/tag-import name="${name}" mode=all`)).toBe('true');
        expect(await serverTagNames(page, avatar)).toEqual([...cardTags].sort());

        // Every card tag is on it already: nothing more to import.
        expect(await run(page, `/tag-import name="${name}" mode=all`)).toBe('false');
    });

    test('a name no character or group has warns and changes nothing', async ({ page }) => {
        const stamp = `${Date.now()}`;
        expect(await run(page, `/tag-add name="TagCmdNobody ${stamp}" "nobodytag ${stamp}"`)).toBe('false');
        await expect(page.locator('.toast-warning', { hasText: `TagCmdNobody ${stamp} not found` })).toBeVisible();
    });
});
