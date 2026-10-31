import { test, expect } from './fixtures.js';

test.use({ freshAccount: true });

test('the first-run dialog result is saved, so the dialog does not come back', async ({ page }) => {
    const storedFirstRun = () => page.evaluate(async () => {
        const { getRequestHeaders } = await import('./scripts/request-headers.js');
        const data = await (await fetch('/api/settings/get', { method: 'POST', headers: getRequestHeaders(), body: '{}' })).json();
        return JSON.parse(data.settings).firstRun;
    });
    const onboardingPopup = page.locator('dialog[open] .onboarding');

    await page.goto('/');
    await expect(onboardingPopup).toBeVisible();
    await page.locator('dialog[open] .popup-button-ok').click();

    await expect.poll(storedFirstRun).toBe(false);

    await page.reload();
    await page.waitForFunction(() => document.getElementById('preloader') === null || document.querySelector('dialog[open] .onboarding') !== null, null, { timeout: 0 });
    await expect(onboardingPopup).toHaveCount(0);
});
