import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

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
 * A brand new data root shows a one-time "Welcome to SillyTavern" / persona-setup popup that
 * covers the whole page. Dismiss it (if present) so the panel underneath is actually
 * interactable.
 * @param {import('@playwright/test').Page} page
 */
async function dismissWelcomePopupIfPresent(page) {
    const okButton = page.locator('.popup-button-ok');
    try {
        await okButton.first().waitFor({ state: 'visible', timeout: 5000 });
    } catch {
        return;
    }
    await okButton.first().click();
    await okButton.first().waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    // Dismissing the onboarding popup sets the persona name, which itself fires a legitimate
    // debounced settings save - let that settle before a test starts listening for saves, so it
    // isn't mistaken for one triggered by the flow under test.
    await page.waitForTimeout(1500);
}

/**
 * The bug under test only reaches a live saveServiceSettings() once the Chat Completion API's
 * prompt manager has been set up at least once this session (setupChatCompletionPromptManager()
 * wires promptManager.saveServiceSettings to a real saveSettingsDebounced() call and registers
 * the CHARACTER_EDITED listener that's the subject of this test) - get there first.
 * @param {import('@playwright/test').Page} page
 */
async function switchToChatCompletionApi(page) {
    await page.locator('#leftNavDrawerIcon').click();
    // #main_api is select2-enhanced (a hidden native <select> mirrored by a fake dropdown UI),
    // so Playwright's actionability checks see it as not visible - force bypasses that and sets
    // the underlying value directly, which is what select2 listens to anyway.
    await page.selectOption('#main_api', 'openai', { force: true });
    // Switching main_api itself fires its own debounced settings save - let that settle before a
    // caller starts listening for saves, so it isn't mistaken for one triggered by the character
    // edit under test.
    await page.waitForTimeout(1500);
}

/**
 * Creates a fresh, throwaway character via the "Create New Character" form and leaves the
 * definitions panel open on it (mirroring what a user sees right after creation), returning its
 * name for later cleanup.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string>} The created character's name.
 */
async function createTestCharacter(page) {
    const name = `PromptManagerCharacterEditTest-${Date.now()}`;
    await page.locator('#rm_button_create').click();
    await page.locator('#character_name_pole').fill(name);
    await page.locator('#create_button').click();
    // Creation closes the advanced editing popup and returns to the character list - select the
    // newly created character to reopen the definitions panel on it (the panel a user actually
    // types description/personality/etc into, and the one that emits CHARACTER_EDITED on edit).
    await page.locator('.character_select', { hasText: name }).first().click();
    await page.locator('#description_textarea').waitFor({ state: 'visible', timeout: 10000 });
    // Selecting the character fires its own CHAT_LOADED-driven settings save (prompt order setup
    // for a character that has none yet) - let that settle before a caller starts listening for
    // saves under test.
    await page.waitForTimeout(1500);
    return name;
}

test.describe('prompt manager character-edit settings save', () => {
    test.beforeEach(testSetup.awaitST);
    test.beforeEach(async ({ page }) => dismissWelcomePopupIfPresent(page));

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

            // The flow the owner actually hits: type in a definitions-panel field, then click
            // away (blur) - mirroring "type a message, then click away" for the chatbar.
            await page.locator('#description_textarea').fill('A test character used to check for a stray settings save.');
            await page.locator('#character_name_pole').click();

            // Give saveCharacterDebounced (and, transitively, the old unconditional
            // saveServiceSettings() call) its full debounce window to fire.
            await page.waitForTimeout(2000);

            expect(saveRequests).toEqual([]);
        } finally {
            // Clean up the throwaway character regardless of test outcome.
            await page.locator('#delete_button').click();
            const confirmButton = page.locator('.popup-button-ok');
            await confirmButton.first().waitFor({ state: 'visible', timeout: 5000 });
            await confirmButton.first().click();
            await page.locator('.character_select', { hasText: name }).waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
        }
    });
});
