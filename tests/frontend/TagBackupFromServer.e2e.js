import fs from 'node:fs';
import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// The tag backup is made by the server, so it holds every tag and every character's tags, including a character and
// a tag the page doesn't hold.

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
    return page.evaluate(async (name) => {
        const { getRequestHeaders } = await import('./script.js');
        const form = new FormData();
        form.set('ch_name', name);
        const response = await fetch('/api/characters/create', { method: 'POST', headers: getRequestHeaders({ omitContentType: true }), body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, name);
}

test('the tag backup holds a character and a tag the page does not hold', async ({ page }) => {
    await loadApp(page);
    await page.route('**/api/characters/changes', route => route.fulfill({ status: 500 }));
    await page.route('**/api/tags/changes', route => route.fulfill({ status: 500 }));
    const stamp = `${Date.now()}`;
    const avatar = await createUnheldCharacter(page, `TagBackupUnheld ${stamp}`);
    const tagId = `backup-unheld-${stamp}`;
    await api(page, '/api/tags/create', { tag: { id: tagId, name: `Backup ${stamp}`, folder_type: 'NONE', is_hidden_on_character_card: false, color: '', color2: '', create_date: 1 } });
    await api(page, '/api/tags/assign', { id: avatar, tagId });

    await openCharacterManagementDrawer(page);
    await page.locator('.rm_tag_filter .manageTags:visible').first().click();
    await page.locator('#tag_view_list .tag_view_backup').waitFor({ state: 'visible', timeout: 10000 });
    const downloaded = page.waitForEvent('download');
    await page.locator('#tag_view_list .tag_view_backup').click();
    const download = await downloaded;
    const backup = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));

    expect(backup.tags.map(tag => tag.id)).toContain(tagId);
    expect(backup.tag_map[avatar]).toEqual([tagId]);
});

test('a backup the server could not make is not downloaded, and says so', async ({ page }) => {
    await loadApp(page);
    await page.route('**/api/tags/backup', route => route.fulfill({ status: 500 }));
    let downloads = 0;
    page.on('download', () => { downloads++; });

    await openCharacterManagementDrawer(page);
    await page.locator('.rm_tag_filter .manageTags:visible').first().click();
    await page.locator('#tag_view_list .tag_view_backup').click();
    await expect(page.locator('.toast-error', { hasText: 'The tag backup could not be made.' })).toBeVisible();
    expect(downloads).toBe(0);
});
