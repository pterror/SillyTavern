import { test, expect } from './fixtures.js';
import { testSetup, chatBox } from './frontent-test-utils.js';
import { startLlamaCpp, createCharacter, openCharacter, connectLlamaCpp } from './llamacpp-mock.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

// A click on Send while a swipe is under way (its slide, or the new alternative being generated) isn't dropped: the
// send is queued, shown on the button, and goes once the swipe is done.

test('a click on Send during a swipe is queued, and sent once the swipe is done', async ({ page }) => {
    test.setTimeout(90000);
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const mock = await startLlamaCpp({ reply: n => `Mock reply ${n} ${stamp}.`, delayMs: 1500 });
    try {
        await testSetup.awaitST({ page });
        const avatar = await createCharacter(page, `SendDuringSwipe-${stamp}`);
        await openCharacter(page, avatar);
        await connectLlamaCpp(page, mock.url);
        // @ts-ignore
        await page.evaluate(() => { SillyTavern.getContext().textCompletionSettings.streaming = false; });

        await chatBox(page).fill(`First question ${stamp}`);
        await page.locator('#send_but').click();
        await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText('Mock reply 1', { timeout: 30000 });
        await expect(page.locator('#send_but')).toBeVisible({ timeout: 30000 });
        await page.waitForTimeout(500);

        const followUp = `Follow-up ${stamp}`;
        await chatBox(page).fill(followUp);
        // A slow slide, so the button is there to click while the swipe is under way.
        await page.evaluate(async () => {
            const { setAnimationDuration } = await import('/script.js');
            setAnimationDuration(1500);
        });
        await page.locator('#chat .mes[mesid="2"] .swipe_right').click();
        const clickedDuringSwipe = await page.evaluate(async () => {
            const script = await import('/script.js');
            const deadline = performance.now() + 5000;
            while (performance.now() < deadline) {
                const shown = getComputedStyle(document.querySelector('#send_but')).display !== 'none';
                if (script.swipeState !== 'none' && shown) {
                    /** @type {HTMLElement} */ (document.querySelector('#send_but')).click();
                    return true;
                }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            return false;
        });
        expect(clickedDuringSwipe).toBe(true);

        // The swipe finishes, then the follow-up is sent after the new alternative.
        await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText('Mock reply 2', { timeout: 30000 });
        await expect(page.locator('#chat .mes[mesid="3"] .mes_text')).toContainText(followUp, { timeout: 30000 });
        await expect(page.locator('#chat .mes[mesid="4"] .mes_text')).toContainText('Mock reply 3', { timeout: 30000 });
    } finally {
        await mock.close();
    }
});
