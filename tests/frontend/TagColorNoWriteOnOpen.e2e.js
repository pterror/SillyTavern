import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// Opening Manage Tags only shows the tags: it must send no edit and leave every stored colour exactly as it
// was written. A colour the user picks still saves.

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
        return response.json();
    }, { path, body });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 * @param {{ color: string, color2: string }} colors
 */
async function createTag(page, id, colors) {
    await api(page, '/api/tags/create', {
        tag: {
            id, name: id, folder_type: 'NONE', filter_state: 'UNDEFINED', sort_order: 1000,
            is_hidden_on_character_card: false, create_date: Date.now(), ...colors,
        },
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 * @returns {Promise<{ color: string, color2: string }>}
 */
async function storedColors(page, id) {
    const { tags } = await api(page, '/api/tags/by-ids', { ids: [id] });
    return { color: tags[0].color, color2: tags[0].color2 };
}

/** @param {import('@playwright/test').Page} page */
async function openTagManagement(page) {
    await openCharacterManagementDrawer(page);
    await page.locator('.rm_tag_filter .manageTags:visible').first().click();
    await page.locator('#tag_view_list .tag_view_prune').waitFor({ state: 'visible', timeout: 10000 });
}

test.describe('Manage Tags colour pickers', () => {
    test.setTimeout(180000);

    test('opening the list sends no edit and changes no stored colour; a picked colour saves', async ({ browser, page }) => {
        const stamp = Date.now();
        const tags = {
            [`color-hex-${stamp}`]: { color: '#112233', color2: '#AABBCC' },
            [`color-named-${stamp}`]: { color: 'red', color2: 'hsl(120, 100%, 25%)' },
            [`color-none-${stamp}`]: { color: '', color2: '' },
            [`color-rgba-${stamp}`]: { color: 'rgba(10, 20, 30, 0.5)', color2: 'rgba(1, 2, 3, 1)' },
        };

        // Created from a throwaway context so the page under test learns of the tags only through its own boot.
        const setupContext = await browser.newContext();
        try {
            const setup = await setupContext.newPage();
            await loadApp(setup);
            for (const [id, colors] of Object.entries(tags)) await createTag(setup, id, colors);
        } finally {
            await setupContext.close();
        }

        await loadApp(page);

        /** @type {string[]} */
        const writes = [];
        const inFlight = new Set();
        page.on('request', request => {
            const path = new URL(request.url()).pathname;
            if (!path.startsWith('/api/tags/')) return;
            inFlight.add(request);
            if (path === '/api/tags/edit' || path === '/api/tags/save') writes.push(`${path} ${request.postData()}`);
        });
        page.on('requestfinished', request => inFlight.delete(request));
        page.on('requestfailed', request => inFlight.delete(request));

        await openTagManagement(page);
        const hexId = `color-hex-${stamp}`;
        const row = page.locator(`.tag_view_item[id="${hexId}"]`);
        await expect(row).toBeVisible();
        // Every picker has taken its colour once it reports one.
        await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('#tag_view_list toolcool-color-picker')]
            .every(picker => !!picker['rgba']))).toBe(true);
        // Longer than the picker's own start-up and any debounce between a change and its request.
        await page.waitForTimeout(3000);
        await expect.poll(() => inFlight.size, { timeout: 30000 }).toBe(0);

        expect(writes).toEqual([]);
        for (const [id, colors] of Object.entries(tags)) {
            expect(await storedColors(page, id), id).toEqual(colors);
        }

        await row.locator('toolcool-color-picker.tag-color').evaluate(picker => { picker['color'] = 'rgba(200, 10, 10, 1)'; });
        await expect.poll(() => storedColors(page, hexId), { timeout: 30000 })
            .toEqual({ color: 'rgba(200, 10, 10, 1)', color2: '#AABBCC' });
        expect(writes.length).toBeGreaterThan(0);
    });
});
