import { expect } from './fixtures.js';

export { startOpenAICompat } from './openai-mock-server.js';

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} url
 * @param {string} [model]
 */
export async function connectOpenAICompat(page, url, model = 'mock-chat-model') {
    if (!(await page.locator('#main_api').isVisible())) {
        await page.locator('#API-status-top').click();
        await page.locator('#main_api').waitFor({ state: 'visible' });
    }
    await page.selectOption('#main_api', 'openai', { force: true });
    await page.locator('#chat_completion_source').selectOption('custom');
    await page.locator('#custom_api_url_text').fill(url);
    await page.locator('#custom_model_id').fill(model);
    // @ts-ignore
    await page.evaluate(() => { for (const id of ['#custom_api_url_text', '#custom_model_id']) { const field = $(id); if (field.autocomplete('instance')) field.autocomplete('close'); } });
    await page.locator('#api_button_openai').click();
    // @ts-ignore
    await expect.poll(() => page.evaluate(() => SillyTavern.getContext().onlineStatus), { timeout: 15000 }).not.toBe('no_connection');
    await page.locator('#API-status-top').click();
    await page.waitForTimeout(2500);
}
