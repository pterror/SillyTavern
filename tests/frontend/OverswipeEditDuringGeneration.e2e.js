import http from 'node:http';
import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, chatBox } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

// While an overswipe's reply is generated its message shows the new slot, which has no node yet: nothing may address
// the alternative swiped from as if it were that slot. An edit opened on the message while the reply streams in isn't
// possible, and an edit an extension makes when the reply arrives (MESSAGE_RECEIVED) lands on the reply's own node,
// never on the first alternative.

const MODEL = 'overswipe-edit-model';

/**
 * A mock llama.cpp server answering the n-th completion with `Reply number n <stamp>.`, streamed in small pieces spaced
 * well apart (so the page shows part of it for a few seconds before the end) or whole after a pause.
 * @param {string} stamp
 */
function startLlamaCpp(stamp) {
    let n = 0;
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const json = (/** @type {any} */ value) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(value));
            };
            const path = (req.url ?? '').split('?')[0];
            if (path === '/props') return json({ model_alias: MODEL, model_path: `/models/${MODEL}.gguf`, build_info: 'b-overswipe', default_generation_settings: { n_ctx: 8192 } });
            if (path === '/v1/models') return json({ object: 'list', data: [{ id: MODEL, object: 'model' }] });
            if (path === '/tokenize') {
                const content = String(JSON.parse(body || '{}').content ?? '');
                return json({ tokens: content.split(/(?=\s)/).filter(Boolean).map((_, i) => 100 + i) });
            }
            if (path === '/completion') {
                const text = `Reply number ${++n} ${stamp}.`;
                if (JSON.parse(body || '{}').stream === false) {
                    setTimeout(() => json({ content: text, stop: true, model: MODEL, tokens_predicted: 6, tokens_evaluated: 10 }), 800);
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                (async () => {
                    for (let i = 0; i < text.length; i += 5) {
                        res.write(`data: ${JSON.stringify({ content: text.slice(i, i + 5), stop: false })}\n\n`);
                        await new Promise(resolve => setTimeout(resolve, 400));
                    }
                    res.end(`data: ${JSON.stringify({ content: '', stop: true })}\n\n`);
                })();
                return;
            }
            if (path === '/health' || path === '/slots') return json({});
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end('{}');
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
            resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise(done => server.close(() => done(undefined))) });
        });
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
function createCharacter(page, name) {
    return page.evaluate(async (name) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', 'Hello.');
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, name);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 */
async function openCharacter(page, avatar) {
    await openCharacterManagementDrawer(page);
    await page.evaluate(async (avatar) => {
        // @ts-ignore
        await SillyTavern.getContext().getCharacters();
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} url
 */
async function connectLlamaCpp(page, url) {
    if (!(await page.locator('#main_api').isVisible())) {
        await page.locator('#API-status-top').click();
        await page.locator('#main_api').waitFor({ state: 'visible' });
    }
    await page.selectOption('#main_api', 'textgenerationwebui', { force: true });
    await page.locator('#textgen_type').selectOption('llamacpp');
    await page.locator('#llamacpp_api_url_text').fill(url);
    // A worker's earlier tests leave server URLs in the history, whose suggestions would cover the button.
    // @ts-ignore
    await page.evaluate(() => { const field = $('#llamacpp_api_url_text'); if (field.autocomplete('instance')) field.autocomplete('close'); });
    await page.locator('#api_button_textgenerationwebui').click();
    // @ts-ignore
    await expect.poll(() => page.evaluate(() => SillyTavern.getContext().onlineStatus), { timeout: 15000 }).not.toBe('no_connection');
    await page.locator('#API-status-top').click();
}

/**
 * Waits until the generation is done and every message has its stored node.
 * @param {import('@playwright/test').Page} page
 */
async function settled(page) {
    await expect(page.locator('#send_but')).toBeVisible({ timeout: 30000 });
    await expect.poll(() => page.evaluate(() => {
        // @ts-ignore
        const chat = SillyTavern.getContext().chat;
        return chat.every((/** @type {any} */ m) => typeof m.node_id === 'string' && !m.node_id.startsWith('card:'));
    }), { timeout: 10000 }).toBe(true);
    await page.waitForTimeout(500);
}

/**
 * The alternatives the server stores beside the page's message `mesId`.
 * @param {import('@playwright/test').Page} page
 * @param {number} mesId
 */
function storedAlternatives(page, mesId) {
    return page.evaluate(async (mesId) => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        const nodeId = context.chat[mesId]?.swipe_info?.[0]?.node_id ?? context.chat[mesId]?.node_id;
        const response = await fetch('/api/chats/alternatives', { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ node_id: nodeId }) });
        return (await response.json()).alternatives.map((/** @type {any} */ a) => a.mes);
    }, mesId);
}

/**
 * A character with one stored reply (`Reply number 1`), talking to the mock server.
 * @param {import('@playwright/test').Page} page
 * @param {{ url: string }} mock
 * @param {string} stamp
 * @param {boolean} streaming
 * @param {(page: import('@playwright/test').Page) => Promise<void>} [beforeSend] Run once connected, before the question.
 */
