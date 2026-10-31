import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ models: { id: string }[] }} list
 */
async function routeStatus(page, list) {
    await page.route('**/api/backends/text-completions/status', route => route.fulfill({
        json: { result: 'test-backend', data: list.models },
    }));
    await page.route('**/api/backends/text-completions/props', route => route.fulfill({ json: {} }));
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {{ keys?: Record<string, any>, full?: boolean }[]}
 */
function recordSaves(page) {
    const saves = [];
    page.on('request', (request) => {
        if (request.method() !== 'POST') return;
        if (request.url().endsWith('/api/settings/save-partial')) {
            saves.push(JSON.parse(request.postData() ?? '{}'));
        } else if (request.url().endsWith('/api/settings/save')) {
            saves.push({ full: true });
        }
    });
    return saves;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} type
 */
async function connectTextgen(page, type) {
    if (!(await page.locator('#main_api').isVisible())) {
        await page.locator('#API-status-top').click();
        await page.locator('#main_api').waitFor({ state: 'visible' });
    }
    await page.locator('#main_api').selectOption('textgenerationwebui');
    await page.locator('#textgen_type').selectOption(type);
    await page.locator(`#${type}_api_url_text`).fill('http://127.0.0.1:9');
    await page.locator('#api_button_textgenerationwebui').click();
}

const SETTLE_MS = 2500;

test.describe('model pick saves', () => {
    test.beforeEach(testSetup.awaitST);

    test('picking a llama.cpp model sends a save carrying it', async ({ page }) => {
        const list = { models: [{ id: 'model-a' }, { id: 'model-b' }] };
        await routeStatus(page, list);
        await connectTextgen(page, 'llamacpp');
        await expect(page.locator('#llamacpp_model option[value="model-b"]')).toHaveCount(1);
        await page.waitForTimeout(SETTLE_MS);

        const saves = recordSaves(page);
        await page.locator('#llamacpp_model').selectOption('model-b');

        await expect.poll(
            () => saves.some(s => s.keys?.textgenerationwebui_settings?.llamacpp_model === 'model-b'),
            { timeout: 5000 },
        ).toBe(true);
    });

    test('a list missing the saved model sends a save carrying the list default', async ({ page }) => {
        const list = { models: [{ id: 'model-a' }, { id: 'model-b' }] };
        await routeStatus(page, list);
        await connectTextgen(page, 'ollama');
        await expect(page.locator('#ollama_model option[value="model-b"]')).toHaveCount(1);
        await page.locator('#ollama_model').selectOption('model-b');
        await page.waitForTimeout(SETTLE_MS);

        const saves = recordSaves(page);
        list.models = [{ id: 'model-c' }, { id: 'model-d' }];
        await page.locator('#api_button_textgenerationwebui').click();

        await expect.poll(
            () => saves.some(s => s.keys?.textgenerationwebui_settings?.ollama_model === 'model-c'),
            { timeout: 5000 },
        ).toBe(true);
    });

    test('a list that contains the saved model sends no textgen settings save', async ({ page }) => {
        const list = { models: [{ id: 'model-a' }, { id: 'model-b' }] };
        await routeStatus(page, list);
        await connectTextgen(page, 'ollama');
        await expect(page.locator('#ollama_model option[value="model-b"]')).toHaveCount(1);
        await page.locator('#ollama_model').selectOption('model-b');
        await page.waitForTimeout(SETTLE_MS);

        const saves = recordSaves(page);
        await page.locator('#api_button_textgenerationwebui').click();
        await expect(page.locator('#ollama_model')).toHaveValue('model-b');
        await page.waitForTimeout(SETTLE_MS);

        expect(saves.filter(s => s.full || s.keys?.textgenerationwebui_settings)).toEqual([]);
    });
});
