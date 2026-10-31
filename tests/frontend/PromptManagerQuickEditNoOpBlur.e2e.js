import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

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
async function openQuickEditMainTextarea(page) {
    await page.locator('#leftNavDrawerIcon').click();
    await page.selectOption('#main_api', 'openai', { force: true });
    const drawerToggle = page.locator('.inline-drawer-toggle', { hasText: 'Quick Prompts Edit' });
    await drawerToggle.first().click();
    const textarea = page.locator('#main_prompt_quick_edit_textarea');
    await textarea.waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(1500);
    return textarea;
}

test.describe('prompt manager quick-edit blur save', () => {
    test.beforeEach(testSetup.awaitST);

    test('blurring a quick-edit textarea without changing its value does not trigger a settings save', async ({ page }) => {
        const textarea = await openQuickEditMainTextarea(page);

        const saveRequests = [];
        page.on('request', (request) => {
            if (request.method() === 'POST' && /\/api\/settings\/save(-partial)?$/.test(request.url())) {
                saveRequests.push(request.url());
            }
        });

        const before = await textarea.inputValue();

        await page.locator('#completion_prompt_manager_list li[data-pm-identifier="main"] .prompt-manager-edit-action').click();
        const editFormPrompt = page.locator('#completion_prompt_manager_popup_entry_form_prompt');
        await editFormPrompt.waitFor({ state: 'visible', timeout: 5000 });
        const unsavedDraft = before + ' (unsaved edit form draft)';
        await editFormPrompt.fill(unsavedDraft);

        await textarea.focus();
        await textarea.evaluate((el) => el.blur());

        await page.waitForTimeout(1500);

        await expect(textarea).toHaveValue(before);
        await expect(editFormPrompt).toHaveValue(unsavedDraft);
        expect(saveRequests).toEqual([]);
    });

    test('blurring a quick-edit textarea after an actual edit still saves', async ({ page }) => {
        const textarea = await openQuickEditMainTextarea(page);

        const saveRequests = [];
        page.on('request', (request) => {
            if (request.method() === 'POST' && /\/api\/settings\/save(-partial)?$/.test(request.url())) {
                saveRequests.push(request.url());
            }
        });

        const before = await textarea.inputValue();

        await textarea.focus();
        await textarea.fill(before + ' (edited by test)');
        await textarea.evaluate((el) => el.blur());

        await page.waitForTimeout(1500);

        expect(saveRequests.length).toBeGreaterThan(0);

        await textarea.focus();
        await textarea.fill(before);
        await textarea.evaluate((el) => el.blur());
        await page.waitForTimeout(1500);
    });

    test('an edit in the main quick-edit leaves an edit form open on another prompt alone', async ({ page }) => {
        const textarea = await openQuickEditMainTextarea(page);
        const editFormPrompt = await openEditForm(page, 'jailbreak');
        const jailbreakText = await editFormPrompt.inputValue();

        const before = await textarea.inputValue();
        await textarea.focus();
        await textarea.fill(before + ' (edited by test)');
        await textarea.evaluate((el) => el.blur());

        await expect(editFormPrompt).toHaveValue(jailbreakText);

        await restoreQuickEdit(page, textarea, before);
    });

    test('an edit in the main quick-edit keeps unsaved text in the main prompt edit form', async ({ page }) => {
        const textarea = await openQuickEditMainTextarea(page);
        const editFormPrompt = await openEditForm(page, 'main');

        const before = await textarea.inputValue();
        const unsavedDraft = before + ' (unsaved edit form draft)';
        await editFormPrompt.fill(unsavedDraft);

        await textarea.focus();
        await textarea.fill(before + ' (edited by test)');
        await textarea.evaluate((el) => el.blur());

        await expect(editFormPrompt).toHaveValue(unsavedDraft);

        await restoreQuickEdit(page, textarea, before);
    });
});

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} identifier
 */
async function openEditForm(page, identifier) {
    await page.locator(`#completion_prompt_manager_list li[data-pm-identifier="${identifier}"] .prompt-manager-edit-action`).click();
    const editFormPrompt = page.locator('#completion_prompt_manager_popup_entry_form_prompt');
    await editFormPrompt.waitFor({ state: 'visible', timeout: 5000 });
    return editFormPrompt;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} textarea
 * @param {string} original
 */
async function restoreQuickEdit(page, textarea, original) {
    await textarea.focus();
    await textarea.fill(original);
    await textarea.evaluate((el) => el.blur());
    await page.waitForTimeout(1500);
}
