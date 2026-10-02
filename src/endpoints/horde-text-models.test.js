import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock, test, after } from 'node:test';

import express from 'express';

import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

// /text-models asks AI Horde for the model list and GitHub for model metadata. Both hosts are sent to a
// local fake here; nothing reaches the real services.
const canMock = typeof mock.module === 'function';
let fakeUrl = null;
/** @type {{ status: number, body: any }} */
let modelsAnswer = { status: 200, body: [] };
/** @type {{ status: number, body: any }} */
let metadataAnswer = { status: 200, body: {} };

if (canMock) {
    const realNodeFetch = (await import(path.join(__dirname, '..', '..', 'node_modules', 'node-fetch', 'src', 'index.js'))).default;
    mock.module('node-fetch', {
        defaultExport: async (url, opts) => {
            const target = new URL(url);
            if (fakeUrl && (target.origin === 'https://aihorde.net' || target.origin === 'https://raw.githubusercontent.com')) {
                return realNodeFetch(new URL(`/${target.hostname}${target.pathname}`, fakeUrl), opts);
            }
            return realNodeFetch(url, opts);
        },
        namedExports: {},
    });
}

const fake = http.createServer((req, res) => {
    const answer = req.url.startsWith('/aihorde.net/') ? modelsAnswer : metadataAnswer;
    res.writeHead(answer.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(answer.body));
});
await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
fakeUrl = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (fake.address()).port}`;

const { router } = await import('./horde.js');
const app = express();
app.use(express.json());
app.use('/api/horde', router);
const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

after(() => {
    server.close();
    fake.close();
});

async function textModels() {
    const response = await fetch(`${base}/api/horde/text-models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
    });
    return { status: response.status, body: await response.json() };
}

test('an error object from Horde is a failed fetch naming what Horde said, not a TypeError', { skip: !canMock }, async () => {
    modelsAnswer = { status: 429, body: { message: 'Too many requests from this client agent' } };
    metadataAnswer = { status: 200, body: {} };
    const warnings = [];
    const errors = [];
    const warn = mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
    const error = mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
    try {
        const result = await textModels();
        assert.equal(result.status, 502);
        assert.equal(result.body.error, true);
        assert.match(result.body.message, /HTTP 429: Too many requests from this client agent/);
        assert.ok(warnings.some(w => w.includes('Too many requests')));
        assert.ok(!errors.some(e => e.includes('TypeError')), `no TypeError logged: ${errors.join('\n')}`);
    } finally {
        warn.mock.restore();
        error.mock.restore();
    }
});

test('a 200 answer that is not a list is also a failed fetch, and it is not cached', { skip: !canMock }, async () => {
    modelsAnswer = { status: 200, body: { message: 'maintenance' } };
    const warn = mock.method(console, 'warn', () => {});
    try {
        const failed = await textModels();
        assert.equal(failed.status, 502);
        assert.match(failed.body.message, /maintenance/);
    } finally {
        warn.mock.restore();
    }

    modelsAnswer = { status: 200, body: [{ name: 'koboldcpp/Model-A', performance: 1 }] };
    metadataAnswer = { status: 200, body: { 'Model-A': { baseline: 'llama' } } };
    const ok = await textModels();
    assert.equal(ok.status, 200);
    assert.ok(Array.isArray(ok.body));
    assert.equal(ok.body[0].name, 'koboldcpp/Model-A');
});

test('a list with metadata that is not an object still answers the models', { skip: !canMock }, async () => {
    modelsAnswer = { status: 200, body: [{ name: 'Model-B', performance: 2 }] };
    metadataAnswer = { status: 200, body: ['not', 'an', 'object'] };
    const warn = mock.method(console, 'warn', () => {});
    try {
        const result = await textModels();
        assert.equal(result.status, 200);
        assert.deepEqual(result.body.map(m => m.name), ['Model-B']);
    } finally {
        warn.mock.restore();
    }
});
