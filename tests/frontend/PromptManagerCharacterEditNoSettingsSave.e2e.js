import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, openInfoTab } from './frontent-test-utils.js';

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

/**
 * @param {import('@playwright/test').Page} page
 */
async function switchToChatCompletionApi(page) {
    await page.locator('#leftNavDrawerIcon').click();
    await page.selectOption('#main_api', 'openai', { force: true });
    await page.waitForTimeout(1500);
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>}
 */
async function createTestCharacter(page) {
    const name = `PromptManagerCharacterEditTest-${Date.now()}`;
    await openCharacterManagementDrawer(page);
    await page.locator('#rm_button_create').click();
    await page.locator('#character_name_pole').fill(name);
    await page.locator('#create_button_label').click();
    await page.waitForFunction(n => window['stTest'].context().name2 === n, name);
    await openInfoTab(page, 'description');
    await page.locator('.field_preview[data-for="description_textarea"]').waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(1500);
    return name;
}

test.describe('prompt manager character-edit settings save', () => {
    test.beforeEach(testSetup.awaitST);

    test('editing a character definition field does not trigger a settings save', async ({ page }) => {
        await switchToChatCompletionApi(page);
        const name = await createTestCharacter(page);

        try {
            const saveRequests = [];
            page.on('request', (request) => {
                if (request.method() === 'POST' && request.url().endsWith('/api/settings/save')) {
                    saveRequests.push(request.url());
                }
            });

            await page.locator('.field_edit_toggle[data-for="description_textarea"]').click();
            await page.locator('#description_textarea').fill('A test character used to check for a stray settings save.');
            await page.locator('.field_edit_done[data-for="description_textarea"]').click();
            await page.locator('#creator_textarea').click();

            await page.waitForTimeout(2000);

            expect(saveRequests).toEqual([]);
        } finally {
            await page.locator('#delete_button').click();
            const confirmButton = page.locator('.popup-button-ok');
            await confirmButton.first().waitFor({ state: 'visible', timeout: 5000 });
            await confirmButton.first().click();
            await page.locator('.character_select', { hasText: name }).waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
        }
    });
});
