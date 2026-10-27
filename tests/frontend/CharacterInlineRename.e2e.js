import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

// The character's name at the top of its info renames it in place: the pen beside it, or a click on it, turns
// it into a text box; Enter renames, past messages showing the new name too, without asking; Escape doesn't.

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

test('Escape leaves the name; Enter renames it, past messages too, without asking', async ({ page }) => {
    await testSetup.awaitST({ page });
    const name = `Renamer-${Date.now()}`;
    await createAndOpen(page, name);
    await expect(heading(page)).toHaveText(name);
    await expect(page.locator('#character_rename_inline')).toBeVisible();

    await heading(page).click();
    const box = heading(page).locator('input');
    await expect(box).toBeFocused();
    await expect(box).toHaveValue(name);
    await box.fill('Not this');
    await box.press('Escape');
    await expect(heading(page)).toHaveText(name);

    await page.locator('#character_rename_inline').click();
    await expect(box).toBeFocused();
    await box.fill(`${name} Renamed`);
    const renamed = page.waitForRequest(request => request.url().endsWith('/api/characters/rename'));
    await box.press('Enter');
    expect((await renamed).postDataJSON()).toMatchObject({ new_name: `${name} Renamed`, rename_past_chats: true });
    await expect(heading(page)).toHaveText(`${name} Renamed`, { timeout: 15000 });
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    // @ts-ignore
    expect(await page.evaluate(() => SillyTavern.getContext().characters[SillyTavern.getContext().characterId].name)).toBe(`${name} Renamed`);
});
