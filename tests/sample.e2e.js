import { test, expect } from './frontend/fixtures.js';

test.describe('sample', () => {
    test.beforeEach(async({ page }) => {
        await page.goto('/');
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
    });

    test('should be titled "SillyTavern"', async ({ page }) => {
        await expect(page).toHaveTitle('SillyTavern');
    });
});
