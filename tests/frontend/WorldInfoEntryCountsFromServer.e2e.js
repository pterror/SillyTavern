import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

test('a lorebook entry\'s count comes with the book and with the answer to its save, not from the page', async ({ page }) => {
    await testSetup.awaitST({ page });
    const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const worldName = `COUNTS_${s}`;
    /** @type {string[]} */
    const counted = [];
    page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/tokenizers/current/count') counted.push(request.postData() ?? '');
    });
    const uid = await page.evaluate(async ({ worldName, s }) => {
        const { createNewWorldInfo, openWorldInfoEditor, createWorldInfoEntry, saveWorldInfo, loadWorldInfo } = await import('./scripts/world-info.js');
        await createNewWorldInfo(worldName, { interactive: false });
        const data = await loadWorldInfo(worldName);
        const entry = await createWorldInfoEntry(worldName, data);
        entry.key = ['lantern'];
        entry.content = `The lantern ${s} never goes out.`;
        await saveWorldInfo(worldName, data, true);
        await openWorldInfoEditor(worldName);
        return entry.uid;
    }, { worldName, s });

    const entry = page.locator(`#world_popup_entries_list .world_entry[uid="${uid}"]`);
    await entry.locator('.inline-drawer-toggle').first().click();
    await expect(entry.locator('.world_entry_form_token_counter')).toHaveText(/^\d+$/, { timeout: 10000 });

    const saved = page.waitForResponse(response => /\/api\/worldinfo\/(entry\/edit|entries\/apply)$/.test(response.url()) && response.ok());
    const content = entry.locator('textarea[name="content"]');
    await content.fill(`The lantern ${s} burns low, flickering in the cold wind.`);
    await content.blur();
    const answer = await (await saved).json();
    const count = answer.token_counts?.[String(uid)];
    expect(typeof count).toBe('number');
    await expect(entry.locator('.world_entry_form_token_counter')).toHaveText(String(count));
    expect(counted.filter(body => body.includes(s))).toEqual([]);
});
