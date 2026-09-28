import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// In create mode the character being created isn't stored yet, so the rename's relink of stored characters can't
// reach it. Renaming a book it links moves its links (primary and auxiliary) to the new name, so it isn't created
// linked to a name with no book behind it.

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string[]} worldNames
 */
async function deleteWorlds(page, worldNames) {
    await page.evaluate(async (worldNames) => {
        const worldInfo = await import('./scripts/world-info.js');
        await worldInfo.updateWorldInfoList();
        for (const name of worldNames) {
            if (worldInfo.world_names.includes(name)) {
                await worldInfo.deleteWorldInfo(name);
            }
        }
    }, worldNames);
}

test.describe('renaming a lorebook in create mode', () => {
    test.beforeEach(testSetup.awaitST);

    test('moves the links of the character being created to the new name', async ({ page }) => {
        const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const oldName = `WI_RENAME_CREATE_OLD_${s}`;
        const newName = `WI_RENAME_CREATE_NEW_${s}`;
        const otherName = `WI_RENAME_CREATE_OTHER_${s}`;
        const globe = page.locator('#world_button');

        try {
            await openCharacterManagementDrawer(page);
            await page.locator('#rm_button_create').click();
            await expect(globe).toBeVisible();

            await page.evaluate(async ({ oldName, otherName }) => {
                const { createNewWorldInfo, charUpdatePrimaryWorld } = await import('./scripts/world-info.js');
                const { create_save } = await import('/script.js');
                for (const name of [oldName, otherName]) {
                    if (!await createNewWorldInfo(name, { interactive: false })) {
                        throw new Error(`Failed to create world info '${name}'`);
                    }
                }
                await charUpdatePrimaryWorld(oldName);
                create_save.extra_books = [oldName, otherName];
            }, { oldName, otherName });
            await expect(page.locator('#character_world')).toHaveValue(oldName);
            await expect(globe).toHaveClass(/\bworld_set\b/);

            const { confirmAsked, world, extraBooks } = await page.evaluate(async ({ oldName, newName }) => {
                const { openWorldInfoEditor } = await import('./scripts/world-info.js');
                const { Popup, POPUP_RESULT } = await import('./scripts/popup.js');
                const { create_save } = await import('/script.js');

                const originalInput = Popup.show.input;
                const originalConfirm = Popup.show.confirm;
                let confirmAsked = false;
                let finish;
                const finished = new Promise(resolve => finish = resolve);
                try {
                    await openWorldInfoEditor(oldName);
                    Popup.show.input = async () => newName;
                    Popup.show.confirm = async () => {
                        confirmAsked = true;
                        return POPUP_RESULT.NEGATIVE;
                    };
                    // The editor switches to the new name as the rename's last step.
                    const onChange = () => {
                        if (String($('#world_editor_select').find(':selected').text()) === newName) {
                            $('#world_editor_select').off('change', onChange);
                            finish();
                        }
                    };
                    $('#world_editor_select').on('change', onChange);
                    document.querySelector('#world_popup_name_button').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                    await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error('rename did not finish')), 15000))]);
                } finally {
                    Popup.show.input = originalInput;
                    Popup.show.confirm = originalConfirm;
                }
                return { confirmAsked, world: create_save.world, extraBooks: [...create_save.extra_books] };
            }, { oldName, newName });

            // No stored character links the book, so there is nothing to ask about.
            expect(confirmAsked).toBe(false);
            expect(world).toBe(newName);
            expect(extraBooks).toEqual([newName, otherName]);
            await expect(page.locator('#character_world')).toHaveValue(newName);
            await expect(globe).toHaveClass(/\bworld_set\b/);
            await expect(globe).not.toHaveClass(/\bwarning\b/);
        } finally {
            await page.evaluate(async () => {
                const { create_save } = await import('/script.js');
                create_save.world = '';
                create_save.extra_books = [];
            });
            await deleteWorlds(page, [oldName, newName, otherName]);
        }
    });
});
