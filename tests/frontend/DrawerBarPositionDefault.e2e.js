import { test, expect } from './fixtures.js';

test.use({ freshAccount: true });

test('the drawer bar is at the top on a new account', async ({ page }) => {
    await page.goto('/');
    await page.locator('dialog[open] .onboarding').waitFor({ state: 'visible' });
    await page.locator('dialog[open] .popup-button-ok').click();
    await page.waitForFunction(() => document.getElementById('preloader') === null, null, { timeout: 0 });
    expect(await page.evaluate(() => window['SillyTavern'].getContext().powerUserSettings.drawer_bar_position)).toBe('top');
    await expect(page.locator('body')).not.toHaveClass(/\bdrawerBarBottom\b/);
    await expect(page.locator('#drawer_bar_position')).toHaveValue('top');
});
