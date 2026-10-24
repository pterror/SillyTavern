import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// Loading the page sets its controls from the settings, and some of their handlers ask for a save (a color picker
// given its color, the context size clamped to the model's): nothing changed, so nothing is sent. A change is.

test('a page load saves no settings; a change does', async ({ page }) => {
    const saves = [];
    page.on('request', request => {
        const path = new URL(request.url()).pathname;
        if (request.method() === 'POST' && path.startsWith('/api/settings/save')) saves.push(`${path} ${request.postData()?.slice(0, 200)}`);
    });
    await testSetup.awaitST({ page });
    // Longer than the settings save's debounce window.
    await page.waitForTimeout(3000);
    expect(saves).toEqual([]);

    await page.evaluate(() => {
        // @ts-ignore
        const { powerUserSettings, saveSettingsDebounced } = SillyTavern.getContext();
        powerUserSettings.main_text_color = powerUserSettings.main_text_color === 'rgb(1, 2, 3)' ? 'rgb(3, 2, 1)' : 'rgb(1, 2, 3)';
        saveSettingsDebounced('power_user.main_text_color');
    });
    await expect.poll(() => saves.length, { timeout: 10000 }).toBe(1);
    expect(saves[0]).toContain('main_text_color');
});
