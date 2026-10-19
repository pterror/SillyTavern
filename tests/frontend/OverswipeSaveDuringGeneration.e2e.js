import http from 'node:http';
import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, chatBox } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

// A whole-chat save (getContext().saveChat(), as extensions call it) made while a reply is being generated never
// writes that reply: the server stores it. An overswipe's new slot, before the page has its node, must not be saved
// over the alternative it is beside (the message still names that one), and a first reply streaming in must not be
// stored as a partial message of its own. Checked at each step against what the server stores: the alternatives
// beside the swiped message, their texts, and the path the chat opens on.

const MODEL = 'overswipe-save-model';

/**
 * A mock llama.cpp server answering the n-th completion with `Reply number n <stamp>.`, streamed in small, spaced
 * pieces (so the page sees part of it before the end) or whole after a pause.
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
                        await new Promise(resolve => setTimeout(resolve, 100));
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
 * Installs what an extension does: `during` saves the whole chat once while each reply is being generated (on its
 * first streamed piece, or while a non-streamed request is out); `received` changes each reply's text when it arrives
 * (MESSAGE_RECEIVED) and saves the whole chat.
 * @param {import('@playwright/test').Page} page
 * @param {'during'|'received'} when
 * @param {boolean} streaming
 */
function installExtensionSave(page, when, streaming) {
    return page.evaluate(({ when, streaming }) => {
        // @ts-ignore
        const ctx = SillyTavern.getContext();
        // @ts-ignore
        window.__extensionSaves = 0;
        const save = async () => {
            // @ts-ignore
            window.__extensionSaves++;
            await ctx.saveChat();
        };
        if (when === 'received') {
            ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, async (/** @type {number} */ id) => {
                const message = ctx.chat[id];
                if (message?.is_user || !String(message?.mes ?? '').startsWith('Reply number')) return;
                ctx.updateMessage(id, { mes: `${message.mes} (noted)` });
                // Not drawn yet when the reply wasn't streamed: it is drawn from the changed message.
                if (document.querySelector(`#chat .mes[mesid="${id}"]`)) ctx.updateMessageBlock(id, ctx.chat[id]);
                await save();
            });
            return;
        }
        let saved = false;
        ctx.eventSource.on(ctx.eventTypes.GENERATION_STARTED, () => {
            saved = false;
            if (!streaming) setTimeout(save, 400);
        });
        if (streaming) {
            ctx.eventSource.on(ctx.eventTypes.STREAM_TOKEN_RECEIVED, async () => {
                if (saved) return;
                saved = true;
                await save();
            });
        }
    }, { when, streaming });
}

/**
 * What the page shows and holds of message `mesId`, and what the server stores: the alternatives beside it, and
 * the path the chat opens on.
 * @param {import('@playwright/test').Page} page
 * @param {string} avatar
 * @param {number} mesId
 */
function observe(page, avatar, mesId) {
    return page.evaluate(async ({ avatar, mesId }) => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        const headers = context.getRequestHeaders();
        const post = async (/** @type {string} */ url, /** @type {any} */ body) => (await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })).json();
        const block = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
        const nodeId = context.chat[mesId]?.node_id;
        const alternatives = typeof nodeId === 'string' ? await post('/api/chats/alternatives', { node_id: nodeId }) : null;
        const opened = await post('/api/chats/open', { avatar_url: avatar });
        return {
            shownText: block?.querySelector('.mes_text')?.textContent?.trim(),
            counter: block?.querySelector('.swipes-counter')?.textContent?.replace(/\u200b/g, '').trim(),
            shownCount: document.querySelectorAll('#chat .mes').length,
            chatLength: context.chat.length,
            stored: alternatives?.alternatives?.map((/** @type {any} */ a) => a.mes) ?? null,
            storedSelected: alternatives?.selected ?? null,
            opensOn: opened.messages?.map((/** @type {any} */ m) => m.mes) ?? null,
        };
    }, { avatar, mesId });
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

// Each step is checked on its own (soft), so a failure names every step that went wrong, not only the first.
const step = expect.configure({ soft: true });

