import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ volume: number, autoplay: boolean }} settings
 */
async function sendAudio(page, settings) {
    return page.evaluate(async (settings) => {
        const { power_user } = await import('/scripts/power-user.js');
        power_user.media_volume = settings.volume;
        power_user.media_autoplay = settings.autoplay;
        // @ts-ignore
        const ctx = SillyTavern.getContext();
        await ctx.SlashCommandParser.commands['send'].callback({}, `<audio controls autoplay src="/sounds/message.mp3"></audio> ${Date.now()}`);
        return ctx.chat.length - 1;
    }, settings);
}

test('audio in a message starts at the user\'s volume and waits to be played; allowed, it may start itself', async ({ page }) => {
    await testSetup.awaitST({ page });
    await page.evaluate(async () => {
        // @ts-ignore
        await SillyTavern.getContext().executeSlashCommandsWithOptions('/go Seraphina');
    });
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1, { timeout: 10000 });

    const quiet = await sendAudio(page, { volume: 20, autoplay: false });
    const audio = page.locator(`#chat .mes[mesid="${quiet}"] .mes_text audio`);
    await expect(audio).toHaveCount(1);
    expect(await audio.getAttribute('autoplay')).toBeNull();
    await expect.poll(() => audio.evaluate(el => /** @type {HTMLMediaElement} */ (el).volume)).toBeCloseTo(0.2);

    const allowed = await sendAudio(page, { volume: 70, autoplay: true });
    const playing = page.locator(`#chat .mes[mesid="${allowed}"] .mes_text audio`);
    await expect(playing).toHaveCount(1);
    expect(await playing.getAttribute('autoplay')).not.toBeNull();
    await expect.poll(() => playing.evaluate(el => /** @type {HTMLMediaElement} */ (el).volume)).toBeCloseTo(0.7);
});
