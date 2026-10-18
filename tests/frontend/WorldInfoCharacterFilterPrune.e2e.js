import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}
if (process.env.PLAYWRIGHT_BASIC_AUTH_USER) {
    test.use({
        httpCredentials: {
            username: process.env.PLAYWRIGHT_BASIC_AUTH_USER,
            password: process.env.PLAYWRIGHT_BASIC_AUTH_PASS ?? '',
        },
    });
}

test.describe('world info character filter existence prune', () => {
    test.beforeEach(testSetup.awaitST);

    test('toggling an entry\'s character exclusion keeps a filter name whose character exists', async ({ page }) => {
        const worldName = `WI_FILTER_PRUNE_${Date.now()}`;

        await openCharacterManagementDrawer(page);
        await page.locator('#rm_button_create').click();
        await page.locator('#character_name_pole').fill(`WIFilterPruneTest-${Date.now()}`);
        const createResponse = page.waitForResponse(response => response.url().endsWith('/api/characters/create'));
        await page.locator('#create_button_label').click();
        const avatar = await (await createResponse).text();
        const boundName = avatar.replace(/\.[^/.]+$/, '');

        try {
            const uid = await page.evaluate(async ({ worldName, boundName }) => {
                const { createNewWorldInfo, createWorldInfoEntry, saveWorldInfo, loadWorldInfo } = await import('./scripts/world-info.js');
                if (!await createNewWorldInfo(worldName, { interactive: false })) {
                    throw new Error(`Failed to create world info '${worldName}'`);
                }
                const data = await loadWorldInfo(worldName);
                const entry = await createWorldInfoEntry(worldName, data);
                entry.key = ['prune_keyword'];
                entry.characterFilter = { isExclude: false, names: [boundName], tags: [] };
                await saveWorldInfo(worldName, data, true);
                return entry.uid;
            }, { worldName, boundName });

            await page.evaluate(async (worldName) => {
                const { openWorldInfoEditor } = await import('./scripts/world-info.js');
                openWorldInfoEditor(worldName);
            }, worldName);
            const entryRow = page.locator('#world_popup_entries_list .world_entry').first();
            await entryRow.waitFor({ state: 'attached', timeout: 10000 });

            // The entry's editor is only built when its drawer opens.
            await entryRow.evaluate(row => $(row).find('.inline-drawer-toggle').first().trigger('click'));
            const exclusion = entryRow.locator('input[name="character_exclusion"]');
            await expect(exclusion).toBeVisible();

            // Toggling the exclusion checks the filter's names against the characters that exist, and commits at once.
            const existsResponse = page.waitForResponse(response => response.url().endsWith('/api/characters/exists'));
            const editRequest = page.waitForRequest(request => request.url().endsWith('/api/worldinfo/entry/edit'));
            await exclusion.check();
            await existsResponse;
            const saved = (await editRequest).postDataJSON();

            expect(saved.uid).toBe(uid);
            expect(saved.data.characterFilter.isExclude).toBe(true);
            expect(saved.data.characterFilter.names).toEqual([boundName]);
        } finally {
            await page.evaluate(async ({ worldName, avatar }) => {
                const { deleteWorldInfo } = await import('./scripts/world-info.js');
                const { getRequestHeaders } = await import('./script.js');
                await deleteWorldInfo(worldName);
                await fetch('/api/characters/delete', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ avatar_url: avatar, delete_chats: true }),
                });
            }, { worldName, avatar });
        }
    });
});
