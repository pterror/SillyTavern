import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// The chat completion fields of the AI response configuration panel, drawn by the new page from the server's settings
// view (packages/ui/src/areas/settings/cc.tsx): an edit is stored as the user's setting, upstream's oai_settings reads
// it, and the old page can't write it any more.

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

test.describe('chat completion settings panel', () => {
    test.beforeEach(testSetup.awaitST);

    test('an edit is stored, and upstream\'s oai_settings reads it', async ({ page }) => {
        const counter = page.locator('#temp_counter_openai');
        await expect(counter).toBeAttached();
        const before = Number(await counter.inputValue());
        const next = before === 0.55 ? '0.65' : '0.55';
        await edit(page, '#temp_counter_openai', next);
        await expect(page.locator('#temp_openai')).toHaveValue(next);
        await expect.poll(async () => (await stored(page)).oai_settings.temp_openai).toBe(Number(next));
        // @ts-ignore
        expect(await page.evaluate(() => SillyTavern.getContext().chatCompletionSettings.temp_openai)).toBe(Number(next));
    });

    test('a value past the model\'s limit is refused and the control goes back', async ({ page }) => {
        await expect(page.locator('#temp_counter_openai')).toBeAttached();
        const before = await page.locator('#temp_counter_openai').inputValue();
        await edit(page, '#temp_counter_openai', '9');
        await expect(page.locator('[data-field="temp_openai"] .settings_refusal')).toContainText('at most');
        await expect(page.locator('#temp_counter_openai')).toHaveValue(before);
    });

    test('an old page save can\'t change a field the server owns', async ({ page }) => {
        await expect(page.locator('#temp_counter_openai')).toBeAttached();
        const before = (await stored(page)).oai_settings.top_p_openai;
        await page.evaluate(async (value) => {
            // @ts-ignore
            const headers = SillyTavern.getContext().getRequestHeaders();
            const keys = { 'oai_settings.top_p_openai': value };
            await fetch('/api/settings/save-partial', { method: 'POST', headers, body: JSON.stringify({ keys }) });
        }, before === 0.31 ? 0.32 : 0.31);
        expect((await stored(page)).oai_settings.top_p_openai).toBe(before);
    });

    test('a choice is stored from its radios, and the header names it', async ({ page }) => {
        await expect(page.locator('#character_names_content')).toBeAttached();
        await page.evaluate(() => /** @type {HTMLInputElement} */ (document.querySelector('#character_names_content')).click());
        await expect(page.locator('#character_names_display')).toHaveText('Message Content');
        await expect.poll(async () => (await stored(page)).oai_settings.names_behavior).toBe(2);
    });

    test('a restore button sets the default prompt', async ({ page }) => {
        await expect(page.locator('#wi_format_textarea')).toBeAttached();
        await edit(page, '#wi_format_textarea', 'custom {0}');
        await expect.poll(async () => (await stored(page)).oai_settings.wi_format).toBe('custom {0}');
        await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('#wi_format_restore')).click());
        await expect(page.locator('#wi_format_textarea')).toHaveValue('{0}');
    });

    test('selecting a preset applies its values before the page says the preset changed', async ({ page }) => {
        await expect(page.locator('#temp_counter_openai')).toBeAttached();
        const name = `PresetTemp-${Date.now()}`;
        await edit(page, '#temp_counter_openai', '0.4');
        await expect(page.locator('#temp_openai')).toHaveValue('0.4');
        const before = await page.evaluate(async (name) => {
            // @ts-ignore
            const manager = SillyTavern.getContext().getPresetManager('openai');
            const before = manager.getSelectedPresetName();
            const { getChatCompletionPreset } = await import('/scripts/chat-completion-settings.js');
            await manager.savePreset(name, getChatCompletionPreset());
            return before;
        }, name);
        // Back to the earlier preset, and a temperature of the user's own over it.
        await page.evaluate(async (before) => {
            // @ts-ignore
            const manager = SillyTavern.getContext().getPresetManager('openai');
            await manager.selectPreset(manager.findPreset(before));
        }, before);
        await edit(page, '#temp_counter_openai', '0.6');
        await expect(page.locator('#temp_openai')).toHaveValue('0.6');
        const heard = await page.evaluate(async (name) => {
            // @ts-ignore
            const context = SillyTavern.getContext();
            /** @type {number[]} */
            const temps = [];
            const listener = () => temps.push(context.chatCompletionSettings.temp_openai);
            context.eventSource.on(context.eventTypes.PRESET_CHANGED, listener);
            const manager = context.getPresetManager('openai');
            await manager.selectPreset(manager.findPreset(name));
            context.eventSource.removeListener(context.eventTypes.PRESET_CHANGED, listener);
            return temps;
        }, name);
        expect((await stored(page)).oai_settings.temp_openai).toBe(0.4);
        expect(heard).toEqual([0.4]);
        await expect(page.locator('#temp_openai')).toHaveValue('0.4');
    });

    test('the maximized editor of a field commits it when it closes', async ({ page }) => {
        await page.evaluate(async () => {
            // @ts-ignore
            const headers = SillyTavern.getContext().getRequestHeaders();
            const keys = { 'oai_settings.chat_completion_source': 'claude' };
            await fetch('/api/settings/save-partial', { method: 'POST', headers, body: JSON.stringify({ keys }) });
        });
        await expect(page.locator('#claude_assistant_prefill')).toBeAttached();
        await page.evaluate(() => /** @type {HTMLElement} */ (document.querySelector('.editor_maximize[data-for="claude_assistant_prefill"]')).click());
        const editor = page.locator('textarea.maximized_textarea');
        await expect(editor).toBeVisible();
        await editor.fill('Sure, here goes:');
        await page.keyboard.press('Escape');
        await expect.poll(async () => (await stored(page)).oai_settings.assistant_prefill).toBe('Sure, here goes:');
        await expect(page.locator('#claude_assistant_prefill')).toHaveValue('Sure, here goes:');
    });
});
