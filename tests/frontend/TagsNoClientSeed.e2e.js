import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

test('the page holds only tags the server answered, and creates none', async ({ page }) => {
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
        const { eventSource, eventTypes } = window['stTest'].context();
        eventSource.once(eventTypes.APP_READY, () => { window['__appReady'] = true; });
    });
    await page.waitForFunction(() => window['__appReady'], null, { timeout: 60000 });

    await expect.poll(async () => {
        const held = await page.evaluate(async () => {
            const { tagsStore } = await import('./scripts/tags.js');
            return tagsStore.getAll().map(tag => tag.id);
        });
        return held.filter(id => !answered.has(id));
    }).toEqual([]);
    expect(creates).toEqual([]);
});
