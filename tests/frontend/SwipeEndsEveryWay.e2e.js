import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// A swipe that can't generate (here: Horde refuses the GUI preset) is refused by the generation alone. Swiping between
// existing alternatives needs no generation and still works, and so does every later swipe. Before: every swipe was
// refused with that setting, and a swipe that stopped early left the swipe state set until a reload.

test('a refused generation on swipe leaves the message as it was and swiping working', async ({ page }) => {
    await testSetup.awaitST({ page });
    await page.evaluate(async () => {
        // @ts-ignore
        const { executeSlashCommandsWithOptions: run } = SillyTavern.getContext();
        await run('/go Seraphina');
        await run('/send hello');
        await run('/sendas name=Seraphina first reply');
        await run('/addswipe switch=true second reply');
        const { kai_settings } = await import('/scripts/kai-settings.js');
        kai_settings.preset_settings = 'gui';
    });
    await page.selectOption('#main_api', 'koboldhorde', { force: true });
    // @ts-ignore
    await expect.poll(() => page.evaluate(() => SillyTavern.getContext().mainApi)).toBe('koboldhorde');
    const last = () => page.evaluate(() => {
        // @ts-ignore
        const message = SillyTavern.getContext().chat.at(-1);
        return { id: message.swipe_id, count: message.swipes.length, text: message.mes };
    });
    await expect.poll(last).toEqual({ id: 1, count: 2, text: 'second reply' });
    await page.keyboard.press('Escape');
    await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.blur());

    // Past the last alternative: a generation, which Horde refuses.
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#toast-container')).toContainText('GUI Settings preset is not supported for Horde');
    await expect.poll(last).toEqual({ id: 1, count: 2, text: 'second reply' });
    await expect(page.locator('#chat .last_mes .mes_text')).toHaveText('second reply');

    await page.keyboard.press('ArrowLeft');
    await expect.poll(last).toEqual({ id: 0, count: 2, text: 'first reply' });
    await expect(page.locator('#chat .last_mes .mes_text')).toHaveText('first reply');
    // A key pressed while a swipe is still animating is ignored, as a held key's repeats are.
    await expect.poll(() => page.evaluate(async () => (await import('/script.js')).swipeState)).toBe('none');
    await page.keyboard.press('ArrowRight');
    await expect.poll(last).toEqual({ id: 1, count: 2, text: 'second reply' });
});
