import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

test.describe('World Info Editor Renders Entries', () => {
    test.beforeEach(testSetup.awaitST);

    test('should populate the entry list DOM when opening a lorebook with entries', async ({ page }) => {
        const worldName = 'STAGE_REPRO_ENTRIES_ALPHA';

        const result = await page.evaluate(async ({ worldName }) => {
            const { createNewWorldInfo, deleteWorldInfo, openWorldInfoEditor, createWorldInfoEntry, saveWorldInfo, loadWorldInfo, world_names } = await import('./scripts/world-info.js');

            async function waitFor(condition, timeoutMs = 5000, intervalMs = 50) {
                const start = Date.now();
                while (Date.now() - start < timeoutMs) {
                    if (condition()) return true;
                    await new Promise(resolve => setTimeout(resolve, intervalMs));
                }
                return false;
            }

            if (world_names.includes(worldName)) {
                await deleteWorldInfo(worldName);
            }

            const created = await createNewWorldInfo(worldName, { interactive: false });
            if (!created) {
                throw new Error(`Failed to create world info '${worldName}'`);
            }

            // Seed the fresh book with a couple of entries so the panel has something to render.
            // Entries need at least one non-empty `key` - updateWorldEntryKeyOptionsCache() only calls
            // getSelect2OptionId() (the code path that crashed) when there's at least one key to hash.
            const data = await loadWorldInfo(worldName);
            const entry1 = createWorldInfoEntry(worldName, data);
            entry1.key = ['alpha_keyword'];
            const entry2 = createWorldInfoEntry(worldName, data);
            entry2.key = ['beta_keyword'];
            await saveWorldInfo(worldName, data, true);

            try {
                await openWorldInfoEditor(worldName);

                const rendered = await waitFor(() => {
                    return $('#world_popup_entries_list').children().length > 0;
                }, 5000);

                return {
                    rendered,
                    entryCount: Object.keys(data.entries || {}).length,
                    listChildren: $('#world_popup_entries_list').children().length,
                    paginationHtmlLength: ($('#world_info_pagination').html() || '').length,
                };
            } finally {
                await deleteWorldInfo(worldName);
            }
        }, { worldName });

        // Regression guard for the 2026-08-22 "lorebook panel shows no entries" bug: getSelect2OptionId
        // (called synchronously while building the pagination dataSource) referenced getStringHash as a
        // bare identifier, but utils.js only re-exported it (`export { getStringHash } from './hash-utils.js'`)
        // without importing it locally - a ReferenceError that aborted rendering silently as an unhandled
        // promise rejection in the '#world_editor_select' change handler.
        expect(result.entryCount).toBeGreaterThan(0);
        expect(result.rendered).toBe(true);
        expect(result.listChildren).toBeGreaterThan(0);
        expect(result.paginationHtmlLength).toBeGreaterThan(0);
    });
});
