import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// The page reads no tag list at boot: it holds the tags of what is on screen, read by id. A reset of the tag change
// feed re-reads those tags by id, sending a hash of each copy held.

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
 * @param {import('@playwright/test').Page} page
 * @param {string} path
 * @param {object} [body]
 */
async function api(page, path, body = {}) {
    return page.evaluate(async ({ path, body }) => {
        const headers = window['SillyTavern'].getContext().getRequestHeaders();
        const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
        if (!response.ok) throw new Error(`${path} -> ${response.status}`);
        return response.json();
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

/** @param {import('@playwright/test').Page} page @returns {Promise<string[]>} */
async function heldTagIds(page) {
    return page.evaluate(async () => {
        const { tagsStore } = await import('/scripts/tags.js');
        return tagsStore.getAll().map(tag => tag.id);
    });
}

test.describe('the tags the page holds', () => {
    test.setTimeout(180000);

    test('boot reads no tag list, and opening a character reads its tags by id', async ({ browser, page }) => {
        const stamp = Date.now();
        const ids = Array.from({ length: 300 }, (_, i) => `boot-held-${stamp}-${i}`);
        const context = await browser.newContext();
        let avatar;
        try {
            const setup = await context.newPage();
            await loadApp(setup);
            for (let i = 0; i < ids.length; i += 25) {
                // Placed last in the manual order, so other tests' tags stay on Manage Tags' first page.
                await Promise.all(ids.slice(i, i + 25).map((id, j) => api(setup, '/api/tags/create', {
                    tag: { id, name: id, folder_type: 'NONE', sort_order: 9000000 + i + j, is_hidden_on_character_card: false, color: '', color2: '', create_date: 1 },
                })));
            }
            avatar = await createCharacter(setup, `TagBootHeld-${stamp}`);
            await api(setup, '/api/tags/assign', { id: avatar, tagId: ids[7] });
            await api(setup, '/api/tags/assign', { id: avatar, tagId: ids[42] });
        } finally {
            await context.close();
        }

        /** @type {string[]} */
        const paths = [];
        page.on('request', (request) => {
            const { pathname } = new URL(request.url());
            if (pathname.startsWith('/api/tags/')) paths.push(pathname);
        });
        await loadApp(page);
        expect(paths).not.toContain('/api/tags/get');
        expect(paths).not.toContain('/api/tags/digest');
        expect(paths).not.toContain('/api/tags/bucket');
        expect(paths).not.toContain('/api/tags/usage');

        await page.evaluate(async (avatar) => {
            const { selectCharacterByAvatar } = await import('/script.js');
            await selectCharacterByAvatar(avatar);
        }, avatar);
        await expect.poll(async () => (await page.locator('#tagList .tag').allInnerTexts()).map(text => text.trim()).sort())
            .toEqual([ids[7], ids[42]].sort());
        const held = await heldTagIds(page);
        expect(held).toContain(ids[7]);
        expect(held).toContain(ids[42]);
        expect(ids.filter(id => held.includes(id))).toEqual([ids[7], ids[42]]);
    });

    test('a reset of the tag change feed re-reads the held tags by id, with a hash of each', async ({ page }) => {
        await loadApp(page);
        const held = await heldTagIds(page);

        /** @type {any[]} */
        const reads = [];
        page.on('request', (request) => {
            if (new URL(request.url()).pathname === '/api/tags/by-ids') reads.push(request.postDataJSON());
        });
        let answered = false;
        await page.route('**/api/tags/changes', async (route) => {
            if (answered) return route.continue();
            answered = true;
            const response = await route.fetch();
            const json = await response.json();
            await route.fulfill({ response, json: { ...json, reset: true } });
        });
        await page.evaluate(async () => {
            const { onTagsChanged } = await import('/scripts/tags.js');
            onTagsChanged();
        });

        await expect.poll(() => reads.some(read => read.known)).toBe(true);
        const reread = reads.filter(read => read.known);
        const asked = reread.flatMap(read => read.ids);
        expect([...asked].sort()).toEqual([...held].sort());
        for (const read of reread) expect(Object.keys(read.known).sort()).toEqual([...read.ids].sort());
        // Nothing changed, so nothing was let go.
        expect((await heldTagIds(page)).sort()).toEqual([...held].sort());
    });
});
