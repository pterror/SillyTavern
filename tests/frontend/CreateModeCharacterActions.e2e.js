import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// While a character is being created, the panel's actions are about that character, which isn't saved yet. The More...
// select's actions on a saved character are off (they used to act on the character whose chat is open: Replace /
// Update overwrote its card), and lorebooks linked in "Link to World Info" are saved with the new character, chat
// open or not (with none open, they used to be dropped).

/** @param {import('@playwright/test').Page} page */
function enabledOptions(page) {
    return page.locator('#char-management-dropdown option').evaluateAll(options => options
        .filter(option => !(/** @type {HTMLOptionElement} */ (option)).disabled)
        .map(option => option.id || 'placeholder'));
}

test.describe('the character panel while creating a character', () => {
    test.beforeEach(testSetup.awaitST);

    test('actions on a saved character are off, and back on for a saved one', async ({ page }) => {
        await page.evaluate(async () => {
            // @ts-ignore
            await SillyTavern.getContext().executeSlashCommandsWithOptions('/go Seraphina');
        });
        await openCharacterManagementDrawer(page);
        await page.locator('#rm_button_create').click();
        await expect(page.locator('#form_create')).toHaveAttribute('actiontype', 'createcharacter');
        expect(await enabledOptions(page)).toEqual(['set_character_world']);
        // The global-styles preference is a saved character's too (it changed the last-opened character's).
        await expect(page.locator('#creators_note_styles_button')).toBeHidden();

        await page.locator('#rm_button_selected_ch').click();
        await expect(page.locator('#form_create')).toHaveAttribute('actiontype', 'editcharacter');
        expect(await enabledOptions(page)).toEqual(expect.arrayContaining(['replace_update', 'import_tags', 'convert_to_persona', 'set_as_assistant']));
        await expect(page.locator('#creators_note_styles_button')).toBeVisible();
    });

    test('a lorebook linked before the character exists is saved with it, with no chat open', async ({ page }) => {
        const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const book = `CreateBook-${s}`;
        await page.evaluate(async (book) => {
            // @ts-ignore
            await SillyTavern.getContext().executeSlashCommandsWithOptions('/closechat');
            const { createNewWorldInfo } = await import('./scripts/world-info.js');
            if (!await createNewWorldInfo(book, { interactive: false })) throw new Error('no book');
        }, book);
        // @ts-ignore
        expect(await page.evaluate(() => SillyTavern.getContext().characterId)).toBeUndefined();

        await openCharacterManagementDrawer(page);
        await page.locator('#rm_button_create').click();
        await page.locator('#character_name_pole').fill(`Linked-${s}`);
        await page.locator('#char-management-dropdown').selectOption({ label: 'Link to World Info' }, { force: true });
        const extras = page.locator('.popup .character_extra_world_info_selector');
        // The popup binds its handlers once it has opened (select2 then dresses the select).
        await expect(page.locator('.popup .select2-container')).toBeVisible();
        await extras.evaluate((select, book) => {
            const option = [...(/** @type {HTMLSelectElement} */ (select)).options].find(o => o.text === book);
            if (!option) throw new Error('book not listed');
            option.selected = true;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }, book);
        await page.keyboard.press('Escape');

        const createResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/characters/create');
        // @ts-ignore
        await page.evaluate(() => $('#create_button').click());
        const avatar = await (await createResponse).text();
        try {
            await expect.poll(() => page.evaluate(async (fileName) => {
                const { world_info } = await import('./scripts/world-info.js');
                return world_info.charLore?.find(entry => entry.name === fileName)?.extraBooks ?? [];
            }, avatar.replace(/\.png$/, ''))).toEqual([book]);
        } finally {
            await page.evaluate(async ({ avatar, book }) => {
                // @ts-ignore
                const headers = SillyTavern.getContext().getRequestHeaders();
                await fetch('/api/characters/delete', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar, delete_chats: true }) });
                const { deleteWorldInfo } = await import('./scripts/world-info.js');
                await deleteWorldInfo(book);
            }, { avatar, book });
        }
    });
});
