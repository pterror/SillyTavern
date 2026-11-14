import { test, expect } from './fixtures.js';
import { testSetup, openInfoTab } from './frontent-test-utils.js';

/**
 * Opens a new character's scenario in the editor, its toolbar holding find and replace and the presets
 * @param {import('@playwright/test').Page} page
 * @param {string} scenario
 */
async function editScenario(page, scenario) {
    const avatar = await page.evaluate(async (scenario) => {
        // @ts-ignore
        const ctx = stTest.context();
        const form = new FormData();
        form.append('ch_name', `Search-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
        form.append('first_mes', 'Greeting');
        form.append('scenario', scenario);
        const headers = ctx.getRequestHeaders();
        delete headers['Content-Type'];
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        const { power_user } = await import('/scripts/power-user.js');
        power_user.editor_toolbar = ['bold', 'find', 'presets'];
        return (await response.text()).trim();
    }, scenario);
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        await stTest.context().selectCharacterById(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar);
    await openInfoTab(page, 'scenario');
    await page.locator('.field_edit_toggle[data-for="scenario_pole"]').click();
    await expect(editor(page).locator('.cm-content')).toBeFocused();
}

const editor = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#charInfoTab_scenario .chat-editor');
const text = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#scenario_pole').inputValue();
const panel = (/** @type {import('@playwright/test').Page} */ page) => editor(page).locator('.live-presets');

/** @param {import('@playwright/test').Page} page */
async function clearPresets(page) {
    await page.evaluate(async () => {
        const { getRequestHeaders } = await import('/scripts/request-headers.js');
        const call = (/** @type {string} */ action, /** @type {object} */ body) => fetch(`/api/editor-presets/${action}`, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) }).then(r => r.json());
        const store = await call('get', {});
        for (const preset of store.presets) await call('delete-preset', { id: preset.id });
        for (const list of store.lists) await call('delete-list', { id: list.id });
    });
}

test.describe('find and replace in an editor', () => {
    test.beforeEach(testSetup.awaitST);
    test.beforeEach(async ({ page }) => clearPresets(page));
    test.afterEach(async ({ page }) => {
        await clearPresets(page);
        await page.evaluate(async () => {
            const { power_user } = await import('/scripts/power-user.js');
            power_user.editor_toolbar = [];
        });
    });

    test('Ctrl+F opens find and replace; replace all is one change, undone at once', async ({ page }) => {
        await editScenario(page, 'a cat and a cat');
        await page.keyboard.press('Control+f');
        const search = editor(page).locator('.cm-search');
        await expect(search).toBeVisible();
        await search.locator('input[name="search"]').fill('cat');
        await search.locator('input[name="replace"]').fill('dog');
        await search.locator('button[name="replaceAll"]').click();
        expect(await text(page)).toBe('a dog and a dog');
        await editor(page).locator('.cm-content').focus();
        await page.keyboard.press('Control+z');
        expect(await text(page)).toBe('a cat and a cat');
    });

    test('find and replace has the app\'s look: themed buttons, each checkbox on the line of its label', async ({ page }) => {
        await editScenario(page, 'text');
        await page.keyboard.press('Control+f');
        const search = editor(page).locator('.cm-search');
        const button = search.locator('button[name="next"]');
        expect(await button.evaluate(el => getComputedStyle(el).backgroundImage)).toBe('none');
        const label = search.locator('label').first();
        const box = label.locator('input[type="checkbox"]');
        const [labelBox, checkBox] = await Promise.all([label.boundingBox(), box.boundingBox()]);
        expect(Math.abs((labelBox.y + labelBox.height / 2) - (checkBox.y + checkBox.height / 2))).toBeLessThan(4);
    });

    test('the current search saves as a preset that runs as one change; a run that changes nothing changes nothing', async ({ page }) => {
        await editScenario(page, 'one — two – three');
        await page.keyboard.press('Control+f');
        const search = editor(page).locator('.cm-search');
        await search.locator('input[name="search"]').fill('[—–]');
        await search.locator('input[name="re"]').check();
        await search.locator('input[name="replace"]').fill('-');
        await editor(page).getByRole('button', { name: 'Find and replace presets' }).click();
        await expect(panel(page)).toBeVisible();
        await panel(page).locator('.live-presets-new-name').first().fill('Dashes');
        await panel(page).getByRole('button', { name: 'Save the current search as a preset' }).click();
        const row = panel(page).locator('.live-presets-row', { hasText: 'Dashes' });
        await expect(row).toBeVisible();
        await row.getByRole('button', { name: 'Run' }).click();
        expect(await text(page)).toBe('one - two - three');
        await row.getByRole('button', { name: 'Run' }).click();
        await expect(panel(page).locator('.live-presets-status')).toContainText('nothing to change');
        await editor(page).locator('.cm-content').focus();
        await page.keyboard.press('Control+z');
        expect(await text(page)).toBe('one — two – three');
    });

    test('ticked presets save as a list that runs them in order', async ({ page }) => {
        await editScenario(page, 'She *smiled* — b');
        await page.evaluate(async () => {
            const { getRequestHeaders } = await import('/scripts/request-headers.js');
            await fetch('/api/editor-presets/save-preset', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name: 'b to x', find: 'b', flags: 'g', replace: 'x' }) });
        });
        await editor(page).getByRole('button', { name: 'Find and replace presets' }).click();
        const userRow = panel(page).locator('.live-presets-row', { hasText: 'b to x' });
        await expect(userRow).toBeVisible();
        await panel(page).locator('.live-presets-row', { hasText: 'Remove italics' }).locator('.live-presets-tick').check();
        await userRow.locator('.live-presets-tick').check();
        await panel(page).locator('.live-presets-new-list').fill('Both');
        await panel(page).getByRole('button', { name: 'Save the ticked presets as a list' }).click();
        const listRow = panel(page).locator('.live-presets-row', { hasText: 'Both' });
        await expect(listRow).toBeVisible();
        await listRow.getByRole('button', { name: 'Run' }).click();
        expect(await text(page)).toBe('She smiled — x');
    });

    test('the built-in presets run; Escape closes the panel and keeps the edit', async ({ page }) => {
        await editScenario(page, 'She said “hi” — loudly.');
        await editor(page).getByRole('button', { name: 'Find and replace presets' }).click();
        await panel(page).locator('.live-presets-row', { hasText: 'Typography to plain characters' }).getByRole('button', { name: 'Run' }).click();
        expect(await text(page)).toBe('She said "hi" - loudly.');
        await panel(page).getByRole('button', { name: 'Close' }).focus();
        await page.keyboard.press('Escape');
        await expect(panel(page)).toHaveCount(0);
        await expect(editor(page)).toBeVisible();
        await expect(editor(page).locator('.cm-content')).toBeFocused();
    });
});
