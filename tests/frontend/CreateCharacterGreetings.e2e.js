import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, openInfoTab } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
function fetchStoredCharacter(page, avatar) {
    return page.evaluate(async (avatarUrl) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        const response = await fetch('/api/characters/get', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatarUrl }) });
        return response.json();
    }, avatar);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function deleteCharacter(page, avatar) {
    await page.evaluate(async (avatarUrl) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        await fetch('/api/characters/delete', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatarUrl, delete_chats: true }) });
    }, avatar);
}

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

    test('tags picked in the create form are stored with the new character and shown on it', async ({ page }) => {
        const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        await openCharacterManagementDrawer(page);
        await page.locator('#rm_button_create').click();
        await page.locator('#character_name_pole').fill(`Tagged-${s}`);
        await page.locator('#tagInput').click();
        await page.locator('#tagInput').fill(`tag-${s}`);
        await page.locator('.ui-autocomplete:visible li').first().click();
        const tag = page.locator('#tagList .tag', { hasText: `tag-${s}` });
        await expect(tag).toHaveCount(1);
        const tagId = await tag.getAttribute('id');

        const createRequest = page.waitForRequest(request => new URL(request.url()).pathname === '/api/characters/create');
        const createResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/characters/create');
        await page.evaluate(() => {
            // @ts-ignore
            $('#create_button').click();
        });
        expect((await createRequest).postData()).toContain(tagId);
        const avatar = await (await createResponse).text();
        try {
            await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
            await expect(page.locator('#tagList .tag', { hasText: `tag-${s}` })).toHaveCount(1);
            await page.reload();
            await testSetup.awaitST({ page });
            await openCharacterManagementDrawer(page);
            await expect(page.locator(`.character_select[data-avatar="${avatar}"] .tag`, { hasText: `tag-${s}` }).first()).toBeVisible({ timeout: 10000 });
        } finally {
            await deleteCharacter(page, avatar);
        }
    });

    test('the first greeting is added in the inline editor: in the create form with New greeting, and once created', async ({ page }) => {
        const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        await openCharacterManagementDrawer(page);
        await page.locator('#rm_button_create').click();
        await page.locator('#character_name_pole').fill(`InlineFirst-${s}`);
        await openInfoTab(page, 'greeting');
        await page.locator('.greeting-pager-add').click();
        await page.locator('#charInfoTab_greeting .cm-content').click();
        await page.keyboard.type(`First ${s}`);
        await page.locator('.field_edit_done[data-for="greeting_field"]').click();
        await expect(page.locator('.greeting-pager-total')).toHaveText('/1');
        const createResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/characters/create');
        await page.evaluate(() => {
            // @ts-ignore
            $('#create_button').click();
        });
        const avatar = await (await createResponse).text();
        await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
        const createResponse2 = page.waitForResponse(response => new URL(response.url()).pathname === '/api/characters/create');
        await openCharacterManagementDrawer(page);
        await page.locator('#rm_button_create').click();
        await page.locator('#character_name_pole').fill(`InlineLater-${s}`);
        await page.evaluate(() => {
            // @ts-ignore
            $('#create_button').click();
        });
        const avatar2 = await (await createResponse2).text();
        try {
            const first = await fetchStoredCharacter(page, avatar);
            expect(first.data.first_mes).toBe(`First ${s}`);
            expect(first.data.alternate_greetings).toEqual([]);

            await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar2, { timeout: 10000 });
            await openInfoTab(page, 'greeting');
            await page.locator('.field_edit_toggle[data-for="greeting_field"]').click();
            await page.locator('#charInfoTab_greeting .cm-content').click();
            await page.keyboard.type(`Later ${s}`);
            await page.locator('.field_edit_done[data-for="greeting_field"]').click();
            await expect(page.locator('#charInfoTab_greeting')).not.toHaveClass(/field_editing/, { timeout: 10000 });
            await expect.poll(async () => (await fetchStoredCharacter(page, avatar2)).data.first_mes, { timeout: 10000 }).toBe(`Later ${s}`);
        } finally {
            await deleteCharacter(page, avatar);
            await deleteCharacter(page, avatar2);
        }
    });
});
