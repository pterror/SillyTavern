import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// The character's name at the top of its info renames it in place: the pen beside it, or a double click on it, turns
// it into a text box; Enter renames (asking, as the dropdown's Rename did, whether past chats follow), Escape doesn't.

/** @param {import('@playwright/test').Page} page @param {string} name */
async function createAndOpen(page, name) {
    const avatar = await page.evaluate(async (name) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.set('ch_name', name);
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        return (await response.text()).trim();
    }, name);
    await openCharacterManagementDrawer(page);
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        await SillyTavern.getContext().getCharacters();
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
    return avatar;
}

const heading = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#rm_button_selected_ch h2');

test('Escape leaves the name; Enter renames it, past chats asked about', async ({ page }) => {
    await testSetup.awaitST({ page });
    const name = `Renamer-${Date.now()}`;
    await createAndOpen(page, name);
    await expect(heading(page)).toHaveText(name);
    await expect(page.locator('#character_rename_inline')).toBeVisible();

    await heading(page).dblclick();
    const box = heading(page).locator('input');
    await expect(box).toBeFocused();
    await expect(box).toHaveValue(name);
    await box.fill('Not this');
    await box.press('Escape');
    await expect(heading(page)).toHaveText(name);

    await page.locator('#character_rename_inline').click();
    await expect(box).toBeFocused();
    await box.fill(`${name} Renamed`);
    await box.press('Enter');
    await page.locator('dialog[open] .popup-button-cancel').click();
    await expect(heading(page)).toHaveText(`${name} Renamed`, { timeout: 15000 });
    // @ts-ignore
    expect(await page.evaluate(() => SillyTavern.getContext().characters[SillyTavern.getContext().characterId].name)).toBe(`${name} Renamed`);
});
