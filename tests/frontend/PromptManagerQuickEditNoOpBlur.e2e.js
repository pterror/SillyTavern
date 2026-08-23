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
    // isn't mistaken for one triggered by the quick-edit textarea under test.
    await page.waitForTimeout(1500);
}

/**
 * The prompt manager's quick-edit textareas only render (and only wire their blur handler's
 * saveServiceSettings up to a real save) under the Chat Completion API, and live inside a
 * collapsed "Quick Prompts Edit" drawer in the AI Response Configuration panel. Get there.
 * @param {import('@playwright/test').Page} page
 */
async function openQuickEditMainTextarea(page) {
    await page.locator('#leftNavDrawerIcon').click();
    // The #main_api <select> is select2-enhanced (a hidden native <select> mirrored by a fake
    // dropdown UI), so Playwright's actionability checks see it as not visible - force bypasses
    // that and sets the underlying value directly, which is what select2 listens to anyway.
    await page.selectOption('#main_api', 'openai', { force: true });
    const drawerToggle = page.locator('.inline-drawer-toggle', { hasText: 'Quick Prompts Edit' });
    await drawerToggle.first().click();
    const textarea = page.locator('#main_prompt_quick_edit_textarea');
    await textarea.waitFor({ state: 'visible', timeout: 10000 });
    // Switching main_api itself fires its own debounced settings save - let that settle before
    // a caller starts listening for saves, so it isn't mistaken for one triggered by the
    // quick-edit textarea under test.
    await page.waitForTimeout(1500);
    return textarea;
}

test.describe('prompt manager quick-edit blur save', () => {
    test.beforeEach(testSetup.awaitST);
    test.beforeEach(async ({ page }) => dismissWelcomePopupIfPresent(page));

    test('blurring a quick-edit textarea without changing its value does not trigger a settings save', async ({ page }) => {
        const textarea = await openQuickEditMainTextarea(page);

        const saveRequests = [];
        page.on('request', (request) => {
            if (request.method() === 'POST' && request.url().endsWith('/api/settings/save')) {
                saveRequests.push(request.url());
            }
        });

        const before = await textarea.inputValue();

        // Simulate exactly the "browser tab/window regains focus" scenario: this field had
        // focus, then something else stole it (e.g. the window losing and regaining focus can
        // blur whatever element was previously active) - without the user ever having edited
        // the value. A plain element.blur() is the faithful way to reproduce that: unlike
        // focusing another element, it doesn't depend on some other specific element being
        // focusable.
        await textarea.focus();
        await textarea.evaluate((el) => el.blur());

        // Give the (previously unconditional) save its full debounce window to fire.
        await page.waitForTimeout(1500);

        await expect(textarea).toHaveValue(before);
        expect(saveRequests).toEqual([]);
    });

    test('blurring a quick-edit textarea after an actual edit still saves', async ({ page }) => {
        const textarea = await openQuickEditMainTextarea(page);

        const saveRequests = [];
        page.on('request', (request) => {
            if (request.method() === 'POST' && request.url().endsWith('/api/settings/save')) {
                saveRequests.push(request.url());
            }
        });

        const before = await textarea.inputValue();

        await textarea.focus();
        await textarea.fill(before + ' (edited by test)');
        await textarea.evaluate((el) => el.blur());

        await page.waitForTimeout(1500);

        expect(saveRequests.length).toBeGreaterThan(0);

        // Restore the original value so the test doesn't leave a permanent edit behind.
        await textarea.focus();
        await textarea.fill(before);
        await textarea.evaluate((el) => el.blur());
        await page.waitForTimeout(1500);
    });
});
