import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

/**
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

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} backend
 */
async function useBackend(page, backend) {
    await savePartial(page, { main_api: 'textgenerationwebui', 'textgenerationwebui_settings.type': backend });
}

test.describe('text generation settings panel', () => {
    test.beforeEach(testSetup.awaitST);

    test('an edit is stored, and upstream\'s textgenerationwebui_settings reads it', async ({ page }) => {
        await useBackend(page, 'llamacpp');
        await expect(page.locator('#temp_counter_textgenerationwebui')).toBeAttached();
        await edit(page, '#temp_counter_textgenerationwebui', '0.45');
        await expect(page.locator('#temp_textgenerationwebui')).toHaveValue('0.45');
        await expect.poll(async () => (await stored(page)).textgenerationwebui_settings.temp).toBe(0.45);
        // @ts-ignore
        expect(await page.evaluate(() => SillyTavern.getContext().textCompletionSettings.temp)).toBe(0.45);
    });

    test('neutralize sets the samplers; top K is off as each backend takes it', async ({ page }) => {
        await useBackend(page, 'vllm');
        await expect(page.locator('#top_k_counter_textgenerationwebui')).toBeAttached();
        await edit(page, '#temp_counter_textgenerationwebui', '1.6');
        await expect(page.locator('#temp_textgenerationwebui')).toHaveValue('1.6');
        await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('#samplerResetButton')).click());
        await expect(page.locator('#temp_textgenerationwebui')).toHaveValue('1');
        await expect(page.locator('#top_k_textgenerationwebui')).toHaveValue('-1');
        await useBackend(page, 'llamacpp');
        await expect(page.locator('#top_k_textgenerationwebui')).toHaveValue('0');
        expect((await stored(page)).textgenerationwebui_settings.top_k).toBe(-1);
    });

    test('the sampler select decides what shows once prioritized, the old blocks too, and stays after a reload', async ({ page }) => {
        await useBackend(page, 'llamacpp');
        await expect(page.locator('#top_p_textgenerationwebui')).toBeAttached();
        await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('#samplerSelectButton')).click());
        const dialog = page.locator('dialog#sampler_view_list');
        await expect(dialog).toBeVisible();
        await dialog.locator('input[name="temp_checkbox"]').check();
        await dialog.locator('#prioritizeManuallySelectedSamplers').click();
        await expect(dialog.locator('#prioritizeManuallySelectedSamplers')).toHaveClass(/toggleEnabled/);
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(page.locator('#temp_textgenerationwebui')).toBeAttached();
        await expect(page.locator('#top_p_textgenerationwebui')).toHaveCount(0);
        await expect(page.locator('#logit_bias_block_ooba')).toBeHidden();
        await page.reload();
        await testSetup.awaitST({ page });
        await expect(page.locator('#temp_textgenerationwebui')).toBeAttached();
        await expect(page.locator('#top_p_textgenerationwebui')).toHaveCount(0);
        expect((await stored(page)).power_user.sampler_select.llamacpp).toEqual({ manual: true, shown: ['temp'] });
    });

    test('the sampler select the old page kept in the browser moves to the server, once', async ({ page }) => {
        await useBackend(page, 'tabby');
        await page.evaluate(async () => {
            const { localforage } = await import('/lib.js');
            const store = localforage.createInstance({ name: 'SillyTavern_TextCompletions' });
            await store.setItem('selectedSamplers', { tabby: { min_p: true, temp: false, st_manual_priority: true } });
        });
        await page.reload();
        await testSetup.awaitST({ page });
        await expect.poll(async () => (await stored(page)).power_user?.sampler_select?.tabby).toEqual({ manual: true, shown: ['min_p'] });
        await expect.poll(() => page.evaluate(async () => {
            const { localforage } = await import('/lib.js');
            return localforage.createInstance({ name: 'SillyTavern_TextCompletions' }).getItem('selectedSamplers');
        })).toBeNull();
    });
});
