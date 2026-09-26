import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, openInfoTab } from './frontent-test-utils.js';

// NixOS host: the Playwright-managed Chromium download is missing system libs, so fall back
// to the system-provided Chrome (only when explicitly pointed at it) rather than requiring a
// FHS-compatible browser install.
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
 * Creates a fresh, throwaway character and selects it, leaving the definitions panel open on
 * it - the state a user is in right before they click into a field or re-click the character
 * row. Returns its name for later re-selection and cleanup.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>} The created character's name.
 */
async function createAndSelectTestCharacter(page) {
    const name = `CharacterEditorReopenTest-${Date.now()}`;
    await openCharacterManagementDrawer(page);
    await page.locator('#rm_button_create').click();
    await page.locator('#character_name_pole').fill(name);
    await page.locator('#create_button_label').click();
    await page.locator('.character_select', { hasText: name }).first().click();
    await openInfoTab(page, 'description');
    await page.locator('.field_preview[data-for="description_textarea"]').waitFor({ state: 'visible', timeout: 10000 });
    // Selecting a character for the first time legitimately dirties active_character (and, via
    // CHAT_LOADED, may seed a default prompt order) - let that real save settle before a caller
    // starts listening for saves under test.
    await page.waitForTimeout(1500);
    return name;
}

test.describe('character editor reopen settings save', () => {
    test.beforeEach(testSetup.awaitST);

    test('focusing then blurring a definitions field with no edit does not trigger a settings save', async ({ page }) => {
        const name = await createAndSelectTestCharacter(page);

        try {
            const saveRequests = [];
            page.on('request', (request) => {
                if (request.method() === 'POST' && request.url().endsWith('/api/settings/save')) {
                    saveRequests.push(request.url());
                }
            });

            // The owner's actual flow: click into the description field, then click away - zero
            // keystrokes.
            await page.locator('.field_edit_toggle[data-for="description_textarea"]').click();
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

    test('re-clicking the already-open character in the list does not trigger a settings save', async ({ page }) => {
        const name = await createAndSelectTestCharacter(page);
        await page.locator('#rightNavDrawerIcon').click();

        try {
            const saveRequests = [];
            page.on('request', (request) => {
                if (request.method() === 'POST' && request.url().endsWith('/api/settings/save')) {
                    saveRequests.push(request.url());
                }
            });

            // select_selected_character() used to unconditionally queue a settings save every
            // time it ran, including this re-click-the-already-selected-character path.
            await page.locator('.character_select', { hasText: name }).first().click();

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
