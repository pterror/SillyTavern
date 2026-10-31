import { test, expect } from './fixtures.js';
import { testSetup, awaitPowerUserSettingStored } from './frontent-test-utils.js';

/** @param {import('@playwright/test').Page} page */
function recordSaves(page) {
    const saves = [];
    page.on('request', request => {
        const path = new URL(request.url()).pathname;
        if (request.method() === 'POST' && path.startsWith('/api/settings/save')) saves.push(`${path} ${request.postData()?.slice(0, 200)}`);
    });
    return saves;
}

test('a page load saves no settings; a change does', async ({ page }) => {
    const saves = recordSaves(page);
    await testSetup.awaitST({ page });
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

test('applying a theme stores its colors and its other settings', async ({ page }) => {
    await testSetup.awaitST({ page });
    const run = (/** @type {string} */ command) => page.evaluate(async (command) => {
        // @ts-ignore
        await SillyTavern.getContext().executeSlashCommandsWithOptions(command);
    }, command);
    const before = await page.evaluate(() => {
        // @ts-ignore
        const { theme, main_text_color, blur_strength } = SillyTavern.getContext().powerUserSettings;
        return { theme, main_text_color, blur_strength };
    });
    await run('/theme Azure');
    try {
        // @ts-ignore
        expect(await page.evaluate(() => SillyTavern.getContext().powerUserSettings.main_text_color)).toBe('rgba(171, 198, 223, 1)');
        for (const key of ['theme', 'main_text_color', 'blur_strength']) await awaitPowerUserSettingStored(page, key);
        await page.reload();
        await testSetup.awaitST({ page });
        const after = await page.evaluate(() => {
            // @ts-ignore
            const { theme, main_text_color, blur_strength } = SillyTavern.getContext().powerUserSettings;
            return { theme, main_text_color, blur_strength };
        });
        expect(after).toEqual({ theme: 'Azure', main_text_color: 'rgba(171, 198, 223, 1)', blur_strength: 11 });
    } finally {
        await run(`/theme ${before.theme}`);
        for (const key of ['theme', 'main_text_color', 'blur_strength']) await awaitPowerUserSettingStored(page, key);
    }
});

test('stored colors are shown after a reload', async ({ page }) => {
    await testSetup.awaitST({ page });
    const before = await page.evaluate(() => {
        // @ts-ignore
        return SillyTavern.getContext().powerUserSettings.main_text_color;
    });
    const color = 'rgba(12, 34, 56, 1)';
    await page.evaluate((color) => {
        // @ts-ignore
        const { powerUserSettings, saveSettingsDebounced } = SillyTavern.getContext();
        powerUserSettings.main_text_color = color;
        saveSettingsDebounced('power_user.main_text_color');
    }, color);
    await awaitPowerUserSettingStored(page, 'main_text_color');
    try {
        await page.reload();
        await testSetup.awaitST({ page });
        expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--SmartThemeBodyColor'))).toBe(color);
    } finally {
        await page.evaluate((color) => {
            // @ts-ignore
            const { powerUserSettings, saveSettingsDebounced } = SillyTavern.getContext();
            powerUserSettings.main_text_color = color;
            saveSettingsDebounced('power_user.main_text_color');
        }, before);
        await awaitPowerUserSettingStored(page, 'main_text_color');
    }
});
