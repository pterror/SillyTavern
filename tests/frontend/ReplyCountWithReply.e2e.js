import { test, expect } from './fixtures.js';
import { testSetup, chatBox } from './frontent-test-utils.js';
import { startLlamaCpp, createCharacter, openCharacter, connectLlamaCpp } from './llamacpp-mock.js';

/**
 * @param {import('@playwright/test').Page} page
 * @param {boolean} streaming
 */
async function enableCounts(page, streaming) {
    await page.evaluate(async (streaming) => {
        // @ts-ignore
        const context = stTest.context();
        context.powerUserSettings.message_token_count_enabled = true;
        context.textCompletionSettings.streaming = streaming;
        context.saveSettingsDebounced('textgenerationwebui_settings.streaming');
    }, streaming);
    await page.waitForTimeout(2500);
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {string[][]}
 */
function countedTexts(page) {
    /** @type {string[][]} */
    const counted = [];
    page.on('request', (request) => {
        if (new URL(request.url()).pathname !== '/api/tokenizers/count') return;
        try {
            counted.push(JSON.parse(request.postData() ?? '{}').texts ?? []);
        } catch {
            counted.push([request.postData() ?? '']);
        }
    });
    return counted;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} mesId
 */
async function storedCount(page, mesId) {
    // @ts-ignore
    return page.evaluate((mesId) => stTest.context().chat[mesId].extra.token_count, mesId);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} mesId
 * @param {string[][]} counted
 * @param {string} replyText
 */
async function expectStoredCountShown(page, mesId, counted, replyText) {
    const reply = page.locator(`#chat .mes[mesid="${mesId}"]`);
    await expect(page.locator('#send_but')).toBeVisible({ timeout: 30000 });
    await expect.poll(() => page.evaluate((mesId) => {
        // @ts-ignore
        return typeof stTest.context().chat[mesId]?.node_id === 'string';
    }, mesId), { timeout: 10000 }).toBe(true);
    const count = await storedCount(page, mesId);
    expect(typeof count).toBe('number');
    expect(count).toBeGreaterThan(1);
    await expect(reply.locator('.tokenCounterDisplay')).toHaveText(`${count}t`);
    await page.waitForTimeout(500);
    await expect(reply.locator('.tokenCounterDisplay')).toHaveText(`${count}t`);
    expect(counted.flat().filter(text => text === '...' || text.includes(replyText))).toEqual([]);

    await page.evaluate(async () => {
        const { reloadCurrentChat } = await import('/script.js');
        await reloadCurrentChat();
    });
    await expect(reply.locator('.tokenCounterDisplay')).toHaveText(`${count}t`, { timeout: 10000 });
}

for (const streaming of [false, true]) {
    test(`a reply's count comes with the reply, and the counter asks for nothing more (${streaming ? 'streaming' : 'not streaming'})`, async ({ page }) => {
        const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const mock = await startLlamaCpp({ reply: () => `Counted reply ${s}.` });
        try {
            await testSetup.awaitST({ page });
            const avatar = await createCharacter(page, `Count ${s}`, `Greeting ${s}`);
            await openCharacter(page, avatar);
            await connectLlamaCpp(page, mock.url);
            await enableCounts(page, streaming);

            const counted = countedTexts(page);
            await chatBox(page).fill(`Hello ${s}`);
            await page.locator('#send_but').click();
            const reply = page.locator('#chat .mes[mesid="2"]');
            await expect(reply.locator('.mes_text')).toContainText(`Counted reply ${s}`, { timeout: 30000 });
            await expect(reply.locator('.tokenCounterDisplay')).toHaveText(/^\d+t$/);
            await page.waitForTimeout(500);
            expect(counted.flat().filter(text => text.includes(`Counted reply ${s}`))).toEqual([]);
            // @ts-ignore
            expect(await page.evaluate(() => typeof stTest.context().chat[2].extra.text_token_count)).toBe('number');
        } finally {
            await mock.close();
        }
    });
}

test.describe('a streamed reply shows the count it was stored with', () => {
    /** @param {string} s */
    const words = (s) => `Streamed reply ${s} has a good many words in it, one after another.`;

    test('a sent message\'s reply', async ({ page }) => {
        const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const mock = await startLlamaCpp({ reply: () => words(s), delayMs: 1500, pieceDelayMs: 20 });
        try {
            await testSetup.awaitST({ page });
            const avatar = await createCharacter(page, `Stream count ${s}`, `Greeting ${s}`);
            await openCharacter(page, avatar);
            await connectLlamaCpp(page, mock.url);
            await enableCounts(page, true);

            const counted = countedTexts(page);
            await chatBox(page).fill(`Hello ${s}`);
            await page.locator('#send_but').click();
            await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText('one after another', { timeout: 30000 });
            await expectStoredCountShown(page, 2, counted, `Streamed reply ${s}`);
        } finally {
            await mock.close();
        }
    });

    test('a swipe, and a continue', async ({ page }) => {
        const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const mock = await startLlamaCpp({ reply: n => `${words(s)} Take ${n}.`, delayMs: 1500, pieceDelayMs: 20 });
        try {
            await testSetup.awaitST({ page });
            const avatar = await createCharacter(page, `Swipe count ${s}`, `Greeting ${s}`);
            await openCharacter(page, avatar);
            await connectLlamaCpp(page, mock.url);
            await enableCounts(page, true);

            await chatBox(page).fill(`Hello ${s}`);
            await page.locator('#send_but').click();
            await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText('Take 1.', { timeout: 30000 });
            await expect(page.locator('#send_but')).toBeVisible({ timeout: 30000 });

            const swiped = countedTexts(page);
            await page.locator('#chat .mes[mesid="2"] .swipe_right').click();
            await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText('Take 2.', { timeout: 30000 });
            await expectStoredCountShown(page, 2, swiped, 'Take 2.');

            const before = await storedCount(page, 2);
            const continued = countedTexts(page);
            // @ts-ignore
            await page.evaluate(() => stTest.context().generate('continue'));
            await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText('Take 3.', { timeout: 30000 });
            await expectStoredCountShown(page, 2, continued, 'Take 3.');
            expect(await storedCount(page, 2)).toBeGreaterThan(before);
        } finally {
            await mock.close();
        }
    });

    test('a reply stopped early', async ({ page }) => {
        const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
        const mock = await startLlamaCpp({ reply: () => `Stopped ${s} ${long}`, delayMs: 1500, pieceDelayMs: 50 });
        try {
            await testSetup.awaitST({ page });
            const avatar = await createCharacter(page, `Stop count ${s}`, `Greeting ${s}`);
            await openCharacter(page, avatar);
            await connectLlamaCpp(page, mock.url);
            await enableCounts(page, true);

            const counted = countedTexts(page);
            await chatBox(page).fill(`Hello ${s}`);
            await page.locator('#send_but').click();
            await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText('word5', { timeout: 30000 });
            await page.locator('#mes_stop').click();
            await expectStoredCountShown(page, 2, counted, `Stopped ${s}`);
            // @ts-ignore
            expect(await page.evaluate(() => stTest.context().chat[2].mes)).not.toContain('word199');
        } finally {
            await mock.close();
        }
    });

    test('a group member\'s reply', async ({ page }) => {
        const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const mock = await startLlamaCpp({ reply: () => words(s), delayMs: 1500, pieceDelayMs: 20 });
        try {
            await testSetup.awaitST({ page });
            const avatar = await createCharacter(page, `Group count ${s}`, `Greeting ${s}`);
            await openCharacter(page, avatar);
            await connectLlamaCpp(page, mock.url);
            await enableCounts(page, true);
            const groupId = await page.evaluate(async (members) => {
                // @ts-ignore
                const context = stTest.context();
                const response = await fetch('/api/groups/create', { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ name: `Count group ${Date.now()}`, members }) });
                if (!response.ok) throw new Error(`group create failed: ${response.status}`);
                const id = String((await response.json()).id);
                const { openGroupById } = await import('/scripts/group-chats.js');
                await openGroupById(id);
                return id;
            }, [avatar]);
            expect(groupId).toBeTruthy();
            await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);

            const counted = countedTexts(page);
            await chatBox(page).fill(`Hello ${s}`);
            await page.locator('#send_but').click();
            await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText('one after another', { timeout: 30000 });
            await expectStoredCountShown(page, 2, counted, `Streamed reply ${s}`);
        } finally {
            await mock.close();
        }
    });
});
