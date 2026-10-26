import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// The settings area's actions against the real server and settings document (packages/server-ui/src/settings.ts):
// the panel isn't on the new page yet, so these go through /api/ui/action as the page's client will.

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} type
 * @param {unknown} payload
 */
async function act(page, type, payload) {
    return page.evaluate(async ({ type, payload }) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders();
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
            const headers = SillyTavern.getContext().getRequestHeaders();
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
        // No chat open: there's no character's level to write, so the edit is the user's.
        const answer = await act(page, 'settings.set', { path: 'oai_settings.top_p_openai', value: 0.9 });
        expect(answer.ok).toBe(true);
        expect(settingsOf(answer).sources['oai_settings.top_p_openai']).toBe('user');
    });
});
