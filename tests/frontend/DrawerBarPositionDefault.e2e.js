import { test, expect } from './fixtures.js';

test.use({ freshAccount: true });

test('the drawer bar, desktop and mobile, is at the top on a new account', async ({ page }) => {
    await page.goto('/');
    await page.locator('dialog[open] .onboarding').waitFor({ state: 'visible' });
    await page.locator('dialog[open] .popup-button-ok').click();
    await page.waitForFunction(() => document.getElementById('preloader') === null, null, { timeout: 0 });
    const settings = await page.evaluate(() => window['SillyTavern'].getContext().powerUserSettings);
    expect(settings.drawer_bar_position).toBe('top');
    expect(settings.drawer_bar_position_mobile).toBe('top');
    await expect(page.locator('body')).not.toHaveClass(/\bdrawerBarBottom\b/);
    await expect(page.locator('body')).not.toHaveClass(/\bdrawerBarMobileBottom\b/);
    await expect(page.locator('#drawer_bar_position')).toHaveValue('top');
    await expect(page.locator('#drawer_bar_position_mobile')).toHaveValue('top');
});
