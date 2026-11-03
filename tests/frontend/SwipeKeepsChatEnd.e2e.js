import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

test('quick swipes at the end of the chat keep it at its end', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await testSetup.awaitST({ page });
    await page.evaluate(async () => {
        // @ts-ignore
        const { executeSlashCommandsWithOptions: run } = stTest.context();
        await run('/go Seraphina');
        for (let i = 0; i < 4; i++) {
            await run(`/send ${'user line '.repeat(30)} ${i}`);
            await run(`/sendas name=Seraphina ${'reply text. '.repeat(80)}\n\n${'more text. '.repeat(80)} ${i}`);
        }
        for (const n of [170, 150, 190, 160]) await run(`/addswipe ${'alt text. '.repeat(n)}\n\n${'alt more. '.repeat(n)}`);
    });
    const chat = page.locator('#chat');
    await chat.evaluate(el => {
        el.scrollTop = el.scrollHeight;
        // @ts-ignore
        window.awayFromEnd = [];
        el.addEventListener('scroll', () => {
            const max = el.scrollHeight - el.clientHeight;
            // @ts-ignore
            if (max - el.scrollTop > 10) window.awayFromEnd.push(`${Math.round(el.scrollTop)} of ${max}`);
        });
    });
    await page.keyboard.press('Escape');
    await page.evaluate(() => /** @type {HTMLElement} */ (document.activeElement)?.blur());
    for (const [key, gap] of /** @type {const} */ ([['ArrowLeft', 600], ['ArrowRight', 600], ['ArrowLeft', 120], ['ArrowRight', 120]])) {
        await chat.evaluate(el => { el.scrollTop = el.scrollHeight; });
        await page.waitForTimeout(1000);
        for (let i = 0; i < 5; i++) {
            await page.keyboard.press(key);
            await page.waitForTimeout(gap);
        }
    }
    await page.waitForTimeout(1000);
    // @ts-ignore
    expect(await page.evaluate(() => window.awayFromEnd)).toEqual([]);
});
