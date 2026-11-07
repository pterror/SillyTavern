import http from 'node:http';
import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, chatBox } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

const MODEL = 'raw-action-log-model';

/**
 * @param {{ completion?: (n: number) => object | null, streamDelayMs?: number }} [options]
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
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string} greeting
 */
async function createCharacter(page, name, greeting) {
    return page.evaluate(async ({ name, greeting }) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders({ omitContentType: true });
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
        await stTest.context().getCharacters();
        const { selectCharacterByAvatar } = await import('/script.js');
        await selectCharacterByAvatar(avatar);
    }, avatar);
    await expect(page.locator('#avatar_url_pole')).toHaveValue(avatar, { timeout: 10000 });
    await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);
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
    await page.locator('#api_button_textgenerationwebui').click();
    // @ts-ignore
    await expect.poll(() => page.evaluate(() => stTest.context().onlineStatus), { timeout: 15000 }).not.toBe('no_connection');
    await page.locator('#API-status-top').click();
}

/**
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
 * @param {import('@playwright/test').Page} page
 * @param {string} text
 * @param {number} mesid
 */
async function send(page, text, mesid) {
    await chatBox(page).fill(text);
    await page.locator('#send_but').click();
    await expect(page.locator(`#chat .mes[mesid="${mesid}"] .mes_text`)).toContainText('Mock reply', { timeout: 30000 });
    await expect(page.locator('#send_but')).toBeVisible({ timeout: 30000 });
}

const SETTLE_MS = 2500;

/**
 * Streaming is a stored setting the server reads, so it's saved, not only set on the page.
 * @param {import('@playwright/test').Page} page
 * @param {boolean} on
 */
