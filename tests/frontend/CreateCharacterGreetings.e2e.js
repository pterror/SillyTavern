import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, openInfoTab } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

// A new character's greetings, typed in the greeting field before it exists: the first, and one more from the
// pager's add button, are what it is created with.

/** @param {import('@playwright/test').Page} page @param {string} avatar */
function fetchStoredCharacter(page, avatar) {
    return page.evaluate(async (avatarUrl) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        const response = await fetch('/api/characters/get', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatarUrl }) });
        return response.json();
    }, avatar);
}

/** @param {import('@playwright/test').Page} page @param {string} avatar */
async function deleteCharacter(page, avatar) {
    await page.evaluate(async (avatarUrl) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        await fetch('/api/characters/delete', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatarUrl, delete_chats: true }) });
    }, avatar);
}

/** Types into the greeting field through its edit toggle, and confirms. */
async function typeGreeting(page, text) {
    const toggle = page.locator('.field_edit_toggle[data-for="greeting_field"]');
    if (await toggle.isVisible()) await toggle.click();
    const field = page.locator('#greeting_field');
    await expect(field).toBeEditable();
    await field.fill(text);
    const done = page.locator('.field_edit_done[data-for="greeting_field"]');
    if (await done.isVisible()) await done.click();
}

test.describe('creating a character with greetings', () => {
    test.beforeEach(testSetup.awaitST);

    test('the first greeting and an added one are created with it', async ({ page }) => {
        const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const name = `NewGreeter-${s}`;
        await openCharacterManagementDrawer(page);
        await page.locator('#rm_button_create').click();
        await expect(page.locator('#form_create')).toHaveAttribute('actiontype', 'createcharacter');
        await page.locator('#character_name_pole').fill(name);
        await openInfoTab(page, 'greeting');

        await typeGreeting(page, `First ${s}`);
        await expect(page.locator('#greeting_field')).toHaveValue(`First ${s}`);
        await page.locator('.greeting-pager-add').click();
        await typeGreeting(page, `Second ${s}`);
        await expect(page.locator('.greeting-pager-total')).toHaveText('/2');

        const createResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/characters/create');
        await page.evaluate(() => {
            // @ts-ignore
            $('#create_button').click();
        });
        const avatar = await (await createResponse).text();
        try {
            const stored = await fetchStoredCharacter(page, avatar);
            expect(stored.data.first_mes).toBe(`First ${s}`);
            expect(stored.data.alternate_greetings).toEqual([`Second ${s}`]);
        } finally {
            await deleteCharacter(page, avatar);
        }
    });
});
