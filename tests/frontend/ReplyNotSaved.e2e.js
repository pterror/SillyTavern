import http from 'node:http';
import { test, expect } from './fixtures.js';
import { testSetup, openCharacterManagementDrawer } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

// The server stores every reply that lands in the chat; the page never writes one. When the server
// says it couldn't store a reply, the page shows that and offers to store it again (on the server),
// doesn't write it itself, and doesn't let the chat continue from it until it's stored.
//
// The server's answer is rewritten here to look like a failed store (the node id replaced by a
// `reply-not-saved` warning); the server side of a failed store is tested in reply-not-saved.test.js.

const MODEL = 'reply-not-saved-model';
const REPLY = 'The ship sails at dawn.';

function startLlamaCpp() {
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const json = (value) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(value));
            };
            const path = (req.url ?? '').split('?')[0];
            if (path === '/props') return json({ model_alias: MODEL, model_path: `/models/${MODEL}.gguf`, build_info: 'b-rns', default_generation_settings: { n_ctx: 8192 } });
            if (path === '/v1/models') return json({ object: 'list', data: [{ id: MODEL, object: 'model' }] });
            if (path === '/tokenize') {
                const content = String(JSON.parse(body || '{}').content ?? '');
                return json({ tokens: content.split(/(?=\s)/).filter(Boolean).map((_, i) => 100 + i) });
            }
            if (path === '/completion' && JSON.parse(body || '{}').stream === false) {
                return json({ content: REPLY, stop: true, model: MODEL, tokens_predicted: 6, tokens_evaluated: 10 });
            }
            if (path === '/completion') {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.write(`data: ${JSON.stringify({ content: REPLY.slice(0, 9), stop: false })}\n\n`);
                res.write(`data: ${JSON.stringify({ content: REPLY.slice(9), stop: false })}\n\n`);
                res.end(`data: ${JSON.stringify({ content: '', stop: true })}\n\n`);
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

/** @param {import('@playwright/test').Page} page @param {string} name */
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

/** @param {import('@playwright/test').Page} page @param {string} avatar */
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

/** @param {import('@playwright/test').Page} page @param {string} url */
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

/** A compact-stream frame: 0xFF, type, 4-byte big-endian length, body. */
function frame(type, body) {
    const header = Buffer.alloc(6);
    header[0] = 0xFF;
    header[1] = type;
    header.writeUInt32BE(body.length, 2);
    return Buffer.concat([header, body]);
}

/**
 * Turns a stream that ends with the stored reply's node frame (0x04) into one that ends with a
 * `reply-not-saved` warnings frame (0x08) instead. Returns the rewritten body and the real node id.
 * @param {Buffer} bytes
 * @param {string} generationId
 */
function failStoreInStream(bytes, generationId) {
    for (let at = bytes.length - 6; at >= 0; at--) {
        if (bytes[at] !== 0xFF || bytes[at + 1] !== 0x04) continue;
        const length = bytes.readUInt32BE(at + 2);
        if (at + 6 + length !== bytes.length) continue;
        const nodeId = bytes.subarray(at + 6).toString('utf-8');
        const warning = { warnings: [{ kind: 'reply-not-saved', key: generationId, generation_id: generationId, reason: 'disk is full', message: 'This reply wasn\'t saved (disk is full).' }] };
        return { body: Buffer.concat([bytes.subarray(0, at), frame(0x08, Buffer.from(JSON.stringify(warning)))]), nodeId };
    }
    throw new Error('the stream had no node frame at its end');
}

for (const streaming of [true, false]) {
    test(`a reply the server couldn't store (${streaming ? 'streaming' : 'not streaming'}) is shown as not saved, never written by the page, and stored again on request`, async ({ page }) => {
        const mock = await startLlamaCpp();
        try {
            await testSetup.awaitST({ page });
            const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const avatar = await createCharacter(page, `NotSaved-${stamp}`);
            await openCharacter(page, avatar);
            await connectLlamaCpp(page, mock.url);
            await page.evaluate((streaming) => {
                // @ts-ignore
                SillyTavern.getContext().textCompletionSettings.streaming = streaming;
            }, streaming);
            await page.waitForTimeout(2500);

            let realNodeId = null;
            let generationId = null;
            await page.route('**/api/backends/text-completions/generate', async (route) => {
                const response = await route.fetch();
                generationId = response.headers()['x-generation-id'];
                if (streaming) {
                    const { body, nodeId } = failStoreInStream(await response.body(), generationId);
                    realNodeId = nodeId;
                    await route.fulfill({ response, body });
                } else {
                    const data = await response.json();
                    realNodeId = data.assistant_node_id;
                    delete data.assistant_node_id;
                    data.warnings = [{ kind: 'reply-not-saved', key: generationId, generation_id: generationId, reason: 'disk is full', message: 'This reply wasn\'t saved (disk is full).' }];
                    await route.fulfill({ response, json: data });
                }
            });

            // Every message write the page sends that carries the reply.
            const pageWrites = [];
            page.on('request', (request) => {
                const path = new URL(request.url()).pathname;
                if (/^\/api\/chats\//.test(path) && (request.postData() ?? '').includes(REPLY)) pageWrites.push(path);
            });

            await page.locator('#send_textarea').fill(`When do we leave ${stamp}?`);
            await page.locator('#send_but').click();
            await expect(page.locator('#chat .mes[mesid="2"] .mes_text')).toContainText(REPLY, { timeout: 30000 });
            await expect(page.locator('#send_but')).toBeVisible({ timeout: 15000 });
            await page.waitForTimeout(500);
            expect(pageWrites, 'the page did not write the reply itself').toEqual([]);

            const notice = page.locator('.toast-error', { hasText: 'Reply not saved' });
            await expect(notice).toBeVisible();
            await expect(notice).toContainText('disk is full');
            const marked = await page.evaluate(() => {
                // @ts-ignore
                const chat = SillyTavern.getContext().chat;
                const last = chat[chat.length - 1];
                return { flag: last.extra?.reply_not_saved ?? null, nodeId: last.node_id ?? null };
            });
            expect(marked.flag).toBe(generationId);
            expect(typeof marked.nodeId === 'string' && !marked.nodeId.startsWith('card:')).toBe(false);

            // An extension's generic save doesn't write it, and the chat can't continue from it.
            await page.evaluate(async () => {
                // @ts-ignore
                await SillyTavern.getContext().saveChat();
            });
            await page.locator('#send_textarea').fill('And then?');
            await page.locator('#send_but').click();
            await expect(page.locator('.toast-error', { hasText: 'isn\'t saved yet' })).toBeVisible();
            await expect(page.locator('#chat .mes')).toHaveCount(3);
            await page.waitForTimeout(500);
            expect(pageWrites).toEqual([]);

            // Saving again asks the server; the reply then carries the stored node.
            const retries = [];
            await page.route('**/api/generation/store/*', async (route) => {
                retries.push(new URL(route.request().url()).pathname);
                await route.fulfill({ json: { state: 'saved', node_id: realNodeId, mes: REPLY } });
            });
            await notice.getByRole('button', { name: 'Save it again' }).click();
            await expect(page.locator('.toast-success', { hasText: 'saved now' })).toBeVisible();
            expect(retries).toEqual([`/api/generation/store/${generationId}`]);
            const after = await page.evaluate(() => {
                // @ts-ignore
                const chat = SillyTavern.getContext().chat;
                const last = chat[chat.length - 1];
                return { flag: last.extra?.reply_not_saved ?? null, nodeId: last.node_id ?? null };
            });
            expect(after).toEqual({ flag: null, nodeId: realNodeId });
            expect(pageWrites).toEqual([]);
        } finally {
            await mock.close();
        }
    });
}