async function chatWithOneReply(page, mock, stamp, streaming, beforeSend) {
    await testSetup.awaitST({ page });
    const avatar = await createCharacter(page, `Editor-${stamp}`);
    await openCharacter(page, avatar);
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);
    await connectLlamaCpp(page, mock.url);
    // @ts-ignore
    await page.evaluate((streaming) => { SillyTavern.getContext().textCompletionSettings.streaming = streaming; }, streaming);
    await page.waitForTimeout(2500);
    if (beforeSend) await beforeSend(page);
    await chatBox(page).fill(`Question ${stamp}`);
    await page.locator('#send_but').click();
    await expect(page.locator('#chat .mes[mesid="2"]')).toHaveCount(1, { timeout: 30000 });
    await settled(page);
    return avatar;
}

test('an edit opened on an overswipe\'s message while its reply streams in is refused; the first alternative stays', async ({ page }) => {
    test.setTimeout(120000);
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const mock = await startLlamaCpp(stamp);
    try {
        await chatWithOneReply(page, mock, stamp, true);
        // @ts-ignore
        await page.evaluate(() => { SillyTavern.getContext().powerUserSettings.click_to_edit = true; });
        expect(await storedAlternatives(page, 2)).toEqual([`Reply number 1 ${stamp}.`]);

        // Overswipe; once part of the second reply is shown, click its text (click-to-edit) and press Done.
        await page.locator('#chat .mes[mesid="2"] .swipe_right').click();
        // Part of the second reply shown, not the first's text.
        await expect.poll(() => page.locator('#chat .mes[mesid="2"] .mes_text').textContent(), { timeout: 30000 }).toMatch(/^\s*Reply(?! number 1)/);
        await page.locator('#chat .mes[mesid="2"] .mes_text').click();
        const opened = await page.locator('#chat .mes[mesid="2"] .edit_textarea').count();
        if (opened) {
            await page.locator('#chat .mes[mesid="2"] .edit_textarea').fill('Edited while streaming.');
            await page.locator('#chat .mes[mesid="2"] .mes_edit_done').click();
        }
        await settled(page);
        expect.soft(await storedAlternatives(page, 2)).toEqual([`Reply number 1 ${stamp}.`, `Reply number 2 ${stamp}.`]);
        expect.soft(opened, 'the editor opened on the message being generated').toBe(0);
    } finally {
        await mock.close();
    }
});

for (const streaming of [true, false]) {
    test(`an edit an extension makes when an overswipe's reply arrives lands on the reply, not the first alternative (${streaming ? 'streaming' : 'not streaming'})`, async ({ page }) => {
        test.setTimeout(120000);
        const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const mock = await startLlamaCpp(stamp);
        try {
            await chatWithOneReply(page, mock, stamp, streaming);
            // An extension changes the second reply when it arrives, and saves that edit (context.editMessage()).
            await page.evaluate(() => {
                // @ts-ignore
                const ctx = SillyTavern.getContext();
                ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, async (/** @type {number} */ id) => {
                    const message = ctx.chat[id];
                    if (!String(message?.mes ?? '').startsWith('Reply number 2')) return;
                    ctx.chat[id] = { ...message, mes: `${message.mes} (edited)` };
                    await ctx.editMessage(id);
                });
            });
            await page.locator('#chat .mes[mesid="2"] .swipe_right').click();
            // @ts-ignore
            await expect.poll(() => page.evaluate(() => SillyTavern.getContext().chat[2]?.swipes?.length), { timeout: 30000 }).toBe(2);
            await settled(page);
            await expect.poll(() => storedAlternatives(page, 2), { timeout: 10000 })
                .toEqual([`Reply number 1 ${stamp}.`, `Reply number 2 ${stamp}. (edited)`]);
        } finally {
            await mock.close();
        }
    });
}

for (const streaming of [true, false]) {
    test(`a change an extension makes in place to a reply when it arrives, without saving, is stored (${streaming ? 'streaming' : 'not streaming'})`, async ({ page }) => {
        test.setTimeout(120000);
        const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const mock = await startLlamaCpp(stamp);
        try {
            const avatar = await chatWithOneReply(page, mock, stamp, streaming, (page) => page.evaluate(() => {
                // @ts-ignore
                const ctx = SillyTavern.getContext();
                ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, (/** @type {number} */ id) => {
                    const message = ctx.chat[id];
                    if (!String(message?.mes ?? '').startsWith('Reply number')) return;
                    message.mes = `${message.mes} (noted)`;
                    message.extra.noted_by = 'an extension';
                });
            }));
            const storedReply = () => page.evaluate(async (avatar) => {
                // @ts-ignore
                const context = SillyTavern.getContext();
                const response = await fetch('/api/chats/open', { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }) });
                const reply = (await response.json()).messages[2];
                return { mes: reply?.mes, noted: reply?.extra?.noted_by ?? null };
            }, avatar);
            await expect.poll(storedReply, { timeout: 10000 }).toEqual({ mes: `Reply number 1 ${stamp}. (noted)`, noted: 'an extension' });
        } finally {
            await mock.close();
        }
    });
}
