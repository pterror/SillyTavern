import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// Creating a character opens it (its info and its chat), as picking it in the list does, and reads only its own card:
// the list isn't searched page by page for it (on a large library that took minutes), and no toast says what's on
// screen.

test('a created character opens at once, without searching the list for it', async ({ page }) => {
    await testSetup.awaitST({ page });
    const name = `Opened-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await openCharacterManagementDrawer(page);
    await page.locator('#rm_button_create').click();
    await expect(page.locator('#form_create')).toHaveAttribute('actiontype', 'createcharacter');
    await page.locator('#character_name_pole').fill(name);

    /** @type {string[]} */
    const listReads = [];
    page.on('request', request => {
        const path = new URL(request.url()).pathname;
        if (path === '/api/characters/query') listReads.push(request.postData() ?? '');
    });
    const createResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/characters/create');
    // @ts-ignore
    await page.evaluate(() => $('#create_button').click());
    const avatar = await (await createResponse).text();
    try {
        await expect(page.locator('#form_create')).toHaveAttribute('actiontype', 'editcharacter');
        await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar);
        // @ts-ignore
        await expect.poll(() => page.evaluate(() => SillyTavern.getContext().name2)).toBe(name);
        await expect(page.locator('#toast-container .toast', { hasText: 'Character Created' })).toHaveCount(0);
        // No read of the list a thousand rows at a time to find the new row.
        expect(listReads.filter(body => /"(?:pageSize|limit|perPage)"\s*:\s*1000\b/.test(body))).toEqual([]);
    } finally {
        await page.evaluate(async (avatarUrl) => {
            // @ts-ignore
            const headers = SillyTavern.getContext().getRequestHeaders();
            await fetch('/api/characters/delete', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatarUrl, delete_chats: true }) });
        }, avatar);
    }
});
