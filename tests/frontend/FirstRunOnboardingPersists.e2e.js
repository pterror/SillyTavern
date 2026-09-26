import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures.js';

test.use({ freshAccount: true });

test('the first-run dialog result is saved, so the dialog does not come back', async ({ page, stServer }) => {
    const firstRunFile = path.join(stServer.dataRoot, 'default-user', 'settings', 'firstRun.json');
    const onboardingPopup = page.locator('dialog[open] .onboarding');

    await page.goto('/');
    await expect(onboardingPopup).toBeVisible();
    await page.locator('dialog[open] .popup-button-ok').click();

    await expect.poll(() => JSON.parse(fs.readFileSync(firstRunFile, 'utf8'))).toBe(false);

    await page.reload();
    await page.waitForFunction(() => document.getElementById('preloader') === null || document.querySelector('dialog[open] .onboarding') !== null, null, { timeout: 0 });
    await expect(onboardingPopup).toHaveCount(0);
});
