import { devices } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// On a phone a tap on the swipe counter opens the picker, as a click does on a desktop: it opened only on a long press
// there, so a tap did nothing at all.

// The project's browser stays; only the phone's viewport, touch and user agent are taken.
const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = devices['Pixel 7'];
test.use({ viewport, deviceScaleFactor, isMobile, hasTouch, userAgent });

test('a tap on the swipe counter opens the swipe picker on a phone', async ({ page }) => {
    await testSetup.awaitST({ page });
    await page.evaluate(async () => {
        // @ts-ignore
        await SillyTavern.getContext().executeSlashCommandsWithOptions('/go Seraphina');
    });
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 15000 });
    await page.evaluate(async () => {
        // @ts-ignore
        await SillyTavern.getContext().SlashCommandParser.commands['addswipe'].callback({ quiet: 'true' }, 'Another greeting.');
    });
    const counter = page.locator('#chat .mes[mesid="0"] .swipes-counter');
    await expect(counter).toHaveClass(/swipe-picker-enabled/);
    await counter.tap();
    await expect(page.locator('.swipe_picker_popup')).toBeVisible();
});
