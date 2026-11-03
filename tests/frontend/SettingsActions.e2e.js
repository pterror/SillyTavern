import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { startOpenAICompat } from './openai-mock-server.js';

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} type
 * @param {unknown} payload
 */
async function act(page, type, payload) {
    return page.evaluate(async ({ type, payload }) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders();
        const response = await fetch('/api/ui/action', { method: 'POST', headers, body: JSON.stringify({ type, payload }) });
        return response.json();
    }, { type, payload });
}

/** @param {any} answer */
const settingsOf = answer => answer.views.find((/** @type {any} */ v) => v.key === 'settings')?.value;

test.describe('settings actions', () => {
    test.beforeEach(testSetup.awaitST);

    test('a set at the user\'s level is the user\'s settings, as the old page reads them', async ({ page }) => {
        const opened = settingsOf(await act(page, 'view.open', { key: 'settings' }));
        expect(opened.range).toEqual({ from: 'default', to: 'user' });
        const temp = opened.values['oai_settings.temp_openai'] === 0.55 ? 0.65 : 0.55;
        const answer = await act(page, 'settings.set', { path: 'oai_settings.temp_openai', value: temp });
        expect(answer.ok).toBe(true);
        expect(settingsOf(answer).values['oai_settings.temp_openai']).toBe(temp);
        const stored = await page.evaluate(async () => {
            // @ts-ignore
            const headers = stTest.context().getRequestHeaders();
            const { settings } = await (await fetch('/api/settings/get', { method: 'POST', headers, body: '{}' })).json();
            return JSON.parse(settings).oai_settings.temp_openai;
        });
        expect(stored).toBe(temp);
    });

    test('a value its field can\'t have is refused', async ({ page }) => {
        await act(page, 'view.open', { key: 'settings' });
        const answer = await act(page, 'settings.set', { path: 'oai_settings.temp_openai', value: 50 });
        expect(answer).toMatchObject({ ok: false, error: expect.stringMatching(/at most/) });
    });

    test('a range that reaches past the user moves where an edit goes, for this tab', async ({ page }) => {
        await act(page, 'view.open', { key: 'settings' });
        const moved = settingsOf(await act(page, 'settings.range', { from: 'default', to: 'character' }));
        expect(moved.range).toEqual({ from: 'default', to: 'character' });
        const answer = await act(page, 'settings.set', { path: 'oai_settings.top_p_openai', value: 0.9 });
        expect(answer.ok).toBe(true);
        expect(settingsOf(answer).sources['oai_settings.top_p_openai']).toBe('user');
    });

    test('a model list the source answers decides its model\'s limits', async ({ page }) => {
        const mock = await startOpenAICompat({ models: [{ id: 'mock-m', max_context_length: 20000 }] });
        try {
            await page.evaluate(async () => {
                // @ts-ignore
                const headers = stTest.context().getRequestHeaders();
                const keys = { main_api: 'openai', 'oai_settings.chat_completion_source': 'mistralai', 'oai_settings.mistralai_model': 'mock-m' };
                const response = await fetch('/api/settings/save-partial', { method: 'POST', headers, body: JSON.stringify({ keys }) });
                if (!response.ok) throw new Error(`seeding the source failed: ${response.status}`);
            });
            expect(settingsOf(await act(page, 'view.open', { key: 'settings' })).ranges.openai_max_context.max).toBe(32767);
            await page.evaluate(async (url) => {
                // @ts-ignore
                const headers = stTest.context().getRequestHeaders();
                const body = JSON.stringify({ chat_completion_source: 'mistralai', reverse_proxy: url });
                const response = await fetch('/api/backends/chat-completions/status', { method: 'POST', headers, body });
                if (!response.ok) throw new Error(`status failed: ${response.status}`);
            }, mock.url);
            expect(settingsOf(await act(page, 'view.open', { key: 'settings' })).ranges.openai_max_context.max).toBe(20000);
            expect(await act(page, 'settings.set', { path: 'oai_settings.openai_max_context', value: 25000 })).toMatchObject({ ok: false });
        } finally {
            await mock.close();
        }
    });
});
