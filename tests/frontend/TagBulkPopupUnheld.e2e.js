import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// The bulk tag popup reads the selected characters' tags from the server and writes through it, so it shows and
// changes the tags of characters the page doesn't hold. Each test makes its characters and tags after the page has
// loaded and keeps the page from hearing of them.

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

/**
 * Creates a character the page doesn't hold.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @returns {Promise<string>} its avatar key
 */
async function createUnheldCharacter(page, name) {
    const avatar = await page.evaluate(async (name) => {
        const { getRequestHeaders } = await import('./script.js');
        const form = new FormData();
        form.set('ch_name', name);
        const response = await fetch('/api/characters/create', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, name);
    const held = await page.evaluate(async (avatar) => {
        const { charactersStore } = await import('./scripts/character-store.js');
        return charactersStore.has(avatar);
    }, avatar);
    expect(held).toBe(false);
    return avatar;
}

/**
 * Creates a tag the page doesn't hold.
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 * @param {string} name
 */
async function createUnheldTag(page, id, name) {
    await api(page, '/api/tags/create', { tag: { id, name, folder_type: 'NONE', is_hidden_on_character_card: false, color: '', color2: '', create_date: 1 } });
}

/** @param {import('@playwright/test').Page} page @param {string} key @returns {Promise<string[]>} */
async function serverTagsOf(page, key) {
    return ((await api(page, '/api/tags/for', { ids: [key] }))[key] ?? []).slice().sort();
}

/** @param {import('@playwright/test').Page} page @param {string[]} avatars */
async function openBulkTagPopup(page, avatars) {
    await page.evaluate(async (avatars) => {
        const { characterGroupOverlay } = await import('./script.js');
        await characterGroupOverlay.bulkTagPopupHandler.show(avatars);
    }, avatars);
}

test.describe('the bulk tag popup on characters the page does not hold', () => {
    test.beforeEach(async ({ page }) => {
        await loadApp(page);
        await page.route('**/api/characters/changes', route => route.fulfill({ status: 500 }));
        await page.route('**/api/tags/changes', route => route.fulfill({ status: 500 }));
    });

    test('shows the tags they share, adds a tag to both, and removes the shared ones', async ({ page }) => {
        const stamp = `${Date.now()}`;
        const first = await createUnheldCharacter(page, `BulkTagA ${stamp}`);
        const second = await createUnheldCharacter(page, `BulkTagB ${stamp}`);
        await createUnheldTag(page, `shared-${stamp}`, `Shared ${stamp}`);
        await createUnheldTag(page, `own-${stamp}`, `Own ${stamp}`);
        await createUnheldTag(page, `added-${stamp}`, `Added ${stamp}`);
        await api(page, '/api/tags/assign', { id: first, tagId: `shared-${stamp}` });
        await api(page, '/api/tags/assign', { id: second, tagId: `shared-${stamp}` });
        await api(page, '/api/tags/assign', { id: first, tagId: `own-${stamp}` });

        await openBulkTagPopup(page, [first, second]);
        await expect(page.locator('#bulk_tags_avatars_block .avatar')).toHaveCount(2);
        await expect(page.locator('#bulkTagList .tag')).toHaveText([`Shared ${stamp}`]);

        await page.locator('#bulkTagInput').fill(`Added ${stamp}`);
        await page.locator('.ui-autocomplete .ui-menu-item').getByText(`Added ${stamp}`, { exact: true }).click();
        await expect.poll(() => serverTagsOf(page, second)).toEqual([`added-${stamp}`, `shared-${stamp}`].sort());
        expect(await serverTagsOf(page, first)).toEqual([`added-${stamp}`, `own-${stamp}`, `shared-${stamp}`].sort());
        await expect(page.locator('#bulkTagList .tag')).toHaveCount(2);

        await page.locator('#bulk_tag_popup_remove_mutual').click();
        await expect.poll(() => serverTagsOf(page, first)).toEqual([`own-${stamp}`]);
        expect(await serverTagsOf(page, second)).toEqual([]);
        await expect(page.locator('#bulkTagList .tag')).toHaveCount(0);
    });

    test('a held character and one the page does not hold get the same tag, and the held one shows it at once', async ({ page }) => {
        const stamp = `${Date.now()}`;
        const held = await page.evaluate(async () => {
            const { charactersStore } = await import('./scripts/character-store.js');
            return charactersStore.getAll()[0].avatar;
        });
        const unheld = await createUnheldCharacter(page, `BulkTagMixed ${stamp}`);
        await createUnheldTag(page, `mixed-${stamp}`, `Mixed ${stamp}`);

        await openBulkTagPopup(page, [held, unheld]);
        await page.locator('#bulkTagInput').fill(`Mixed ${stamp}`);
        await page.locator('.ui-autocomplete .ui-menu-item').getByText(`Mixed ${stamp}`, { exact: true }).click();
        await expect.poll(() => serverTagsOf(page, unheld)).toEqual([`mixed-${stamp}`]);
        await expect.poll(() => serverTagsOf(page, held)).toContain(`mixed-${stamp}`);
        const heldIds = await page.evaluate(async (held) => {
            const { charactersStore } = await import('./scripts/character-store.js');
            return charactersStore.get(held).tag_ids;
        }, held);
        expect(heldIds).toContain(`mixed-${stamp}`);
    });

    test('removing one shared tag and resetting act on the server', async ({ page }) => {
        const stamp = `${Date.now()}`;
        const first = await createUnheldCharacter(page, `BulkTagC ${stamp}`);
        const second = await createUnheldCharacter(page, `BulkTagD ${stamp}`);
        await createUnheldTag(page, `x-${stamp}`, `X ${stamp}`);
        await createUnheldTag(page, `y-${stamp}`, `Y ${stamp}`);
        for (const key of [first, second]) {
            await api(page, '/api/tags/assign', { id: key, tagId: `x-${stamp}` });
            await api(page, '/api/tags/assign', { id: key, tagId: `y-${stamp}` });
        }

        await openBulkTagPopup(page, [first, second]);
        await expect(page.locator('#bulkTagList .tag')).toHaveCount(2);

        await page.locator('#bulkTagList .tag', { hasText: `X ${stamp}` }).locator('.tag_remove').click();
        await expect.poll(() => serverTagsOf(page, first)).toEqual([`y-${stamp}`]);
        expect(await serverTagsOf(page, second)).toEqual([`y-${stamp}`]);
        await expect(page.locator('#bulkTagList .tag')).toHaveText([`Y ${stamp}`]);

        await page.locator('#bulk_tag_popup_reset').click();
        await expect.poll(() => serverTagsOf(page, first)).toEqual([]);
        expect(await serverTagsOf(page, second)).toEqual([]);
    });
});
