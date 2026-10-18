import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// The World Info panel shows the entries of the lorebook its selector is on, also after a reload.

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
async function createBook(page, name) {
    await page.evaluate(async ({ name }) => {
        const { createNewWorldInfo, loadWorldInfo, createWorldInfoEntry, saveWorldInfo } = await import('./scripts/world-info.js');
        if (!await createNewWorldInfo(name, { interactive: false })) throw new Error(`Could not create '${name}'`);
        const data = await loadWorldInfo(name);
        const entry = await createWorldInfoEntry(name, data);
        entry.key = ['shownkey'];
        entry.comment = 'shown entry';
        if (await saveWorldInfo(name, data, true) !== true) throw new Error(`Could not save '${name}'`);
    }, { name });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
async function deleteBook(page, name) {
    await page.evaluate(async ({ name }) => {
        const { deleteWorldInfo, world_names } = await import('./scripts/world-info.js');
        if (world_names.includes(name)) await deleteWorldInfo(name);
    }, { name });
}

/** @param {import('@playwright/test').Page} page */
async function openPanel(page) {
    await page.locator('#WI-SP-button .drawer-toggle').click();
    await expect(page.locator('#WorldInfo')).toBeVisible();
}

test.describe('World Info panel shows the selected lorebook', () => {
    test.beforeEach(testSetup.awaitST);

    test('opening the panel after a reload shows the book the selector is on', async ({ page }) => {
        const name = `WIShownBook-${Date.now()}`;
        await createBook(page, name);
        try {
            await page.evaluate(async ({ name }) => {
                const { world_names } = await import('./scripts/world-info.js');
                $('#world_editor_select').val(String(world_names.indexOf(name))).trigger('change');
            }, { name });
            await expect(page.locator('#world_popup_entries_list .world_entry')).toHaveCount(1);
            // The selection is a setting; it has to be stored before the reload.
            await page.evaluate(async () => {
                const { saveSettings } = await import('./script.js');
                await saveSettings();
            });

            await page.goto('/');
            await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
            await openPanel(page);

            await expect(page.locator('#world_editor_select option:checked')).toHaveText(name);
            await expect(page.locator('#world_popup_entries_list .world_entry')).toHaveCount(1);
            await expect(page.locator('#world_popup_entries_list .world_entry textarea[name="comment"]')).toHaveValue('shown entry');
        } finally {
            await deleteBook(page, name);
        }
    });
});
