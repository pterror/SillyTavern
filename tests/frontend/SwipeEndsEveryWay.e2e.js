import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { connectLlamaCpp, startLlamaCpp } from './llamacpp-mock.js';

test('a refused generation on swipe leaves the message as it was and swiping working', async ({ page }) => {
    const model = await startLlamaCpp();
    try {
        await testSetup.awaitST({ page });
        await page.evaluate(async () => {
            // @ts-ignore
            const { executeSlashCommandsWithOptions: run } = stTest.context();
            await run('/go Seraphina');
            await run('/send hello');
            await run('/sendas name=Seraphina first reply');
            await run('/addswipe switch=true second reply');
        });
        await connectLlamaCpp(page, model.url);
        model.state.failCompletion = true;
        const last = () => page.evaluate(() => {
            // @ts-ignore
            const message = stTest.context().chat.at(-1);
            return { id: message.swipe_id, count: message.swipes.length, text: message.mes };
        });
        await expect.poll(last).toEqual({ id: 1, count: 2, text: 'second reply' });
        await page.keyboard.press('Escape');
        await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.blur());

        const refused = page.waitForResponse(response => response.url().endsWith('/api/generation/generate'));
        await page.keyboard.press('ArrowRight');
        await (await refused).finished();
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).swipeState)).toBe('none');
        await expect.poll(last).toEqual({ id: 1, count: 2, text: 'second reply' });
        await expect(page.locator('#chat .last_mes .mes_text')).toHaveText('second reply');

        await page.keyboard.press('ArrowLeft');
        await expect.poll(last).toEqual({ id: 0, count: 2, text: 'first reply' });
        await expect(page.locator('#chat .last_mes .mes_text')).toHaveText('first reply');
        await expect.poll(() => page.evaluate(async () => (await import('/script.js')).swipeState)).toBe('none');
        await page.keyboard.press('ArrowRight');
        await expect.poll(last).toEqual({ id: 1, count: 2, text: 'second reply' });
    } finally {
        await model.close();
    }
});
