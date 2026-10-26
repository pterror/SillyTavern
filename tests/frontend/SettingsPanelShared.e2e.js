import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// The fields the text APIs share (response length, context size, its unlock, each API's streaming), drawn by the new
// page from the server's settings view (packages/areas/settings/page/common.tsx).

/**
 * The stored settings, as the server has them.
 * @param {import('@playwright/test').Page} page
 */
async function stored(page) {
    return page.evaluate(async () => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        const { settings } = await (await fetch('/api/settings/get', { method: 'POST', headers, body: '{}' })).json();
        return JSON.parse(settings);
    });
}

/**
 * Saves settings keys as the old page does (for what isn't the panel's).
 * @param {import('@playwright/test').Page} page
 * @param {Record<string, unknown>} keys
 */
async function savePartial(page, keys) {
    await page.evaluate(async (keys) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
        const response = await fetch('/api/settings/save-partial', { method: 'POST', headers, body: JSON.stringify({ keys }) });
        if (!response.ok) throw new Error(`save-partial: ${response.status}`);
    }, keys);
}

/**
 * Edits a control as the user does (it's in a closed drawer, so by its events).
 * @param {import('@playwright/test').Page} page
 * @param {string} selector
 * @param {string} value
 */
async function edit(page, selector, value) {
    await page.evaluate(({ selector, value }) => {
        const input = /** @type {HTMLInputElement} */ (document.querySelector(selector));
        input.value = value;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }, { selector, value });
}

/** @param {import('@playwright/test').Page} page */
const pageLengths = page => page.evaluate(async () => {
    const params = await import('/scripts/generation-params.js');
    return { amountGen: params.amount_gen, maxContext: params.max_context };
});

test.describe('shared settings panel fields', () => {
    test.beforeEach(testSetup.awaitST);

    test('an edit of the response length is stored, and the old page\'s amount_gen follows it', async ({ page }) => {
        await savePartial(page, { main_api: 'textgenerationwebui', 'textgenerationwebui_settings.type': 'llamacpp' });
        await expect(page.locator('#amount_gen_counter')).toBeAttached();
        await edit(page, '#amount_gen_counter', '333');
        await expect.poll(async () => (await stored(page)).amount_gen).toBe(333);
        await expect.poll(async () => (await pageLengths(page)).amountGen).toBe(333);
    });

    test('a model\'s context fits the context size, unlocking past the locked limit', async ({ page }) => {
        await savePartial(page, { main_api: 'textgenerationwebui', 'textgenerationwebui_settings.type': 'llamacpp' });
        await expect(page.locator('#max_context_counter')).toBeAttached();
        await page.evaluate(async () => {
            const { setGenerationParamsFromPreset } = await import('/script.js');
            await setGenerationParamsFromPreset({ max_length: 32768 });
        });
        await expect.poll(async () => (await pageLengths(page)).maxContext).toBe(32768);
        await expect(page.locator('#max_context_unlocked')).toBeChecked();
        const settings = await stored(page);
        expect(settings.max_context).toBe(32768);
        expect(settings.power_user.max_context_unlocked).toBe(true);
    });

    test('locked again, a context past the limit reads as the limit; the stored size stays', async ({ page }) => {
        await savePartial(page, { main_api: 'textgenerationwebui', 'textgenerationwebui_settings.type': 'llamacpp' });
        await expect(page.locator('#max_context_counter')).toBeAttached();
        await page.evaluate(async () => {
            const { setGenerationParamsFromPreset } = await import('/script.js');
            await setGenerationParamsFromPreset({ max_length: 20000 });
        });
        await expect(page.locator('#max_context_unlocked')).toBeChecked();
        await page.evaluate(() => /** @type {HTMLInputElement} */ (document.querySelector('#max_context_unlocked')).click());
        await expect(page.locator('#max_context_counter')).toHaveValue('8192');
        await expect.poll(async () => (await pageLengths(page)).maxContext).toBe(8192);
        expect((await stored(page)).max_context).toBe(20000);
    });

    test('a NovelAI preset of its own sets the response length from max_length and the context from max_context', async ({ page }) => {
        await savePartial(page, { main_api: 'novel' });
        await expect(page.locator('#amount_gen_counter')).toBeAttached();
        const preset = await page.evaluate(async () => {
            // @ts-ignore
            const manager = SillyTavern.getContext().getPresetManager('novel');
            const names = manager.getAllPresets();
            return names.find((/** @type {string} */ name) => name.includes('Kayra')) ?? names[0];
        });
        const lengths = await page.evaluate(async (name) => {
            // @ts-ignore
            const headers = SillyTavern.getContext().getRequestHeaders();
            const data = await (await fetch('/api/settings/get', { method: 'POST', headers, body: '{}' })).json();
            const file = JSON.parse(data.novelai_settings[data.novelai_setting_names.indexOf(name)]);
            return { response: file.max_length, context: file.max_context, genamt: file.genamt };
        }, preset);
        expect(lengths.genamt).toBeUndefined();
        await page.evaluate(async (name) => {
            // @ts-ignore
            const manager = SillyTavern.getContext().getPresetManager('novel');
            await manager.selectPreset(manager.findPreset(name));
        }, preset);
        await expect.poll(async () => (await stored(page)).amount_gen).toBe(lengths.response);
        expect((await stored(page)).max_context).toBe(lengths.context);
    });
});
