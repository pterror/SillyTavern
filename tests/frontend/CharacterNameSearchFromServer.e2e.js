import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// Places that offer character names to pick from search the server, so they find a character the page doesn't hold.
// Each test makes its characters after the page has loaded and keeps the page from hearing of them.

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
 * Creates a character the page doesn't hold, and waits until the server's search finds it.
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
    expect(await page.evaluate(avatar => window['SillyTavern'].getContext().characters.some(c => c.avatar === avatar), avatar)).toBe(false);
    await expect.poll(() => page.evaluate(async ({ name }) => {
        const { getRequestHeaders } = await import('./script.js');
        const response = await fetch('/api/characters/query', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ filter: { search: name }, sort: { field: 'search' }, page: 1, pageSize: 10, want: ['rows'] }),
        });
        const body = await response.json();
        return (body.rows ?? []).map(row => row.avatar);
    }, { name }), { timeout: 15000 }).toContain(avatar);
    return avatar;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function deleteCharacter(page, avatar) {
    await page.evaluate(async (avatar) => {
        const { getRequestHeaders } = await import('./script.js');
        await fetch('/api/characters/delete', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar, delete_chats: true }) });
    }, avatar);
}

test.describe('character names searched on the server', () => {
    test.beforeEach(async ({ page }) => {
        await loadApp(page);
        await page.route('**/api/characters/changes', route => route.fulfill({ status: 500 }));
    });

    test('the slash command autocomplete offers a character the page does not hold', async ({ page }) => {
        const stamp = `${Date.now()}`;
        const name = `Autocompletee${stamp}`;
        const avatar = await createUnheldCharacter(page, name);
        try {
            const input = page.locator('#send_textarea');
            await input.click();
            await input.pressSequentially(`/char-find Autocompletee${stamp.slice(0, 6)}`);
            // An optional argument's options show when asked for.
            await input.press('Control+Space');
            await expect(page.locator('.autoComplete .item', { hasText: name })).toBeVisible();
        } finally {
            await deleteCharacter(page, avatar);
        }
    });

    test('the autocomplete never shows an answer for text that is no longer typed', async ({ page }) => {
        const stamp = `${Date.now()}`;
        const first = `Staleone${stamp}`;
        const avatar = await createUnheldCharacter(page, first);
        try {
            // The search for the first text is answered only after the search for the text typed after it.
            let laterAnswered;
            const later = new Promise(resolve => { laterAnswered = resolve; });
            let searches = 0;
            await page.route('**/api/characters/query', async (route) => {
                const body = route.request().postDataJSON();
                if (!body?.filter?.search) return route.continue();
                searches++;
                if (searches === 1) {
                    await later;
                    return route.continue();
                }
                const response = await route.fetch();
                await route.fulfill({ response });
                laterAnswered();
            });
            const input = page.locator('#send_textarea');
            await input.click();
            await input.pressSequentially('/char-find Staleone');
            await input.press('Control+Space');
            await input.pressSequentially('zzzz');
            await input.press('Control+Space');
            await later;
            await page.waitForTimeout(500);
            await expect(page.locator('.autoComplete .item', { hasText: first })).toHaveCount(0);
        } finally {
            await page.unroute('**/api/characters/query');
            await deleteCharacter(page, avatar);
        }
    });

    test('a lorebook entry\'s character filter finds a character the page does not hold', async ({ page }) => {
        const stamp = `${Date.now()}`;
        const name = `Loresearch${stamp}`;
        const worldName = `CharSearchWI_${stamp}`;
        const avatar = await createUnheldCharacter(page, name);
        const fileName = avatar.replace(/\.[^/.]+$/, '');

        await page.evaluate(async (worldName) => {
            const { createNewWorldInfo, createWorldInfoEntry, saveWorldInfo, loadWorldInfo } = await import('./scripts/world-info.js');
            if (!await createNewWorldInfo(worldName, { interactive: false })) throw new Error('no world');
            const data = await loadWorldInfo(worldName);
            const entry = await createWorldInfoEntry(worldName, data);
            entry.key = ['char_search_keyword'];
            await saveWorldInfo(worldName, data, true);
        }, worldName);

        try {
            await page.evaluate(async (worldName) => {
                const { openWorldInfoEditor } = await import('./scripts/world-info.js');
                openWorldInfoEditor(worldName);
            }, worldName);
            const entryRow = page.locator('#world_popup_entries_list .world_entry').first();
            await entryRow.waitFor({ state: 'attached', timeout: 10000 });
            await entryRow.evaluate(row => $(row).find('.inline-drawer-toggle').first().trigger('click'));
            await entryRow.locator('select[name="characterFilter"]').waitFor({ state: 'attached' });
            await entryRow.locator('select[name="characterFilter"] + .select2-container .select2-selection').click();
            await page.keyboard.type(name);
            const option = page.locator('.select2-results__option', { hasText: fileName });
            await expect(option).toBeVisible();
            const saved = page.waitForRequest(request => request.url().endsWith('/api/worldinfo/entry/edit'));
            await option.click();
            expect((await saved).postDataJSON().data.characterFilter.names).toEqual([fileName]);
        } finally {
            await page.evaluate(async (worldName) => {
                const { deleteWorldInfo } = await import('./scripts/world-info.js');
                await deleteWorldInfo(worldName);
            }, worldName);
            await deleteCharacter(page, avatar);
        }
    });

    test('the tts voice list for any name holds only the current chat and the names with a voice set', async ({ page }) => {
        const stamp = `${Date.now()}`;
        const name = `Ttsunheld${stamp}`;
        const avatar = await createUnheldCharacter(page, name);
        try {
            const names = await page.evaluate(async () => {
                const { getCharacters } = await import('./scripts/extensions/tts/index.js');
                return getCharacters(true);
            });
            expect(names).toContain('[Default Voice]');
            expect(names).not.toContain(name);
        } finally {
            await deleteCharacter(page, avatar);
        }
    });
});
