import http from 'node:http';
import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

// A llama.cpp text-completion send is a raw action: the server builds the prompt. The browser must not also run
// its own prompt assembly, which counts every chat item through getTokenCountAsync() and so asks the server (and
// the server llama.cpp) to tokenize each one. A fresh page has none of those texts cached, so the assembly shows
// up as tokenizer requests carrying chat texts.

const MODEL = 'raw-action-log-model';

/**
 * A mock llama.cpp server that logs every request it gets.
 * @param {{ completion?: (n: number) => object | null, streamDelayMs?: number }} [options] The body `/completion` answers with
 * for the n-th reply (null answers with a 500 error instead), and how long a streamed reply takes to finish.
 * @returns {Promise<{ url: string, log: { method: string, url: string, body: string }[], close: () => Promise<void> }>}
 */
function startMockLlamaCpp({ completion = n => ({ content: `Mock reply ${n}.` }), streamDelayMs = 0 } = {}) {
    const log = [];
    let replies = 0;
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            log.push({ method: req.method, url: req.url, body });
            const json = (value) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(value));
            };
            const path = (req.url ?? '').split('?')[0];
            if (path === '/props') {
                return json({
                    model_alias: MODEL,
                    model_path: `/models/${MODEL}.gguf`,
                    build_info: 'b-raw-action-log',
                    default_generation_settings: { n_ctx: 8192 },
                });
            }
            if (path === '/v1/models') {
                return json({ object: 'list', data: [{ id: MODEL, object: 'model' }] });
            }
            if (path === '/tokenize') {
                const content = String(JSON.parse(body || '{}').content ?? '');
                const tokens = content.split(/(?=\s)/).filter(Boolean).map((_, i) => 100 + i);
                return json({ tokens });
            }
            if (path === '/completion') {
                const answer = completion(++replies);
                if (answer === null) {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    return res.end('mock llama.cpp error');
                }
                if (JSON.parse(body || '{}').stream) {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.write(`data: ${JSON.stringify({ ...answer, stop: false })}\n\n`);
                    const end = () => res.end(`data: ${JSON.stringify({ content: '', stop: true })}\n\n`);
                    return streamDelayMs ? void setTimeout(end, streamDelayMs) : end();
                }
                return json(answer);
            }
            if (path === '/health' || path === '/slots') {
                return json({});
            }
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end('{}');
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
            resolve({ url: `http://127.0.0.1:${port}`, log, close: () => new Promise(done => server.close(() => done())) });
        });
    });
}

/**
 * Creates a character with one greeting and returns its avatar filename.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string} greeting
 */
async function createCharacter(page, name, greeting) {
    return page.evaluate(async ({ name, greeting }) => {
        // @ts-ignore
        const headers = SillyTavern.getContext().getRequestHeaders({ omitContentType: true });
        const form = new FormData();
        form.set('ch_name', name);
        form.set('first_mes', greeting);
        const response = await fetch('/api/characters/create', { method: 'POST', headers, body: form });
        if (!response.ok) throw new Error(`create failed: ${response.status}`);
        return response.text();
    }, { name, greeting });
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
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);
}

/**
 * Switches to Text Completion, llama.cpp, at `url`, and connects.
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
    await page.locator('#api_button_textgenerationwebui').click();
    // @ts-ignore
    await expect.poll(() => page.evaluate(() => SillyTavern.getContext().onlineStatus), { timeout: 15000 }).not.toBe('no_connection');
    await page.locator('#API-status-top').click();
}

/**
 * Logs every request the page sends to the server's /api routes.
 * @param {import('@playwright/test').Page} page
 * @returns {{ url: string, body: any }[]}
 */
function recordApiRequests(page) {
    const log = [];
    page.on('request', (request) => {
        const url = new URL(request.url());
        if (!url.pathname.startsWith('/api/')) return;
        let body = null;
        try {
            body = request.postDataJSON();
        } catch {
            body = request.postData();
        }
        log.push({ url: url.pathname, body });
    });
    return log;
}

/**
 * Sends `text` and waits for the reply at `mesid` and for the send to finish.
 * @param {import('@playwright/test').Page} page
 * @param {string} text
 * @param {number} mesid
 */
async function send(page, text, mesid) {
    await page.locator('#send_textarea').fill(text);
    await page.locator('#send_but').click();
    await expect(page.locator(`#chat .mes[mesid="${mesid}"] .mes_text`)).toContainText('Mock reply', { timeout: 30000 });
    await expect(page.locator('#send_but')).toBeVisible({ timeout: 30000 });
}

