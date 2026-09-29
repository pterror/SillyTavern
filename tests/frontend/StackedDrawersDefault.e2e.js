import { test, expect } from './fixtures.js';

test.use({ freshAccount: true });

test('stacked drawers is off on a new account', async ({ page }) => {
    await page.goto('/');
    await page.locator('dialog[open] .onboarding').waitFor({ state: 'visible' });
    await page.locator('dialog[open] .popup-button-ok').click();
    await page.waitForFunction(() => document.getElementById('preloader') === null, null, { timeout: 0 });
    expect(await page.evaluate(() => window['SillyTavern'].getContext().powerUserSettings.stacked_drawers)).toBe(false);
    await expect(page.locator('body')).not.toHaveClass(/\bstackedDrawers\b/);
    await expect(page.locator('#stackedDrawers')).not.toBeChecked();
});
