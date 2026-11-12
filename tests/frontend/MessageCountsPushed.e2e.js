import { test, expect } from './fixtures.js';
import { testSetup, chatBox } from './frontent-test-utils.js';
import { startLlamaCpp, createCharacter, openCharacter, connectLlamaCpp } from './llamacpp-mock.js';

/**
 * @param {import('@playwright/test').Page} page
 */
async function enableCounts(page, streaming = false) {
    await page.evaluate(async (streaming) => {
        // @ts-ignore
        const context = stTest.context();
        context.powerUserSettings.message_token_count_enabled = true;
        context.textCompletionSettings.streaming = streaming;
        await (await import('/script.js')).saveSettings();
    }, streaming);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @param {string[]} texts
 */
async function appendMessages(page, avatar, texts) {
    await page.evaluate(async ({ avatar, texts }) => {
        // @ts-ignore
        const context = stTest.context();
        const { ensureOpeningRow } = await import('/scripts/chat-store.js');
        const opening = await ensureOpeningRow(0);
        const response = await fetch('/api/chats/message/append', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, after_node_id: opening, messages: texts.map((mes, i) => ({ name: i % 2 ? 'Bot' : 'User', is_user: i % 2 === 0, mes, send_date: new Date().toISOString(), extra: {} })) }),
        });
        if (!response.ok) throw new Error(`append failed: ${response.status}`);
    }, { avatar, texts });
}

/**
 * @param {import('@playwright/test').Page} page
 */
