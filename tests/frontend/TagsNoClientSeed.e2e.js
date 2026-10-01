import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// The server adds upstream's default tags to a new store (tags-default-seed.test.js). The page never makes up tags
// of its own: when the server answers no tag list this run (`/api/tags/get` answers `tags: null`), the page holds only
// tags the server answered when asked for some, and creates none.

test('no tag list from the server: the page holds only tags the server answered, and creates none', async ({ page }) => {
    await page.route('**/api/tags/get', route => route.fulfill({ json: { tags: null } }));
    /** @type {string[]} */
    const creates = [];
    /** @type {Set<string>} */
    const answered = new Set();
    page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/tags/create') creates.push(request.postData() ?? '');
    });
    page.on('response', async (response) => {
        const path = new URL(response.url()).pathname;
        if (!['/api/tags/by-ids', '/api/tags/query', '/api/tags/by-names'].includes(path) || !response.ok()) return;
        const body = await response.json().catch(() => null);
        for (const tag of [...(body?.tags ?? []), ...(body?.rows ?? [])]) {
            const id = tag?.tag?.id ?? tag?.id;
            if (id) answered.add(id);
        }
    });

    await testSetup.awaitST({ page });
    await page.evaluate(() => {
        window['__appReady'] = false;
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, () => { window['__appReady'] = true; });
    });
    await page.waitForFunction(() => window['__appReady'], null, { timeout: 60000 });

    // A response is taken in here a moment after the page has it.
    await expect.poll(async () => {
        const held = await page.evaluate(async () => {
            const { tagsStore } = await import('./scripts/tags.js');
            return tagsStore.getAll().map(tag => tag.id);
        });
        return held.filter(id => !answered.has(id));
    }).toEqual([]);
    expect(creates).toEqual([]);
});
