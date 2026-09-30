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
 * @param {{ completion?: (n: number) => object }} [options] The body `/completion` answers with for the n-th reply.
 * @returns {Promise<{ url: string, log: { method: string, url: string, body: string }[], close: () => Promise<void> }>}
 */
function startMockLlamaCpp({ completion = n => ({ content: `Mock reply ${n}.` }) } = {}) {
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
                return json(completion(++replies));
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
});