async function reopenChat(page) {
    await page.evaluate(async () => {
        const { openCharacterChat, getCurrentChatId } = await import('/script.js');
        await openCharacterChat(getCurrentChatId());
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {string[]}
 */
function countRequests(page) {
    /** @type {string[]} */
    const seen = [];
    page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (path === '/api/tokenizers/count' || path === '/api/tokenizers/current/count') seen.push(request.postData() ?? '');
    });
    return seen;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} mesId
 */
function counter(page, mesId) {
    return page.locator(`#chat .mes[mesid="${mesId}"] .tokenCounterDisplay`);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
async function setUp(page, name, { streaming = false, mockOptions = {} } = {}) {
    const mock = await startLlamaCpp(mockOptions);
    await testSetup.awaitST({ page });
    const avatar = await createCharacter(page, name, `Greeting of ${name}`);
    await openCharacter(page, avatar);
    await connectLlamaCpp(page, mock.url);
    await enableCounts(page, streaming);
    return { mock, avatar };
}

/**
 * @param {import('@playwright/test').Page} page
 */
function generating(page) {
    // @ts-ignore
    return page.evaluate(() => stTest.context().chat.some((_, mesId) => stTest.context().isReplyGenerating?.(mesId)) || document.querySelector('#mes_stop')?.checkVisibility());
}

test('counts the server has to make come after the answer, newest first, into counters that keep their place', async ({ page }) => {
    const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const { mock, avatar } = await setUp(page, `Pushed ${s}`);
    try {
        const texts = Array.from({ length: 8 }, (_, i) => `Message ${i} of ${s} has some words in it`);
        mock.state.tokenizeDelayMs = 700;
        mock.log.length = 0;
        const requested = countRequests(page);
        await appendMessages(page, avatar, texts);

        await reopenChat(page);
        await expect(page.locator('#chat .mes')).toHaveCount(texts.length + 1);
        await expect(counter(page, texts.length)).toHaveText('…');
        const waitingHeight = (await counter(page, texts.length).boundingBox())?.height;
        await expect(counter(page, texts.length)).toHaveText(/^\d+t$/, { timeout: 15000 });
        for (let mesId = 1; mesId <= texts.length; mesId++) await expect(counter(page, mesId)).toHaveText(/^\d+t$/, { timeout: 15000 });
        expect((await counter(page, texts.length).boundingBox())?.height).toBe(waitingHeight);

        const tokenized = mock.log.filter(entry => entry.url.startsWith('/tokenize')).map(entry => String(entry.body.content ?? ''));
        const order = tokenized.map(content => texts.findIndex(text => content.includes(text))).filter(i => i >= 0);
        expect(order[0]).toBe(texts.length - 1);
        expect(requested).toEqual([]);
    } finally {
        await mock.close();
    }
});

test('a pushed count for another tokenizer or another text is not shown', async ({ page }) => {
    const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const { mock, avatar } = await setUp(page, `Stale ${s}`);
    try {
        mock.state.tokenizeDelayMs = 3000;
        await appendMessages(page, avatar, [`Only message of ${s} with words`]);
        await reopenChat(page);
        await expect(counter(page, 1)).toHaveText('…');
        await page.evaluate(async () => {
            // @ts-ignore
            const message = stTest.context().chat[1];
            const { countedTextHash } = await import('/scripts/counted-text.js');
            const { takePushedMessageCounts } = await import('/scripts/chat-store.js');
            takePushedMessageCounts([
                { node_id: message.node_id, hash: countedTextHash(message.extra, message.mes), key: 'another tokenizer', count: 999 },
                { node_id: message.node_id, hash: countedTextHash(message.extra, `${message.mes} changed`), key: message.extra.token_count_waiting, count: 998 },
            ]);
        });
        await expect(counter(page, 1)).toHaveText('…');
        await expect(counter(page, 1)).toHaveText(/^\d+t$/, { timeout: 15000 });
        await expect(counter(page, 1)).not.toHaveText(/^99[89]t$/);
    } finally {
        await mock.close();
    }
});

test('an edit in flight shows its count as waiting, and a failed edit shows no count beside its text', async ({ page }) => {
    const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const { mock, avatar } = await setUp(page, `Edit ${s}`);
    try {
        await appendMessages(page, avatar, [`Edited message of ${s}`]);
        await reopenChat(page);
        await expect(counter(page, 1)).toHaveText(/^\d+t$/, { timeout: 15000 });
        const before = await counter(page, 1).textContent();

        /** @type {() => void} */
        let release = () => {};
        const held = new Promise(resolve => { release = () => resolve(undefined); });
        await page.route('**/api/chats/message/edit', async (route) => {
            await held;
            await route.continue();
        });
        await page.locator('#chat .mes[mesid="1"] .mes_edit').click();
        await page.locator('.mes_editor .cm-content').fill(`Edited message of ${s}, now with many more words than it had before`);
        await page.locator('#chat .mes[mesid="1"] .mes_edit_done').click();
        await expect(counter(page, 1)).toHaveText('…');
        release();
        await expect(counter(page, 1)).toHaveText(/^\d+t$/, { timeout: 15000 });
        await expect(counter(page, 1)).not.toHaveText(String(before));
        await page.unroute('**/api/chats/message/edit');

        await page.route('**/api/chats/message/edit', route => route.abort());
        await page.locator('#chat .mes[mesid="1"] .mes_edit').click();
        await page.locator('.mes_editor .cm-content').fill(`A failed edit of ${s}`);
        await page.locator('#chat .mes[mesid="1"] .mes_edit_done').click();
        await expect(page.locator('#chat .mes[mesid="1"] .mes_text')).toContainText(`A failed edit of ${s}`);
        await expect(counter(page, 1)).toHaveText('', { timeout: 15000 });
    } finally {
        await mock.close();
    }
});

test('a message a failed generation stored gets its count, and the page asks for none', async ({ page }) => {
    const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const { mock } = await setUp(page, `Failed ${s}`);
    try {
        mock.state.failCompletion = true;
        const requested = countRequests(page);
        await chatBox(page).fill(`Hello ${s}, this will fail`);
        await page.locator('#send_but').click();
        await expect(page.locator('#chat .mes[mesid="1"] .mes_text')).toContainText(`Hello ${s}`);
        await expect.poll(() => page.evaluate(() => {
            // @ts-ignore
            return typeof stTest.context().chat[1]?.node_id === 'string';
        }), { timeout: 15000 }).toBe(true);
        await expect(counter(page, 1)).toHaveText(/^\d+t$/, { timeout: 15000 });
        expect(requested).toEqual([]);
    } finally {
        await mock.close();
    }
});

test('a model the backend swapped in recounts the shown messages with its own tokenizer', async ({ page }) => {
    const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const { mock, avatar } = await setUp(page, `Swap ${s}`);
    try {
        await appendMessages(page, avatar, [`Swapped model counts ${s} these words`]);
        await reopenChat(page);
        await expect(counter(page, 1)).toHaveText(/^\d+t$/, { timeout: 15000 });
        const first = Number((await counter(page, 1).textContent())?.replace('t', ''));

        mock.state.loaded = 'another-model';
        mock.state.tokensPerWord = 2;
        await page.waitForTimeout(5500);
        await page.evaluate(() => {
            // @ts-ignore
            $('#tokenizer').trigger('change');
        });
        await expect(counter(page, 1)).toHaveText(`${first * 2}t`, { timeout: 15000 });
    } finally {
        await mock.close();
    }
});

for (const inGroup of [false, true]) {
    test(`a sent message's count comes while its reply still streams${inGroup ? ' (group)' : ''}`, async ({ page }) => {
        const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
        const { mock, avatar } = await setUp(page, `Streaming ${s}`, { streaming: true, mockOptions: { reply: () => `Reply ${s} ${long}`, delayMs: 500, pieceDelayMs: 150 } });
        try {
            if (inGroup) {
                await page.evaluate(async (members) => {
                    // @ts-ignore
                    const context = stTest.context();
                    const response = await fetch('/api/groups/create', { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ name: `Streaming group ${Date.now()}`, members }) });
                    if (!response.ok) throw new Error(`group create failed: ${response.status}`);
                    const { openGroupById } = await import('/scripts/group-chats.js');
                    await openGroupById(String((await response.json()).id));
                }, [avatar]);
                await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);
            }
            const requested = countRequests(page);
            await chatBox(page).fill(`Hello ${s}, a message with a few words`);
            await page.locator('#send_but').click();
            await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText('word1', { timeout: 15000 });
            await expect(counter(page, 1)).toHaveText(/^\d+t$/, { timeout: 5000 });
            await expect(counter(page, 0)).toHaveText(/^\d+t$/);
            expect(await generating(page)).toBe(true);
            await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).not.toContainText('word59');
            await expect(page.locator('#send_but')).toBeVisible({ timeout: 30000 });
            expect(requested).toEqual([]);
        } finally {
            await mock.close();
        }
    });
}
