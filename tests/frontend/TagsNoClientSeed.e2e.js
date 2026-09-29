import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// The server adds upstream's default tags to a new store (tags-default-seed.test.js). The page never makes up tags
// of its own: when the server has no tag store this run (`/api/tags/get` answers `tags: null`), it shows none and
// saves none.

test('no tag store on the server: the page shows no tags and saves none', async ({ page }) => {
    await page.route('**/api/tags/get', route => route.fulfill({ json: { tags: null } }));
    /** @type {string[]} */
    const saves = [];
    await page.route('**/api/tags/save', async (route) => {
        saves.push(route.request().postData() ?? '');
        await route.fulfill({ status: 503 });
    });

    await testSetup.awaitST({ page });
    await page.evaluate(() => {
        window['__appReady'] = false;
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, () => { window['__appReady'] = true; });
    });
    await page.waitForFunction(() => window['__appReady'], null, { timeout: 60000 });

    expect(await page.evaluate(() => window['SillyTavern'].getContext().tags.map(tag => tag.name))).toEqual([]);
    expect(saves).toEqual([]);
});
