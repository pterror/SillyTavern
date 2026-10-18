import http from 'node:http';
import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer, chatBox } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

// A generated reply that opens with a reasoning block (auto-parse on) is stored by the server with the block split
// off: `mes` is the answer and `extra.reasoning` the reasoning. The page shows what was stored, so the chat reopened
// still shows the reasoning as a reasoning block, not as raw text in the message.

const MODEL = 'reasoning-stored-model';

/**
 * A mock llama.cpp server answering every completion with `reply`, streamed in small pieces or whole.
 * @param {() => string} reply
 */
function startLlamaCpp(reply) {
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const json = (value) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(value));
            };
            const path = (req.url ?? '').split('?')[0];
            if (path === '/props') return json({ model_alias: MODEL, model_path: `/models/${MODEL}.gguf`, build_info: 'b-reasoning', default_generation_settings: { n_ctx: 8192 } });
            if (path === '/v1/models') return json({ object: 'list', data: [{ id: MODEL, object: 'model' }] });
            if (path === '/tokenize') {
                const content = String(JSON.parse(body || '{}').content ?? '');
                return json({ tokens: content.split(/(?=\s)/).filter(Boolean).map((_, i) => 100 + i) });
            }
            if (path === '/completion') {
                const text = reply();
                if (JSON.parse(body || '{}').stream === false) {
                    return json({ content: text, stop: true, model: MODEL, tokens_predicted: 6, tokens_evaluated: 10 });
                }
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                (async () => {
                    // Pieces that cut through the prefix and suffix, as a real stream does.
                    for (let i = 0; i < text.length; i += 5) {
                        res.write(`data: ${JSON.stringify({ content: text.slice(i, i + 5), stop: false })}\n\n`);
                        await new Promise(resolve => setTimeout(resolve, 5));
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
            resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise(done => server.close(() => done())) });
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
    await page.locator('#api_button_textgenerationwebui').click();
    // @ts-ignore
    await expect.poll(() => page.evaluate(() => SillyTavern.getContext().onlineStatus), { timeout: 15000 }).not.toBe('no_connection');
    await page.locator('#API-status-top').click();
}

/**
 * Turns reasoning auto-parse on with this prefix and suffix, through the settings' own fields (which save them).
 * @param {import('@playwright/test').Page} page
 * @param {{prefix: string, suffix: string}} format
 */
async function setReasoningFormat(page, { prefix, suffix }) {
    await page.evaluate(({ prefix, suffix }) => {
        const autoParse = /** @type {HTMLInputElement} */ (document.getElementById('reasoning_auto_parse'));
        autoParse.checked = true;
        autoParse.dispatchEvent(new Event('change', { bubbles: true }));
        for (const [id, value] of [['reasoning_prefix', prefix], ['reasoning_suffix', suffix]]) {
            const field = /** @type {HTMLTextAreaElement} */ (document.getElementById(id));
            field.value = value;
            field.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }, { prefix, suffix });
}

/**
 * The last reply as the page has it, as it is drawn, and as the server stored it.
 * @param {import('@playwright/test').Page} page
 */
function lastReply(page) {
    return page.evaluate(async () => {
        // @ts-ignore
        const context = SillyTavern.getContext();
        const at = context.chat.length - 1;
        const message = context.chat[at];
        const block = document.querySelector(`#chat .mes[mesid="${at}"]`);
        let stored = null;
        if (typeof message?.node_id === 'string') {
            const response = await fetch('/api/chats/ancestry', { method: 'POST', headers: context.getRequestHeaders(), body: JSON.stringify({ node_id: message.node_id }) });
            const path = (await response.json()).messages;
            const last = path[path.length - 1];
            stored = { mes: last.mes, reasoning: last.extra?.reasoning, type: last.extra?.reasoning_type };
        }
        return {
            mes: message?.mes,
            reasoning: message?.extra?.reasoning,
            drawnText: block?.querySelector('.mes_text')?.textContent?.trim(),
            drawnReasoning: block?.querySelector('.mes_reasoning')?.textContent?.trim(),
            reasoningShown: block?.classList.contains('reasoning') ?? false,
            stored,
        };
    });
}

const FORMATS = [
    { name: 'custom', prefix: '<|channel>thought', suffix: '<channel|>' },
    { name: 'think', prefix: '<think>', suffix: '</think>' },
];

for (const streaming of [true, false]) {
    for (const format of FORMATS) {
        test(`a reply's reasoning block is stored split off and shown after reopening (${format.name}, ${streaming ? 'streaming' : 'not streaming'})`, async ({ page }) => {
            const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const reasoning = `Weighing the road ${stamp}.`;
            const answer = `Two days on foot ${stamp}.`;
            const mock = await startLlamaCpp(() => `${format.prefix}\n${reasoning}\n${format.suffix}\n\n${answer}`);
            try {
                await testSetup.awaitST({ page });
                const avatar = await createCharacter(page, `Thinker-${stamp}`);
                await openCharacter(page, avatar);
                await expect(page.locator('#chat .mes[mesid="0"]')).toHaveCount(1);
                await connectLlamaCpp(page, mock.url);
                await setReasoningFormat(page, format);
                // @ts-ignore
                await page.evaluate((streaming) => { SillyTavern.getContext().textCompletionSettings.streaming = streaming; }, streaming);
                // The server reads the backend and the reasoning format from the saved settings; give the saves time to land.
                await page.waitForTimeout(2500);

                await chatBox(page).fill(`How far is it ${stamp}?`);
                await page.locator('#send_but').click();
                await expect(page.locator('#chat .mes[mesid="2"]')).toHaveCount(1, { timeout: 30000 });
                await expect(page.locator('#send_but')).toBeVisible({ timeout: 30000 });
                await expect.poll(() => page.evaluate(() => {
                    // @ts-ignore
                    const chat = SillyTavern.getContext().chat;
                    return typeof chat[chat.length - 1]?.node_id === 'string';
                }), { timeout: 10000 }).toBe(true);

                const want = {
                    mes: answer,
                    reasoning,
                    drawnText: answer,
                    drawnReasoning: reasoning,
                    reasoningShown: true,
                    stored: { mes: answer, reasoning, type: 'parsed' },
                };
                await expect.poll(() => lastReply(page), { timeout: 10000 }).toEqual(want);

                // Away to another character and back: the chat is drawn from what the server stored.
                const other = await createCharacter(page, `Other-${stamp}`);
                await openCharacter(page, other);
                await openCharacter(page, avatar);
                await expect(page.locator('#chat .mes')).toHaveCount(3, { timeout: 10000 });
                await expect.poll(() => lastReply(page), { timeout: 10000 }).toEqual(want);
            } finally {
                await mock.close();
            }
        });
    }
}