async function setStreaming(page, on) {
    await page.evaluate(async (on) => {
        // @ts-ignore
        stTest.context().textCompletionSettings.streaming = on;
        const { saveSettings } = await import('/script.js');
        await saveSettings('textgenerationwebui_settings');
    }, on);
}

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
            const generate = requests.filter(r => r.url === '/api/generation/generate');
            expect(generate).toHaveLength(1);
            expect(generate[0].body.user_message.mes).toBe(text);
            expect(generate[0].body).not.toHaveProperty('prompt');

            const countedChatTexts = requests
                .filter(r => r.url.startsWith('/api/tokenizers/'))
                .flatMap(r => [r.body?.text, ...(Array.isArray(r.body?.texts) ? r.body.texts : [])])
                .filter(counted => typeof counted === 'string' && chatTexts.some(t => counted.includes(t)));
            expect(countedChatTexts).toEqual([]);

            expect(backend.filter(r => r.url === '/props')).toHaveLength(1);
            expect(backend.filter(r => r.url === '/v1/models')).toHaveLength(0);
        }
        expect(tokenized[1].filter(text => tokenized[0].includes(text))).toEqual([]);
    });

    test('a non-streaming llama.cpp answer with no readable reply shows that it was not saved', async ({ page }) => {
        const unreadable = await startMockLlamaCpp({ completion: () => ({ unexpected_field: 'Secret unreadable reply.' }) });
        try {
            const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const avatar = await createCharacter(page, `RawActionUnreadable-${stamp}`, `Hello from the greeting ${stamp}.`);
            await openCharacter(page, avatar);
            await connectLlamaCpp(page, unreadable.url);
            await setStreaming(page, false);
            await page.waitForTimeout(SETTLE_MS);

            await chatBox(page).fill(`Unreadable question ${stamp}?`);
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
            await setStreaming(page, streaming);
            await page.waitForTimeout(SETTLE_MS);

            /** @type {boolean[]} */
            const streamed = [];
            page.on('response', (response) => {
                if (new URL(response.url()).pathname === '/api/generation/generate') streamed.push(response.headers()['x-st-stream-format'] === 'compact-v1');
            });
            const first = `First question ${stamp}?`;
            await send(page, first, 2);
            await send(page, `Second question ${stamp}?`, 4);
            await page.waitForTimeout(SETTLE_MS);

            expect(streamed).toEqual([streaming, streaming]);

            const stored = await page.evaluate(async (first) => {
                // @ts-ignore
                const context = stTest.context();
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
                await setStreaming(page, streaming);
                await page.waitForTimeout(SETTLE_MS);

                const first = `First question ${stamp}?`;
                await chatBox(page).fill(first);
                await page.locator('#send_but').click();
                await expect(page.locator('#chat .mes[mesid="1"] .mes_text')).toContainText(first, { timeout: 30000 });
                await expect(page.locator('#send_but')).toBeVisible({ timeout: 30000 });
                await page.waitForTimeout(SETTLE_MS);
                await send(page, `Second question ${stamp}?`, 3);
                await page.waitForTimeout(SETTLE_MS);

                const stored = await page.evaluate(async (first) => {
                    // @ts-ignore
                    const context = stTest.context();
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

    const answers = [
        { name: '200 with an error body', answer: stored => ({ status: 200, body: { error: true, status: 500, response: 'failed', stored } }) },
        { name: '400', answer: stored => ({ status: 400, body: { error: { message: 'failed' }, stored } }) },
        { name: '500', answer: stored => ({ status: 500, body: { error: { message: 'failed' }, stored } }) },
        { name: '400 with a plain-text body', answer: () => ({ status: 400, text: 'Bad Request' }) },
        { name: '500 from the backend, passed on', answer: () => ({ status: 500, text: 'backend exploded' }) },
    ];
    const senders = answers.map(({ name, answer }) => ({
        name: `a generation answered ${name}`, url: '**/api/generation/generate', answer,
        call: async () => {
            const { sendGeneration } = await import('/scripts/generation-request.js');
            return sendGeneration({ character_avatar: 'x' }, new AbortController().signal);
        },
    }));
    for (const sender of senders) {
        test(`${sender.name}: the page takes on the stored user message from an error answer`, async ({ page }) => {
            const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const avatar = await createCharacter(page, `RawActionAdopt-${stamp}`, `Hello from the greeting ${stamp}.`);
            await openCharacter(page, avatar);

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
                const chat = stTest.context().chat;
                return chat[chat.length - 1].node_id ?? null;
            }, sender.call.toString());
            expect(nodeId).toBe(stored[0].node_id);
        });
    }

    test('a send clicked after a streamed reply shows the button again, while the previous send is still finishing, goes out', async ({ page }) => {
        const slow = await startMockLlamaCpp({ streamDelayMs: 5000 });
        await page.route('**/generate/stop/**', async (route) => {
            await new Promise(resolve => setTimeout(resolve, 1500));
            await route.continue();
        });
        try {
            const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const avatar = await createCharacter(page, `RawActionEarlySend-${stamp}`, `Hello from the greeting ${stamp}.`);
            await openCharacter(page, avatar);
            await connectLlamaCpp(page, slow.url);
            await setStreaming(page, true);
            await page.waitForTimeout(SETTLE_MS);

            await chatBox(page).fill(`First question ${stamp}?`);
            const second = `Second question ${stamp}?`;
            const clickedInWindow = await page.evaluate(async (second) => {
                const { userInputGenerateMutex } = await import('/script.js');
                document.querySelector('#send_but').click();
                let stopClicked = false;
                const deadline = performance.now() + 30000;
                while (performance.now() < deadline) {
                    const shown = getComputedStyle(document.querySelector('#send_but')).display !== 'none';
                    const streaming = !!document.querySelector('#chat .mes[mesid="2"]') && document.body.dataset.generating === 'true';
                    if (streaming && !stopClicked) {
                        stopClicked = true;
                        await new Promise(resolve => setTimeout(resolve, 300));
                        document.querySelector('#mes_stop').click();
                    }
                    if (stopClicked && shown && document.body.dataset.generating === undefined && userInputGenerateMutex.isBusy) {
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
        } finally {
            await page.unroute('**/generate/stop/**');
            await slow.close();
        }
    });

    /**
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
            await setStreaming(page, true);
            await page.waitForTimeout(SETTLE_MS);
            await sendAndHoldGap(page, `First question ${stamp}?`);

            const second = `Second question ${stamp}?`;
            await chatBox(page).fill(second);
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
                await chatBox(page).press('Enter');
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
        await setStreaming(page, true);
        await page.waitForTimeout(SETTLE_MS);
        await sendAndHoldGap(page, `First question ${stamp}?`);

        const second = `Second question ${stamp}?`;
        await chatBox(page).fill(second);
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
            await setStreaming(page, true);
            await page.waitForTimeout(SETTLE_MS);

            await chatBox(page).fill(`First question ${stamp}?`);
            await page.locator('#send_but').click();
            await expect(page.locator('body')).toHaveAttribute('data-generating', 'true', { timeout: 10000 });
            const second = `Second question ${stamp}?`;
            await chatBox(page).fill(second);
            await chatBox(page).press('Enter');
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
