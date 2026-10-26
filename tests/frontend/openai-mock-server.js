// A mock OpenAI-compatible server, for the chat completion tests: the custom source pointed at it. No test runner
// needed, so the prompt goldens' generator uses it too.
import http from 'node:http';

/**
 * Answers every chat completion with `reply`, whole or streamed in one piece, and logs every request.
 * @param {{ model?: string, reply?: string }} [options]
 * @returns {Promise<{ url: string, log: { url: string, body: any }[], close: () => Promise<void> }>}
 */
export function startOpenAICompat({ model = 'mock-chat-model', reply = 'Mock reply.' } = {}) {
    /** @type {{ url: string, body: any }[]} */
    const log = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
            let body = {};
            try { body = JSON.parse(raw || '{}'); } catch { /* not JSON */ }
            log.push({ url: req.url ?? '', body });
            const path = (req.url ?? '').split('?')[0];
            if (path.endsWith('/models')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model' }] }));
            }
            if (path.endsWith('/chat/completions')) {
                if (/** @type {any} */ (body).stream) {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }] })}\n\n`);
                    res.write(`data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
                    return res.end('data: [DONE]\n\n');
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ id: 'mock', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] }));
            }
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end('{}');
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
            resolve({ url: `http://127.0.0.1:${port}/v1`, log, close: () => new Promise(done => server.close(() => done(undefined))) });
        });
    });
}