for (const streaming of [true, false]) {
    for (const when of /** @type {const} */ (['during', 'received'])) {
        test(`an overswipe's new branch survives a whole-chat save made ${when === 'during' ? 'while it is generated' : 'when it arrives'} (${streaming ? 'streaming' : 'not streaming'})`, async ({ page }) => {
            test.setTimeout(120000);
            const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const reply = (/** @type {number} */ n) => `Reply number ${n} ${stamp}.${when === 'received' ? ' (noted)' : ''}`;
            const question = `First question ${stamp}`;
            const followUp = `Second question ${stamp}`;
            const mock = await startLlamaCpp(stamp);
            try {
                await testSetup.awaitST({ page });
                const avatar = await createCharacter(page, `Swiper-${stamp}`);
                await openCharacter(page, avatar);
                await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);
                await connectLlamaCpp(page, mock.url);
                // @ts-ignore
                await page.evaluate((streaming) => { SillyTavern.getContext().textCompletionSettings.streaming = streaming; }, streaming);
                // The server reads the backend from the saved settings; give the saves time to land.
                await page.waitForTimeout(2500);
                await installExtensionSave(page, when, streaming);

                // The first reply: stored once, whole (no partial copy beside it).
                await chatBox(page).fill(question);
                await page.locator('#send_but').click();
                await expect(page.locator('#chat .mes[mesid="2"]')).toHaveCount(1, { timeout: 30000 });
                await settled(page);
                step(await observe(page, avatar, 2)).toMatchObject({
                    shownText: reply(1), counter: '1/1', stored: [reply(1)], storedSelected: 0, opensOn: ['Hello.', question, reply(1)],
                });

                // Overswipe: a second alternative beside the first, which keeps its text.
                await page.locator('#chat .mes[mesid="2"] .swipe_right').click();
                // @ts-ignore
                await expect.poll(() => page.evaluate(() => SillyTavern.getContext().chat[2]?.swipes?.length), { timeout: 30000 }).toBe(2);
                await settled(page);
                step(await observe(page, avatar, 2)).toMatchObject({
                    shownText: reply(2), counter: '2/2', stored: [reply(1), reply(2)], storedSelected: 1, opensOn: ['Hello.', question, reply(2)],
                });

                // Going on from the second alternative hangs the conversation under it.
                await chatBox(page).fill(followUp);
                await page.locator('#send_but').click();
                await expect(page.locator('#chat .mes[mesid="4"]')).toHaveCount(1, { timeout: 30000 });
                await settled(page);
                step(await observe(page, avatar, 2)).toMatchObject({
                    stored: [reply(1), reply(2)], storedSelected: 1, opensOn: ['Hello.', question, reply(2), followUp, reply(3)],
                });

                // Back to the first: its own branch, with nothing of the second's below it.
                await page.locator('#chat .mes[mesid="2"] .swipe_left').click();
                await step.poll(() => observe(page, avatar, 2), { timeout: 10000 }).toMatchObject({
                    shownText: reply(1), counter: '1/2', shownCount: 3, chatLength: 3,
                    stored: [reply(1), reply(2)], storedSelected: 0, opensOn: ['Hello.', question, reply(1)],
                });

                // Away and back: the chat opens on the first, both alternatives there.
                const other = await createCharacter(page, `Other-${stamp}`);
                await openCharacter(page, other);
                await openCharacter(page, avatar);
                await expect(page.locator('#chat .mes')).toHaveCount(3, { timeout: 10000 });
                await step.poll(() => observe(page, avatar, 2), { timeout: 10000 }).toMatchObject({
                    shownText: reply(1), counter: '1/2', stored: [reply(1), reply(2)], storedSelected: 0, opensOn: ['Hello.', question, reply(1)],
                });
                // The extension did save while the replies were generated.
                // @ts-ignore
                expect(await page.evaluate(() => window.__extensionSaves)).toBeGreaterThanOrEqual(2);
            } finally {
                await mock.close();
            }
        });
    }
}
