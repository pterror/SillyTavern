import { test, expect } from './fixtures.js';
import { testSetup, chatBox } from './frontent-test-utils.js';
import { startLlamaCpp, createCharacter, openCharacter, connectLlamaCpp } from './llamacpp-mock.js';

/**
 * A chat whose last reply has two alternatives, "first reply" and "second reply", the second shown
 * @param {import('@playwright/test').Page} page
 * @param {string} url the llama.cpp mock's
 * @returns {Promise<{ avatar: string, name: string, first: string, second: string }>}
 */
async function twoAlternatives(page, url) {
    await testSetup.awaitST({ page });
    const name = `ChatMovesAtOnce-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const avatar = await createCharacter(page, name);
    await openCharacter(page, avatar);
    await connectLlamaCpp(page, url);
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
    const [first, second] = await page.evaluate(() => stTest.context().chat.at(-1).swipe_info.map(info => info.node_id));
    return { avatar, name, first, second };
}

/**
 * Holds every answer to `pattern` until `answer` is called: as a slow connection would
 * @param {import('@playwright/test').Page} page
 * @param {string} pattern
 */
async function holdAnswers(page, pattern) {
    const held = { asked: false, answer: (/** @type {'continue' | 'refuse'} */ _how) => {} };
    const answered = new Promise(resolve => { held.answer = resolve; });
    await page.route(pattern, async route => {
        held.asked = true;
        const how = await answered;
        if (how === 'refuse') await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":true}' });
        else await route.continue();
    });
    return held;
}

/** @param {import('@playwright/test').Page} page */
const swipeDone = page => expect.poll(() => page.evaluate(async () => (await import('/script.js')).swipeState)).toBe('none');

/** @param {import('@playwright/test').Page} page */
const boxText = page => page.evaluate(async () => (await import('/scripts/chat-box.js')).chatBoxText());

test.describe('a move in the chat is made at once', () => {
    /** @type {Awaited<ReturnType<typeof startLlamaCpp>>} */
    let mock;
    test.beforeEach(async () => {
        mock = await startLlamaCpp({ reply: n => `Mock reply ${n}.` });
    });
    test.afterEach(async ({ page }) => {
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await mock.close();
    });

    test('an edit made while a swipe is answered goes to the alternative it was opened on; no other is written over', async ({ page }) => {
        test.setTimeout(90000);
        const { avatar, first } = await twoAlternatives(page, mock.url);
        /** @type {any[]} */
        const edits = [];
        page.on('request', request => {
            if (request.url().includes('/api/chats/message/edit')) edits.push(request.postDataJSON());
        });
        const held = await holdAnswers(page, '**/api/chats/message/select');
        await chatBox(page).click();
        await page.keyboard.press('ArrowLeft');
        await expect.poll(() => held.asked).toBe(true);
        await page.keyboard.press('ArrowUp');
        await expect(page.locator('#chat .last_mes .mes_editor')).toHaveCount(1);
        await page.keyboard.press('End');
        await page.keyboard.type(' edited');
        await page.keyboard.press('Control+Enter');
        await expect(page.locator('#chat .mes_editor')).toHaveCount(0);
        await expect.poll(() => edits.length).toBe(1);
        held.answer('continue');
        await swipeDone(page);

        expect(edits[0].node_id).toBe(first);
        expect(edits[0].patch?.mes ?? edits[0].content?.mes).toBe('first reply edited');
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await page.reload();
        await openCharacter(page, avatar);
        const alternatives = await page.evaluate(async () => {
            const script = await import('/script.js');
            // @ts-ignore
            const chat = stTest.context().chat;
            await script.hydrateSwipes(chat.length - 1, { all: true });
            return chat.at(-1).swipes;
        });
        expect(alternatives).toEqual(['first reply edited', 'second reply']);
    });

    test('an edit opened on an alternative a refused swipe took back is never saved into the one shown instead', async ({ page }) => {
        test.setTimeout(90000);
        const { avatar } = await twoAlternatives(page, mock.url);
        /** @type {any[]} */
        const edits = [];
        page.on('request', request => {
            if (request.url().includes('/api/chats/message/edit')) edits.push(request.postDataJSON());
        });
        const held = await holdAnswers(page, '**/api/chats/message/select');
        await chatBox(page).click();
        await page.keyboard.press('ArrowLeft');
        await expect.poll(() => held.asked).toBe(true);
        await page.keyboard.press('ArrowUp');
        await expect(page.locator('#chat .last_mes .mes_editor')).toHaveCount(1);
        await page.keyboard.press('End');
        await page.keyboard.type(' edited');
        held.answer('refuse');
        await swipeDone(page);
        await page.evaluate(async () => {
            const done = document.querySelector('#chat .last_mes .mes_edit_done');
            if (done instanceof HTMLElement) done.click();
        });
        await page.waitForTimeout(500);

        expect(edits).toEqual([]);
        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await page.reload();
        await openCharacter(page, avatar);
        const alternatives = await page.evaluate(async () => {
            const script = await import('/script.js');
            // @ts-ignore
            const chat = stTest.context().chat;
            await script.hydrateSwipes(chat.length - 1, { all: true });
            return chat.at(-1).swipes;
        });
        expect(alternatives).toEqual(['first reply', 'second reply']);
    });

    test('a Send pressed while a slow swipe is answered sends the text as it was when pressed', async ({ page }) => {
        test.setTimeout(90000);
        await twoAlternatives(page, mock.url);
        const held = await holdAnswers(page, '**/api/chats/message/select');
        await chatBox(page).click();
        await page.keyboard.press('ArrowLeft');
        await expect.poll(() => held.asked).toBe(true);
        await page.keyboard.type('pressed text');
        const generate = page.waitForRequest('**/api/generation/generate');
        await page.locator('#send_but').click();
        await expect(page.locator('#send_but')).toHaveClass(/send_queued/);
        await chatBox(page).click();
        await page.keyboard.type('typed after');
        held.answer('continue');

        expect((await generate).postDataJSON().user_message?.mes).toBe('pressed text');
        await expect(page.locator('#chat .last_mes .mes_text')).toContainText('Mock reply', { timeout: 30000 });
        expect(await boxText(page)).toBe('typed after');
    });

    test('a swipe the server refuses is undone, with a notice, and what was typed stays', async ({ page }) => {
        test.setTimeout(90000);
        const { avatar, second } = await twoAlternatives(page, mock.url);
        const held = await holdAnswers(page, '**/api/chats/message/select');
        await chatBox(page).click();
        await page.keyboard.press('ArrowLeft');
        await expect.poll(() => held.asked).toBe(true);
        await page.keyboard.type('typed meanwhile');
        held.answer('refuse');
        await swipeDone(page);

        await expect(page.locator('#toast-container')).toContainText('Not saved');
        await expect(page.locator('#chat .last_mes .mes_text')).toHaveText('second reply');
        expect(await page.evaluate(() => { const m = stTest.context().chat.at(-1); return { swipe: m.swipe_id, node: m.node_id, mes: m.mes }; })).toEqual({ swipe: 1, node: second, mes: 'second reply' });
        expect(await boxText(page)).toBe('typed meanwhile');
        expect(await page.evaluate(async () => (await import('/scripts/chat-box.js')).leavingChatBox()?.[0]?.owner)).toEqual({ message: second });

        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await page.reload();
        await openCharacter(page, avatar);
        await expect(page.locator('#chat .last_mes .mes_text')).toHaveText('second reply');
    });

    test('what is typed while the chat goes to another branch stays, at the end it went to', async ({ page }) => {
        test.setTimeout(90000);
        await twoAlternatives(page, mock.url);
        await page.locator('#chat .last_mes .swipe_left').click();
        await swipeDone(page);
        await expect(page.locator('#chat .last_mes .mes_text')).toHaveText('first reply');
        const branch = await page.evaluate(async () => {
            // @ts-ignore
            const context = stTest.context();
            await context.executeSlashCommandsWithOptions('/send on the first branch');
            return context.chat.at(-1).node_id;
        });
        await page.locator('#chat .mes[mesid="2"] .swipe_right').click();
        await swipeDone(page);
        await expect(page.locator('#chat .last_mes .mes_text')).toHaveText('second reply');

        const held = await holdAnswers(page, '**/api/chats/message/select');
        await page.evaluate(branch => { void import('/script.js').then(script => script.switchToNode(branch)); }, branch);
        await expect.poll(() => held.asked).toBe(true);
        await chatBox(page).click();
        await page.keyboard.type('typed on the way');
        held.answer('continue');

        await expect(page.locator('#chat .last_mes .mes_text')).toHaveText('on the first branch');
        expect(await boxText(page)).toBe('typed on the way');
        expect(await page.evaluate(async () => (await import('/scripts/chat-box.js')).leavingChatBox()?.[0]?.owner)).toEqual({ message: branch });
    });
});
