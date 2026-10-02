import http from 'node:http';
import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

// Pressing stop on a streaming reply stops the backend too (the server keeps a generation running when the
// page merely disconnects), and the page ends up showing exactly the reply the server stored.

const MODEL = 'generation-stop-model';
const PIECES = 40;

/**
 * A mock llama.cpp server whose streamed reply takes PIECES * delayMs, recording whether its connection
 * was closed before the reply finished.
 * @param {{ delayMs?: number }} [options]
 */
function startSlowLlamaCpp({ delayMs = 100 } = {}) {
    const state = { written: 0, finished: false, closedEarly: false, closedAt: 0 };
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const json = (value) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(value));
            };
            const path = (req.url ?? '').split('?')[0];
            if (path === '/props') return json({ model_alias: MODEL, model_path: `/models/${MODEL}.gguf`, build_info: 'b-stop', default_generation_settings: { n_ctx: 8192 } });
            if (path === '/v1/models') return json({ object: 'list', data: [{ id: MODEL, object: 'model' }] });
            if (path === '/tokenize') {
                const content = String(JSON.parse(body || '{}').content ?? '');
                return json({ tokens: content.split(/(?=\s)/).filter(Boolean).map((_, i) => 100 + i) });
            }
            if (path === '/completion' && JSON.parse(body || '{}').stream === false) {
                state.finished = true;
                return json({ content: 'The whole reply, already stored.', stop: true, model: MODEL, tokens_predicted: 6, tokens_evaluated: 10 });
            }
            if (path === '/completion') {
                res.on('close', () => {
                    if (!state.finished) {
                        state.closedEarly = true;
                        state.closedAt = Date.now();
                    }
                });
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                (async () => {
                    for (let i = 0; i < PIECES; i++) {
                        if (state.closedEarly) return;
                        res.write(`data: ${JSON.stringify({ content: `piece${i} `, stop: false })}\n\n`);
                        state.written++;
                        await new Promise(resolve => setTimeout(resolve, delayMs));
                    }
                    state.finished = true;
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
            resolve({ url: `http://127.0.0.1:${port}`, state, close: () => new Promise(done => server.close(() => done())) });
        });
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
async function createCharacter(page, name) {
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
    await expect.poll(() => page.evaluate(() => SillyTavern.getContext().onlineStatus), { timeout: 15000 }).not.toBe('no_connection');
    await page.locator('#API-status-top').click();
}

test.describe('stopping a generation', () => {
    test('stop on a streaming llama.cpp reply stops the backend, and the page shows the stored reply once', async ({ page }) => {
        const mock = await startSlowLlamaCpp();
        try {
            await testSetup.awaitST({ page });
            const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const avatar = await createCharacter(page, `Stop-${stamp}`);
            await openCharacter(page, avatar);
            await connectLlamaCpp(page, mock.url);
            // @ts-ignore
            await page.evaluate(() => { SillyTavern.getContext().textCompletionSettings.streaming = true; });
            // The server reads the backend from the saved settings; give the save time to land.
            await page.waitForTimeout(2500);

            const stopRequests = [];
            page.on('request', (request) => {
                if (new URL(request.url()).pathname.includes('/generate/stop/')) stopRequests.push(request.url());
            });

            await page.locator('#send_textarea').fill(`Tell me a long story ${stamp}.`);
            await page.locator('#send_but').click();
            await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText('piece2', { timeout: 30000 });

            const stoppedAt = Date.now();
            await page.locator('#mes_stop').click();
            await expect.poll(() => mock.state.closedEarly, { timeout: 3000 }).toBe(true);
            expect(mock.state.closedAt - stoppedAt).toBeLessThan(1500);
            expect(mock.state.written).toBeLessThan(PIECES);
            expect(stopRequests).toHaveLength(1);
            await expect(page.locator('#send_but')).toBeVisible({ timeout: 15000 });

            // The page's reply carries the stored node, its text is the stored text, and the stored path
            // holds the user message and this one reply: the stopped reply wasn't stored a second time.
            await expect.poll(() => page.evaluate(() => {
                // @ts-ignore
                const chat = SillyTavern.getContext().chat;
                return typeof chat[chat.length - 1]?.node_id === 'string';
            }), { timeout: 10000 }).toBe(true);
            const stored = await page.evaluate(async () => {
                // @ts-ignore
                const context = SillyTavern.getContext();
                const post = async (url, body) => (await fetch(url, { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify(body) })).json();
                const last = context.chat[context.chat.length - 1];
                const path = (await post('/api/chats/ancestry', { node_id: last.node_id })).messages;
                const siblings = (await post('/api/chats/alternatives', { node_id: last.node_id })).alternatives;
                return {
                    pageText: last.mes,
                    pageIds: context.chat.map(m => m.node_id ?? null),
                    pathIds: path.map(m => m.node_id),
                    storedText: path[path.length - 1].mes,
                    replies: siblings.filter(s => !s.is_user).length,
                };
            });
            await test.info().attach('after stop', { body: JSON.stringify(stored, null, 2), contentType: 'application/json' });
            expect(stored.storedText).toBe(stored.pageText);
            expect(stored.storedText).toContain('piece2');
            expect(stored.storedText).not.toContain(`piece${PIECES - 1}`);
            expect(stored.pageIds).toEqual(stored.pathIds);
            expect(stored.replies).toBe(1);
        } finally {
            await mock.close();
        }
    });

    test('stop on a non-streaming reply the server already stored shows that reply at once', async ({ page }) => {
        const mock = await startSlowLlamaCpp();
        try {
            await testSetup.awaitST({ page });
            const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const avatar = await createCharacter(page, `StopNS-${stamp}`);
            await openCharacter(page, avatar);
            await connectLlamaCpp(page, mock.url);
            // @ts-ignore
            await page.evaluate(() => { SillyTavern.getContext().textCompletionSettings.streaming = false; });
            await page.waitForTimeout(2500);

            // The server answers in full, but the answer is held back from the page until after stop is pressed.
            let serverAnswered = false;
            await page.route('**/api/backends/text-completions/generate', async (route) => {
                const response = await route.fetch();
                serverAnswered = true;
                await new Promise(resolve => setTimeout(resolve, 5000));
                await route.fulfill({ response }).catch(() => { });
            });

            await page.locator('#send_textarea').fill(`Say something ${stamp}.`);
            await page.locator('#send_but').click();
            await expect.poll(() => serverAnswered, { timeout: 30000 }).toBe(true);
            await page.locator('#mes_stop').click();

            await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText('The whole reply, already stored.', { timeout: 4000 });
            const lastNode = await page.evaluate(() => {
                // @ts-ignore
                const chat = SillyTavern.getContext().chat;
                return chat[chat.length - 1]?.node_id ?? null;
            });
            expect(typeof lastNode).toBe('string');
        } finally {
            await mock.close();
        }
    });
});
