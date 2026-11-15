import http from 'node:http';
import { expect } from './fixtures.js';
import { openCharacterManagementDrawer } from './frontent-test-utils.js';

/**
 * @typedef {object} LlamaCppMockState
 * @property {string} loaded the model file /props names
 * @property {number} tokensPerWord
 * @property {number} tokenizeDelayMs
 * @property {boolean} failCompletion
 */

/**
 * @param {{ model?: string, reply?: (n: number) => string, delayMs?: number, pieceDelayMs?: number }} [options]
 * @returns {Promise<{ url: string, log: { url: string, body: any }[], state: LlamaCppMockState, close: () => Promise<void> }>}
 */
export function startLlamaCpp({ model = 'mock-llamacpp-model', reply = n => `Mock reply ${n}.`, delayMs = 0, pieceDelayMs = 0 } = {}) {
    /** @type {{ url: string, body: any }[]} */
    const log = [];
    /** @type {LlamaCppMockState} */
    const state = { loaded: model, tokensPerWord: 1, tokenizeDelayMs: 0, failCompletion: false };
    let n = 0;
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            let body = {};
            try { body = JSON.parse(raw || '{}'); } catch { /* not JSON */ }
            log.push({ url: req.url ?? '', body });
            const json = (/** @type {any} */ value) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(value));
            };
            const path = (req.url ?? '').split('?')[0];
            if (path === '/props') return json({ model_alias: model, model_path: `/models/${state.loaded}.gguf`, build_info: 'b-mock', default_generation_settings: { n_ctx: 8192 } });
            if (path === '/v1/models') return json({ object: 'list', data: [{ id: model, object: 'model' }] });
            if (path === '/tokenize') {
                const content = String(/** @type {any} */ (body).content ?? '');
                const words = content.split(/(?=\s)/).filter(Boolean);
                const tokens = words.flatMap(() => Array.from({ length: state.tokensPerWord }, () => 0)).map((_, i) => 100 + i);
                setTimeout(() => json({ tokens }), state.tokenizeDelayMs);
                return;
            }
            if (path === '/completion' && state.failCompletion) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'mock failure' }));
                return;
            }
            if (path === '/completion') {
                const text = reply(++n);
                setTimeout(() => {
                    if (/** @type {any} */ (body).stream) {
                        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                        const pieces = pieceDelayMs > 0 ? text.split(/(?=\s)/) : [text];
                        let closed = false;
                        res.on('close', () => { closed = true; });
                        (async () => {
                            for (const [i, piece] of pieces.entries()) {
                                if (closed) return;
                                if (i > 0) await new Promise(resolve => setTimeout(resolve, pieceDelayMs));
                                res.write(`data: ${JSON.stringify({ content: piece, stop: false })}\n\n`);
                            }
                            res.end(`data: ${JSON.stringify({ content: '', stop: true })}\n\n`);
                        })();
                        return;
                    }
                    json({ content: text, stop: true, model, tokens_predicted: 4, tokens_evaluated: 10 });
                }, delayMs);
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
            resolve({ url: `http://127.0.0.1:${port}`, log, state, close: () => new Promise(done => server.close(() => done(undefined))) });
        });
    });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string} [greeting]
 */
export function createCharacter(page, name, greeting = 'Hello.') {
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
export async function openCharacter(page, avatar) {
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
export async function connectLlamaCpp(page, url) {
    if (!(await page.locator('#main_api').isVisible())) {
        await page.locator('#API-status-top').click();
        await page.locator('#main_api').waitFor({ state: 'visible' });
    }
    await page.selectOption('#main_api', 'textgenerationwebui', { force: true });
    await page.locator('#textgen_type').selectOption('llamacpp');
    await page.locator('#llamacpp_api_url_text').fill(url);
    // Leaving the field cancels the server history's pending search, whose menu would open over Connect
    await page.locator('#llamacpp_api_url_text').blur();
    await page.locator('#api_button_textgenerationwebui').click();
    // @ts-ignore
    await expect.poll(() => page.evaluate(() => stTest.context().onlineStatus), { timeout: 15000 }).not.toBe('no_connection');
    await page.locator('#API-status-top').click();
    await page.waitForTimeout(2500);
}
