import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} value
 */
async function mount(page, value) {
    await page.evaluate(async (value) => {
        const registry = await import('/scripts/live-editor/registry.js');
        const host = document.createElement('div');
        host.id = 'liveEditorTestHost';
        host.style.cssText = 'position:fixed;top:60px;left:60px;width:600px;z-index:100000;background:#000;color:#fff';
        const textarea = document.createElement('textarea');
        textarea.id = 'liveEditorTestTextarea';
        textarea.value = value;
        host.append(textarea);
        document.body.append(host);
        const inputs = [];
        textarea.addEventListener('input', () => inputs.push(textarea.value));
        const editor = await registry.mountLiveEditor(textarea, {
            search: { builtins: [{ id: 'builtin:upper', name: 'Upper case', group: 'Test', run: (/** @type {string} */ text) => text.toUpperCase() }] },
        });
        editor.view.focus();
        // @ts-ignore
        window.liveEditorTest = { editor, textarea, inputs };
    }, value);
}

/** @param {import('@playwright/test').Page} page */
async function clearPresets(page) {
    await page.evaluate(async () => {
        const { getRequestHeaders } = await import('/script.js');
        const call = (/** @type {string} */ action, /** @type {object} */ body) => fetch(`/api/editor-presets/${action}`, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) }).then(r => r.json());
        const store = await call('get', {});
        for (const preset of store.presets) await call('delete-preset', { id: preset.id });
        for (const list of store.lists) await call('delete-list', { id: list.id });
    });
}

const value = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#liveEditorTestTextarea').inputValue();
const panel = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#liveEditorTestHost .live-presets');

test.describe('live editor find and replace', () => {
    test.beforeEach(testSetup.awaitST);
    test.beforeEach(async ({ page }) => clearPresets(page));
    test.afterEach(async ({ page }) => {
        await clearPresets(page);
        await page.evaluate(() => {
            // @ts-ignore
            window.liveEditorTest?.editor.destroy();
            document.getElementById('liveEditorTestHost')?.remove();
        });
    });

    test('Ctrl+F opens find and replace; replace all is one change, undone at once', async ({ page }) => {
        await mount(page, 'a cat and a cat');
        await page.keyboard.press('Control+f');
        const search = page.locator('#liveEditorTestHost .cm-search');
        await expect(search).toBeVisible();
        await search.locator('input[name="search"]').fill('cat');
        await search.locator('input[name="replace"]').fill('dog');
        await search.locator('button[name="replaceAll"]').click();
        expect(await value(page)).toBe('a dog and a dog');
        await page.locator('#liveEditorTestHost .cm-content').focus();
        await page.keyboard.press('Control+z');
        expect(await value(page)).toBe('a cat and a cat');
    });

    test('the current search saves as a preset that runs as one change; a run that changes nothing writes nothing', async ({ page }) => {
        await mount(page, 'one — two – three');
        await page.keyboard.press('Control+f');
        const search = page.locator('#liveEditorTestHost .cm-search');
        await search.locator('input[name="search"]').fill('[—–]');
        await search.locator('input[name="re"]').check();
        await search.locator('input[name="replace"]').fill('-');
        // The panel takes a typed query on keyup, as when typing it.
        await search.locator('input[name="replace"]').press('End');
        await page.locator('#liveEditorTestHost .live-toolbar-button.fa-wand-magic-sparkles').click();
        await expect(panel(page)).toBeVisible();
        await panel(page).locator('.live-presets-new-name').first().fill('Dashes');
        await panel(page).getByRole('button', { name: 'Save the current search as a preset' }).click();
        const row = panel(page).locator('.live-presets-row', { hasText: 'Dashes' });
        await expect(row).toBeVisible();
        await page.evaluate(() => {
            // @ts-ignore
            window.liveEditorTest.inputs.length = 0;
        });
        await row.getByRole('button', { name: 'Run' }).click();
        expect(await value(page)).toBe('one - two - three');
        // @ts-ignore
        expect(await page.evaluate(() => window.liveEditorTest.inputs.length)).toBe(1);
        await row.getByRole('button', { name: 'Run' }).click();
        await expect(panel(page).locator('.live-presets-status')).toContainText('nothing to change');
        // @ts-ignore
        expect(await page.evaluate(() => window.liveEditorTest.inputs.length)).toBe(1);
    });

    test('ticked presets save as a list that runs them in order', async ({ page }) => {
        await mount(page, 'abc');
        await page.evaluate(async () => {
            const { getRequestHeaders } = await import('/script.js');
            await fetch('/api/editor-presets/save-preset', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name: 'b to x', find: 'b', flags: 'g', replace: 'x' }) });
        });
        await page.locator('#liveEditorTestHost .live-toolbar-button.fa-wand-magic-sparkles').click();
        const userRow = panel(page).locator('.live-presets-row', { hasText: 'b to x' });
        await expect(userRow).toBeVisible();
        await userRow.locator('.live-presets-tick').check();
        await panel(page).locator('.live-presets-row', { hasText: 'Upper case' }).locator('.live-presets-tick').check();
        await panel(page).locator('.live-presets-new-list').fill('Both');
        await panel(page).getByRole('button', { name: 'Save the ticked presets as a list' }).click();
        const listRow = panel(page).locator('.live-presets-row', { hasText: 'Both' });
        await expect(listRow).toBeVisible();
        await listRow.getByRole('button', { name: 'Run' }).click();
        expect(await value(page)).toBe('AXC');
    });
});
