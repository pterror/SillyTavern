import { test, expect } from './fixtures.js';
import { testSetup, chatBox } from './frontent-test-utils.js';
import { startLlamaCpp, createCharacter, openCharacter, connectLlamaCpp } from './llamacpp-mock.js';

test('what is typed while a swipe is answered is what Send sends', async ({ page }) => {
    test.setTimeout(90000);
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const mock = await startLlamaCpp({ reply: n => `Mock reply ${n} ${stamp}.` });
    try {
        await testSetup.awaitST({ page });
        const name = `SwipeKeepsTypedText-${stamp}`;
        const avatar = await createCharacter(page, name);
        await openCharacter(page, avatar);
        await connectLlamaCpp(page, mock.url);
        await page.evaluate(async (name) => {
            // @ts-ignore
            const context = stTest.context();
            context.textCompletionSettings.streaming = false;
            await (await import('/script.js')).saveSettings('textgenerationwebui_settings');
            await context.executeSlashCommandsWithOptions('/send hello');
            await context.executeSlashCommandsWithOptions(`/sendas name="${name}" first reply`);
            await context.executeSlashCommandsWithOptions('/addswipe switch=true second reply');
        }, name);
        await expect(page.locator('#chat .last_mes .mes_text')).toHaveText('second reply');

        // The swipe's answer is held so the typing lands while it is in flight, as it does over a slow connection
        let release = () => {};
        const released = new Promise(resolve => { release = () => resolve(undefined); });
        let held = false;
        await page.route('**/api/chats/message/select', async route => {
            held = true;
            await released;
            await route.continue();
        });

        await chatBox(page).click();
        await page.keyboard.press('ArrowLeft');
        await expect.poll(() => held).toBe(true);
        const typed = `typed during the swipe ${stamp}`;
        await page.keyboard.type(typed);
        const generate = page.waitForRequest('**/api/generation/generate');
        await page.keyboard.press('Enter');
        release();

        const sent = (await generate).postDataJSON();
        expect(sent.user_message?.mes).toBe(typed);
    } finally {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await mock.close();
    }
});
