import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { openCharacter } from './llamacpp-mock.js';

// The values the page shows in macros' places come from the server, which fills in the prompts with the same engine
// and the same facts (src/endpoints/macros.js): the page never fills in macros for its own previews.

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

test.beforeEach(testSetup.awaitST);

/**
 * Makes a character whose description is `description`, with the global variable `mood` set, and opens it.
 * @param {import('@playwright/test').Page} page
 * @param {string} description
 */
async function openWithDescription(page, description) {
    const avatar = await page.evaluate(async (description) => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        context.variables.global.set('mood', 'sunny');
        const { saveSettings } = await import('/script.js');
        await saveSettings();
        const form = new FormData();
        form.set('ch_name', `Macro values ${Date.now()}`);
        form.set('first_mes', 'Hello.');
        form.set('description', description);
        const response = await fetch('/api/characters/create', { method: 'POST', headers: context.getRequestHeaders({ omitContentType: true }), body: form });
        return (await response.text()).trim();
    }, description);
    await openCharacter(page, avatar);
}

test('a field\'s preview shows the values the server fills in; a macro run only when sent stays as written', async ({ page }) => {
    const asked = page.waitForRequest(request => request.url().endsWith('/api/macros/values') && request.postData()?.includes('getglobalvar'));
    await openWithDescription(page, 'Feeling {{getglobalvar::mood}}, rolled {{roll::d6}}.');
    await asked;
    const preview = page.locator('.field_preview[data-for="description_textarea"]');
    await expect(preview).toContainText('Feeling sunny, rolled');
    // Shown as written, in its pill: it runs only when sent.
    await expect(preview.locator('.macro-pill[data-macro-name="roll"]')).toHaveCount(1);
});

test('a mention\'s card shows who it names\' description with its macros filled in, its inline markdown rendered', async ({ page }) => {
    await openWithDescription(page, 'I am **{{char}}**, feeling {{getglobalvar::mood}}. ![x](/img/ai4.png)');
    const pill = page.locator('.field_preview[data-for="description_textarea"] .macro-pill[data-macro-name="char"]');
    await expect(pill).toHaveCount(1);
    const name = await pill.textContent();
    await page.locator('#charInfoTabs .tab-title', { has: page.locator('input[value="description"]') }).click();
    await pill.hover();
    const about = page.locator('.macro-tooltip:popover-open .macro-person-about');
    await expect(about).toHaveText(`I am ${name}, feeling sunny.`);
    await expect(about.locator('strong')).toHaveText(String(name));
    await expect(about.locator('img')).toHaveCount(0);
});

test('filled in whole, as the macro preview does, nothing a macro sets is kept', async ({ page }) => {
    await openWithDescription(page, 'Hi.');
    const values = await page.evaluate(async () => {
        const { fetchMacroValues } = await import('/scripts/macro-values.js');
        const { openChatMacroScope } = await import('/script.js');
        const scope = openChatMacroScope();
        const [whole] = await fetchMacroValues(['{{setvar::seen::yes}}{{getvar::seen}} and {{getglobalvar::mood}}'], scope, { all: true });
        const [after] = await fetchMacroValues(['{{getvar::seen}}'], scope);
        // A macro run only when sent isn't filled in one at a time.
        const [roll] = await fetchMacroValues(['{{roll::d6}}'], scope);
        return { whole, after, roll };
    });
    expect(values).toEqual({ whole: 'yes and sunny', after: '', roll: null });
});
