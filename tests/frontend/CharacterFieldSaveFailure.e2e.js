import { test, expect } from './fixtures.js';
import { testSetup, openInfoTab } from './frontent-test-utils.js';

// A field save the server refuses is shown as not saved, keeps what was typed, and that text survives a reload.

/**
 * @param {import('@playwright/test').Page} page
 * @param {Record<string, string>} values
 * @returns {Promise<{ avatar: string, name: string }>}
 */
async function createAndOpen(page, values) {
    const name = `SaveFailure-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const avatar = await page.evaluate(async ({ name, values }) => {
        // @ts-ignore
        const ctx = SillyTavern.getContext();
        const form = new FormData();
        form.append('ch_name', name);
        form.append('first_mes', 'Greeting');
        for (const [key, value] of Object.entries(values)) form.append(key, value);
        const headers = ctx.getRequestHeaders();
        delete headers['Content-Type'];
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        return (await response.text()).trim();
    }, { name, values });
    await openCharacter(page, avatar);
    return { avatar, name };
}

/** @param {import('@playwright/test').Page} page @param {string} avatar */
async function openCharacter(page, avatar) {
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        await SillyTavern.getContext().selectCharacterById(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar);
}

/** @param {import('@playwright/test').Page} page @param {string} avatar */
async function stored(page, avatar) {
    return page.evaluate(async (avatar) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        const response = await fetch('/api/characters/get', { method: 'POST', headers, body: JSON.stringify({ avatar_url: avatar }) });
        return (await response.json()).data;
    }, avatar);
}

/** @param {import('@playwright/test').Page} page */
async function failFieldSaves(page) {
    await page.route('**/api/characters/merge-attributes', route => route.fulfill({ status: 500, body: 'injected' }));
}

/** @param {import('@playwright/test').Page} page */
async function typeIntoDescription(page, text) {
    await openInfoTab(page, 'description');
    await page.locator('.field_edit_toggle[data-for="description_textarea"]').click();
    await expect(page.locator('#charInfoTab_description .cm-editor')).toBeVisible();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(text);
}

test.describe('a field save the server refuses', () => {
    test.beforeEach(testSetup.awaitST);

    test('says what wasn\'t saved and keeps the edit open with the typed text', async ({ page }) => {
        const { avatar, name } = await createAndOpen(page, { description: 'stored' });
        await failFieldSaves(page);
        await typeIntoDescription(page, ' typed');
        await page.locator('.field_edit_done[data-for="description_textarea"]').click();

        const toast = page.locator('.toast-error', { hasText: 'was not saved' });
        await expect(toast).toBeVisible();
        await expect(toast).toContainText('description');
        await expect(toast).toContainText(name);
        await expect(page.locator('#charInfoTab_description .cm-editor')).toBeVisible();
        await expect(page.locator('#description_textarea')).toHaveValue('stored typed');
        expect((await stored(page, avatar)).description).toBe('stored');
    });

    test('the typed text survives a reload, and Restore puts it back to be saved', async ({ page }) => {
        const { avatar } = await createAndOpen(page, { description: 'stored' });
        await failFieldSaves(page);
        await typeIntoDescription(page, ' typed');
        await page.locator('.field_edit_done[data-for="description_textarea"]').click();
        await expect(page.locator('.toast-error', { hasText: 'was not saved' })).toBeVisible();

        await page.unroute('**/api/characters/merge-attributes');
        await page.reload();
        await testSetup.awaitST({ page });
        await openCharacter(page, avatar);
        await openInfoTab(page, 'description');

        const notice = page.locator('#charInfoTab_description .field_draft_notice');
        await expect(notice).toBeVisible();
        await notice.locator('.field_draft_restore').click();
        await expect(page.locator('#charInfoTab_description .cm-editor')).toBeVisible();
        await expect(page.locator('#description_textarea')).toHaveValue('stored typed');
        await page.locator('.field_edit_done[data-for="description_textarea"]').click();

        await expect.poll(async () => (await stored(page, avatar)).description).toBe('stored typed');
        await expect(notice).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('CharacterFieldDraft:')))).toEqual([]);
    });

    test('Discard lets the kept text go', async ({ page }) => {
        const { avatar } = await createAndOpen(page, { description: 'stored' });
        await failFieldSaves(page);
        await typeIntoDescription(page, ' typed');
        await page.locator('.field_edit_done[data-for="description_textarea"]').click();
        await expect(page.locator('.toast-error', { hasText: 'was not saved' })).toBeVisible();

        await page.unroute('**/api/characters/merge-attributes');
        await page.reload();
        await testSetup.awaitST({ page });
        await openCharacter(page, avatar);
        await openInfoTab(page, 'description');

        const notice = page.locator('#charInfoTab_description .field_draft_notice');
        await notice.locator('.field_draft_discard').click();
        await expect(notice).toHaveCount(0);
        await expect(page.locator('#description_textarea')).toHaveValue('stored');
        const leftover = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('CharacterFieldDraft:')));
        expect(leftover).toEqual([]);
    });
});