const SETTLE_MS = 2500;

test.describe('raw-action send request log', () => {
    /** @type {Awaited<ReturnType<typeof startMockLlamaCpp>>} */
    let mock;

    test.beforeEach(async ({ page }) => {
        mock = await startMockLlamaCpp();
        await testSetup.awaitST({ page });
    });

    test.afterEach(async () => {
        await mock.close();
    });

    test('a llama.cpp send runs no browser prompt assembly', async ({ page }) => {
        const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const greeting = `Hello from the greeting ${stamp}.`;
        const avatar = await createCharacter(page, `RawActionLog-${stamp}`, greeting);
        await openCharacter(page, avatar);
        await connectLlamaCpp(page, mock.url);
        await page.waitForTimeout(SETTLE_MS);

        const browser = recordApiRequests(page);
        const sends = [];
        for (const [i, text] of [`First question ${stamp}?`, `Second question ${stamp}?`].entries()) {
            const browserFrom = browser.length;
            const mockFrom = mock.log.length;
            await send(page, text, 2 * i + 2);
            // The server stores token counts after it answers.
            await page.waitForTimeout(SETTLE_MS);
            sends.push({ text, browser: browser.slice(browserFrom), mock: mock.log.slice(mockFrom) });
        }
        const chatTexts = [greeting, ...sends.map(s => s.text), 'Mock reply 1.', 'Mock reply 2.'];
        const tokenized = sends.map(s => s.mock.filter(r => r.url === '/tokenize').map(r => JSON.parse(r.body).content));
        await test.info().attach('llama.cpp requests per send', {
            body: JSON.stringify(sends.map((s, i) => ({ text: s.text, urls: s.mock.map(r => r.url), tokenized: tokenized[i] })), null, 2),
            contentType: 'application/json',
        });

        for (const { text, browser: requests, mock: backend } of sends) {
            const generate = requests.filter(r => r.url === '/api/backends/text-completions/generate');
            expect(generate).toHaveLength(1);
            expect(generate[0].body.user_message).toBe(text);
            expect(generate[0].body).not.toHaveProperty('prompt');

            const countedChatTexts = requests
                .filter(r => r.url.startsWith('/api/tokenizers/'))
                .flatMap(r => [r.body?.text, ...(Array.isArray(r.body?.texts) ? r.body.texts : [])])
                .filter(counted => typeof counted === 'string' && chatTexts.some(t => counted.includes(t)));
            expect(countedChatTexts).toEqual([]);

            expect(backend.filter(r => r.url === '/props')).toHaveLength(1);
            expect(backend.filter(r => r.url === '/v1/models')).toHaveLength(0);
        }
        // The second send's history was all in the first send's prompt, so none of it is tokenized again.
        expect(tokenized[1].filter(text => tokenized[0].includes(text))).toEqual([]);
    });

    test('a non-streaming llama.cpp answer with no readable reply shows that it was not saved', async ({ page }) => {
        const unreadable = await startMockLlamaCpp({ completion: () => ({ unexpected_field: 'Secret unreadable reply.' }) });
        try {
            const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const avatar = await createCharacter(page, `RawActionUnreadable-${stamp}`, `Hello from the greeting ${stamp}.`);
            await openCharacter(page, avatar);
            await connectLlamaCpp(page, unreadable.url);
            await page.waitForTimeout(SETTLE_MS);

            await page.locator('#send_textarea').fill(`Unreadable question ${stamp}?`);
            await page.locator('#send_but').click();
            await expect(page.locator('#toast-container .toast-warning', { hasText: 'The reply came back in a format SillyTavern can\'t read, so it wasn\'t saved.' }))
                .toHaveCount(1, { timeout: 15000 });
        } finally {
            await unreadable.close();
        }
    });

    for (const streaming of [false, true]) {
        test(`two ${streaming ? 'streaming' : 'non-streaming'} llama.cpp sends store each user message once, and the page holds the stored ids`, async ({ page }) => {
            const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const avatar = await createCharacter(page, `RawActionTwice-${stamp}`, `Hello from the greeting ${stamp}.`);
            await openCharacter(page, avatar);
            await connectLlamaCpp(page, mock.url);
            // @ts-ignore
            await page.evaluate((on) => { SillyTavern.getContext().textCompletionSettings.streaming = on; }, streaming);
            await page.waitForTimeout(SETTLE_MS);

            const browser = recordApiRequests(page);
            const first = `First question ${stamp}?`;
            await send(page, first, 2);
            await send(page, `Second question ${stamp}?`, 4);
            await page.waitForTimeout(SETTLE_MS);

            const generate = browser.filter(r => r.url === '/api/backends/text-completions/generate');
            expect(generate.map(r => r.body.stream === true)).toEqual([streaming, streaming]);

            // The stored path to the newest message, and every stored copy of the first user message: a
            // second write of it is stored as a sibling.
            const stored = await page.evaluate(async (first) => {
                // @ts-ignore
                const context = SillyTavern.getContext();
                const post = async (url, body) => (await fetch(url, { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify(body) })).json();
                const pageIds = context.chat.map(m => m.node_id ?? null);
                const leaf = pageIds[pageIds.length - 1];
                const path = leaf ? (await post('/api/chats/ancestry', { node_id: leaf })).messages : null;
                const firstStored = path?.find(m => m.is_user && m.mes === first);
                const copies = firstStored
                    ? (await post('/api/chats/alternatives', { node_id: firstStored.node_id })).alternatives.filter(a => a.is_user && a.mes === first).length
                    : null;
                return { pageIds, pathIds: path?.map(m => m.node_id) ?? null, copies };
            }, first);
            await test.info().attach('page ids, stored path, copies of the first user message', { body: JSON.stringify(stored, null, 2), contentType: 'application/json' });

            expect(stored.copies).toBe(1);
            expect(stored.pageIds).toEqual(stored.pathIds);
        });
    }

    for (const streaming of [false, true]) {
        test(`a ${streaming ? 'streaming' : 'non-streaming'} llama.cpp send that fails, then one that works, store the first user message once`, async ({ page }) => {
            const failing = await startMockLlamaCpp({ completion: n => (n === 1 ? null : { content: `Mock reply ${n}.` }) });
            try {
                const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
                const avatar = await createCharacter(page, `RawActionError-${stamp}`, `Hello from the greeting ${stamp}.`);
                await openCharacter(page, avatar);
                await connectLlamaCpp(page, failing.url);
                // @ts-ignore
                await page.evaluate((on) => { SillyTavern.getContext().textCompletionSettings.streaming = on; }, streaming);
                await page.waitForTimeout(SETTLE_MS);

                const first = `First question ${stamp}?`;
                await page.locator('#send_textarea').fill(first);
                await page.locator('#send_but').click();
                await expect(page.locator('#chat .mes[mesid="1"] .mes_text')).toContainText(first, { timeout: 30000 });
                await expect(page.locator('#send_but')).toBeVisible({ timeout: 30000 });
                await page.waitForTimeout(SETTLE_MS);
                await send(page, `Second question ${stamp}?`, 3);
                await page.waitForTimeout(SETTLE_MS);

                const stored = await page.evaluate(async (first) => {
                    // @ts-ignore
                    const context = SillyTavern.getContext();
                    const post = async (url, body) => (await fetch(url, { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify(body) })).json();
                    const pageIds = context.chat.map(m => m.node_id ?? null);
                    const leaf = pageIds[pageIds.length - 1];
                    const path = leaf ? (await post('/api/chats/ancestry', { node_id: leaf })).messages : null;
                    const firstStored = path?.find(m => m.is_user && m.mes === first);
                    const copies = firstStored
                        ? (await post('/api/chats/alternatives', { node_id: firstStored.node_id })).alternatives.filter(a => a.is_user && a.mes === first).length
                        : null;
                    return { pageIds, pathIds: path?.map(m => m.node_id) ?? null, copies };
                }, first);
                await test.info().attach('page ids, stored path, copies of the first user message', { body: JSON.stringify(stored, null, 2), contentType: 'application/json' });

                expect(stored.copies).toBe(1);
                expect(stored.pageIds).toEqual(stored.pathIds);
            } finally {
                await failing.close();
            }
        });
    }

    // Each request sender takes on the `stored` an error answer reports, from the X-ST-Stored header or the
    // body's `stored` field: the answers are stood in for, so only the page's reading is under test.
    const senders = [
        {
            name: 'text completion, non-streaming (sendGenerationRequest, 200 error body)', url: '**/api/backends/text-completions/generate',
            answer: stored => ({ status: 200, body: { error: true, status: 500, response: 'failed', stored } }),
            call: async () => {
                const { sendGenerationRequest } = await import('/script.js');
                const { setMainApi } = await import('/scripts/generation-params.js');
                setMainApi('textgenerationwebui');
                return sendGenerationRequest('normal', { owner_id: 'x' });
            },
        },
        {
            name: 'kobold, non-streaming (sendGenerationRequest, 400)', url: '**/api/backends/kobold/generate',
            answer: stored => ({ status: 400, body: { error: { message: 'failed' }, stored } }),
            call: async () => {
                const { sendGenerationRequest } = await import('/script.js');
                const { setMainApi } = await import('/scripts/generation-params.js');
                setMainApi('kobold');
                return sendGenerationRequest('normal', { owner_id: 'x' });
            },
        },
        {
            name: 'NovelAI, non-streaming (sendGenerationRequest, 500)', url: '**/api/novelai/generate',
            answer: stored => ({ status: 500, body: { error: { message: 'failed' }, stored } }),
            call: async () => {
                const { sendGenerationRequest } = await import('/script.js');
                const { setMainApi } = await import('/scripts/generation-params.js');
                setMainApi('novel');
                return sendGenerationRequest('normal', { owner_id: 'x' });
            },
        },
        {
            name: 'NovelAI, non-streaming (sendGenerationRequest, 400 with a plain-text body)', url: '**/api/novelai/generate',
            answer: () => ({ status: 400, text: 'Bad Request' }),
            call: async () => {
                const { sendGenerationRequest } = await import('/script.js');
                const { setMainApi } = await import('/scripts/generation-params.js');
                setMainApi('novel');
                return sendGenerationRequest('normal', { owner_id: 'x' });
            },
        },
        {
            name: 'text completion, streaming (backend error passed on)', url: '**/api/backends/text-completions/generate',
            answer: () => ({ status: 500, text: 'backend exploded' }),
            call: async () => (await import('/scripts/textgen-settings.js')).generateTextGenWithStreaming({ owner_id: 'x' }, new AbortController().signal),
        },
        {
            name: 'kobold, streaming (backend error passed on)', url: '**/api/backends/kobold/generate',
            answer: () => ({ status: 500, text: 'backend exploded' }),
            call: async () => (await import('/scripts/kai-settings.js')).generateKoboldWithStreaming({ owner_id: 'x' }, new AbortController().signal),
        },
        {
            name: 'NovelAI, streaming (backend error passed on)', url: '**/api/novelai/generate',
            answer: () => ({ status: 500, text: 'backend exploded' }),
            call: async () => (await import('/scripts/nai-settings.js')).generateNovelWithStreaming({ owner_id: 'x' }, new AbortController().signal),
        },
        {
            name: 'chat completion, non-streaming (sendOpenAIRequest, 200 error body)', url: '**/api/backends/chat-completions/generate',
            answer: stored => ({ status: 200, body: { error: { message: 'failed' }, quota_error: false, stored } }),
            call: async () => {
                const { sendOpenAIRequest, oai_settings } = await import('/scripts/chat-completion-settings.js');
                oai_settings.stream_openai = false;
                return sendOpenAIRequest('normal', [], new AbortController().signal, { rawAction: { owner_id: 'x' } });
            },
        },
        {
            name: 'chat completion, streaming (backend error passed on)', url: '**/api/backends/chat-completions/generate',
            answer: () => ({ status: 500, text: 'backend exploded' }),
            call: async () => {
                const { sendOpenAIRequest, oai_settings } = await import('/scripts/chat-completion-settings.js');
                oai_settings.stream_openai = true;
                return sendOpenAIRequest('normal', [], new AbortController().signal, { rawAction: { owner_id: 'x' } });
            },
        },
        {
            name: 'Horde (failed submit)', url: '**/api/horde/generate-text',
            answer: stored => ({ status: 200, body: { error: { message: 'failed' }, stored } }),
            before: async (page) => {
                await page.route('**/api/horde/text-models', route => route.fulfill({ json: [{ name: 'stand-in-model', count: 1, performance: 1, queued: 0, eta: 0 }] }));
            },
            call: async () => {
                const horde = await import('/scripts/horde.js');
                await horde.getHordeModels(true);
                horde.horde_settings.models = ['stand-in-model'];
                return horde.generateHordeRawAction({ owner_id: 'x' }, new AbortController().signal, false);
            },
        },
    ];
    for (const sender of senders) {
        test(`${sender.name}: the page takes on the stored user message from an error answer`, async ({ page }) => {
            const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const avatar = await createCharacter(page, `RawActionAdopt-${stamp}`, `Hello from the greeting ${stamp}.`);
            await openCharacter(page, avatar);
            await sender.before?.(page);

            // A user message the server is asked to store, as a raw-action send makes it.
            const ref = await page.evaluate(async () => {
                const { sendMessageAsUser } = await import('/script.js');
                const { storeRefOf } = await import('/scripts/chat-store.js');
                const message = await sendMessageAsUser('Stood-in question?', '', null, false, undefined, undefined, true);
                return storeRefOf(message);
            });
            expect(typeof ref).toBe('string');
            const stored = [{ ref, node_id: `adopted-${stamp}` }];
            await page.route(sender.url, async (route) => {
                const answer = sender.answer(stored);
                await route.fulfill({
                    status: answer.status,
                    headers: { 'X-ST-Stored': JSON.stringify(stored), 'Content-Type': answer.body ? 'application/json' : 'text/plain' },
                    body: answer.body ? JSON.stringify(answer.body) : answer.text,
                });
            });

            const nodeId = await page.evaluate(async (call) => {
                // eslint-disable-next-line no-new-func
                const run = new Function(`return (${call})();`);
                try {
                    await run();
                } catch {
                    // The error answer is thrown on, as before.
                }
                // @ts-ignore
                const chat = SillyTavern.getContext().chat;
                return chat[chat.length - 1].node_id ?? null;
            }, sender.call.toString());
            expect(nodeId).toBe(stored[0].node_id);
        });
    }

    test('a send clicked after a streamed reply shows the button again, while the previous send is still finishing, goes out', async ({ page }) => {
        const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const avatar = await createCharacter(page, `RawActionEarlySend-${stamp}`, `Hello from the greeting ${stamp}.`);
        await openCharacter(page, avatar);
        await connectLlamaCpp(page, mock.url);
        // @ts-ignore
        await page.evaluate(() => { SillyTavern.getContext().textCompletionSettings.streaming = true; });
        await page.waitForTimeout(SETTLE_MS);

        await page.locator('#send_textarea').fill(`First question ${stamp}?`);
        const second = `Second question ${stamp}?`;
        // Clicks Send the moment the button is shown again while the send lock is still held, as a user
        // clicking right after the reply appears would.
        const clickedInWindow = await page.evaluate(async (second) => {
            const { userInputGenerateMutex } = await import('/script.js');
            document.querySelector('#send_but').click();
            const deadline = performance.now() + 30000;
            while (performance.now() < deadline) {
                const shown = getComputedStyle(document.querySelector('#send_but')).display !== 'none';
                const replied = document.querySelector('#chat .mes[mesid="2"] .mes_text')?.textContent.includes('Mock reply');
                if (replied && shown && document.body.dataset.generating === undefined && userInputGenerateMutex.isBusy) {
                    $('#send_textarea').val(second)[0].dispatchEvent(new Event('input', { bubbles: true }));
                    document.querySelector('#send_but').click();
                    return true;
                }
                await new Promise(resolve => setTimeout(resolve, 0));
            }
            return false;
        }, second);
        expect(clickedInWindow).toBe(true);

        await expect(page.locator('#chat .mes[mesid="3"] .mes_text')).toContainText(second, { timeout: 15000 });
        await expect(page.locator('#chat .mes[mesid="4"] .mes_text')).toContainText('Mock reply', { timeout: 15000 });
        await expect(page.locator('#send_textarea')).toHaveValue('');
    });

    /**
     * Sends a first streamed message, then holds the send lock as the finishing send does after the reply
     * shows the button again, so the page stays in that gap until `release` is called.
     * @param {import('@playwright/test').Page} page
     */
    async function sendAndHoldGap(page, text) {
        await send(page, text, 2);
        await page.evaluate(async () => {
            const { userInputGenerateMutex } = await import('/script.js');
            while (userInputGenerateMutex.isBusy) await new Promise(resolve => setTimeout(resolve, 10));
            userInputGenerateMutex.isBusy = true;
        });
    }
    const releaseGap = (page) => page.evaluate(async () => {
        const { userInputGenerateMutex } = await import('/script.js');
        userInputGenerateMutex.isBusy = false;
    });
    const isQueued = (page) => page.locator('#send_but').evaluate(button => button.classList.contains('send_queued'));

    for (const [name, action] of [['a second click cancels it', 'click'], ['Enter keeps it queued', 'enter']]) {
        test(`a send in the gap shows as queued, and ${name}`, async ({ page }) => {
            const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const avatar = await createCharacter(page, `RawActionQueued-${stamp}`, `Hello from the greeting ${stamp}.`);
            await openCharacter(page, avatar);
            await connectLlamaCpp(page, mock.url);
            // @ts-ignore
            await page.evaluate(() => { SillyTavern.getContext().textCompletionSettings.streaming = true; });
            await page.waitForTimeout(SETTLE_MS);
            await sendAndHoldGap(page, `First question ${stamp}?`);

            const second = `Second question ${stamp}?`;
            await page.locator('#send_textarea').fill(second);
            await page.locator('#send_but').click();
            expect(await isQueued(page)).toBe(true);
            await expect(page.locator('#send_but')).toHaveAttribute('title', 'Send queued - click to cancel');

            if (action === 'click') {
                await page.locator('#send_but').click();
                expect(await isQueued(page)).toBe(false);
                await releaseGap(page);
                await page.waitForTimeout(SETTLE_MS);
                await expect(page.locator('#chat .mes[mesid="3"]')).toHaveCount(0);
                await expect(page.locator('#send_textarea')).toHaveValue(second);
            } else {
                await page.locator('#send_textarea').press('Enter');
                expect(await isQueued(page)).toBe(true);
                await releaseGap(page);
                await expect(page.locator('#chat .mes[mesid="3"] .mes_text')).toContainText(second, { timeout: 15000 });
                await expect(page.locator('#chat .mes[mesid="4"] .mes_text')).toContainText('Mock reply', { timeout: 15000 });
                await page.waitForTimeout(SETTLE_MS);
                await expect(page.locator('#chat .mes[mesid="5"]')).toHaveCount(0);
                expect(await isQueued(page)).toBe(false);
            }
        });
    }

    test('a send queued in the gap is cancelled by a chat change, with a toast, and its text stays in that chat\'s draft', async ({ page }) => {
        const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const avatar = await createCharacter(page, `RawActionQueuedA-${stamp}`, `Hello from the greeting ${stamp}.`);
        const other = await createCharacter(page, `RawActionQueuedB-${stamp}`, `Hello from the other greeting ${stamp}.`);
        await openCharacter(page, avatar);
        await connectLlamaCpp(page, mock.url);
        // @ts-ignore
        await page.evaluate(() => { SillyTavern.getContext().textCompletionSettings.streaming = true; });
        await page.waitForTimeout(SETTLE_MS);
        await sendAndHoldGap(page, `First question ${stamp}?`);

        const second = `Second question ${stamp}?`;
        await page.locator('#send_textarea').fill(second);
        await page.locator('#send_but').click();
        expect(await isQueued(page)).toBe(true);

        const generateCalls = [];
        page.on('request', request => { if (request.url().includes('/generate')) generateCalls.push(request.url()); });
        await openCharacter(page, other);
        await expect(page.locator('#toast-container .toast', { hasText: 'The queued send was cancelled because the chat changed.' })).toHaveCount(1, { timeout: 10000 });
        expect(await isQueued(page)).toBe(false);
        await releaseGap(page);
        await page.waitForTimeout(SETTLE_MS);
        expect(generateCalls).toEqual([]);

        await openCharacter(page, avatar);
        await expect(page.locator('#send_textarea')).toHaveValue(second);
        await expect(page.locator('#chat .mes[mesid="3"]')).toHaveCount(0);
    });

    test('Enter during a generation does nothing, as before', async ({ page }) => {
        const slow = await startMockLlamaCpp({ streamDelayMs: 3000 });
        try {
            const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const avatar = await createCharacter(page, `RawActionEnterDuring-${stamp}`, `Hello from the greeting ${stamp}.`);
            await openCharacter(page, avatar);
            await connectLlamaCpp(page, slow.url);
            // @ts-ignore
            await page.evaluate(() => { SillyTavern.getContext().textCompletionSettings.streaming = true; });
            await page.waitForTimeout(SETTLE_MS);

            await page.locator('#send_textarea').fill(`First question ${stamp}?`);
            await page.locator('#send_but').click();
            await expect(page.locator('body')).toHaveAttribute('data-generating', 'true', { timeout: 10000 });
            const second = `Second question ${stamp}?`;
            await page.locator('#send_textarea').fill(second);
            await page.locator('#send_textarea').press('Enter');
            expect(await isQueued(page)).toBe(false);

            await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText('Mock reply', { timeout: 30000 });
            await expect(page.locator('body')).not.toHaveAttribute('data-generating', 'true', { timeout: 30000 });
            await page.waitForTimeout(SETTLE_MS);
            await expect(page.locator('#chat .mes[mesid="3"]')).toHaveCount(0);
            await expect(page.locator('#send_textarea')).toHaveValue(second);
        } finally {
            await slow.close();
        }
    });
});
