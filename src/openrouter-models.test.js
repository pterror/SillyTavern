import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock } from 'node:test';

import express from 'express';

import { setConfigFilePath } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', 'config.yaml'));

if (typeof mock.module !== 'function') {
    throw new Error('openrouter-models.test.js needs --experimental-test-module-mocks to stub node-fetch');
}

const MODELS_URL = 'https://openrouter.ai/api/v1/models';

// Rows of OpenRouter's /models reply as it was on 2026-09-28, cut down to the fields read here.
const LISTED = [
    { id: 'deepseek/deepseek-chat-v3.1', hugging_face_id: 'deepseek-ai/DeepSeek-V3.1' },
    { id: 'anthropic/claude-sonnet-4', hugging_face_id: '' },
    { id: 'openrouter/auto' },
    { id: 'google/gemma-4-31b-it:free', hugging_face_id: 'google/gemma-4-31B-it' },
];

/** @type {string[]} */
const requests = [];
/** @type {() => Response} */
let respond = () => new Response('not found', { status: 404, statusText: 'Not Found' });
mock.module('node-fetch', {
    defaultExport: async (url) => {
        requests.push(String(url));
        if (String(url) !== MODELS_URL) {
            throw new Error(`unexpected request: ${url}`);
        }
        return respond();
    },
    namedExports: {},
});

const listReply = (data = LISTED) => () => new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });

const {
    fetchOpenRouterModels, forgetOpenRouterModels, lookupOpenRouterHuggingFaceId, rememberOpenRouterModels,
    OPENROUTER_MODELS_MAX_AGE_MS,
} = await import('./openrouter-models.js');

/**
 * @param {string} name
 * @param {() => Promise<void> | void} fn
 */
async function testCase(name, fn) {
    requests.length = 0;
    forgetOpenRouterModels();
    respond = listReply();
    try {
        await fn();
        console.log(`ok - ${name}`);
    } catch (error) {
        console.log(`not ok - ${name}`);
        throw error;
    }
}

/** A fetch that fails the test if the list is fetched. */
const noFetch = async () => {
    throw new Error('the list was fetched');
};

await testCase('fetchOpenRouterModels reads the data array of the public list, without a key', async () => {
    assert.deepEqual(await fetchOpenRouterModels(), LISTED);
    assert.deepEqual(requests, [MODELS_URL]);
    respond = () => new Response('down', { status: 503, statusText: 'Service Unavailable' });
    assert.equal(await fetchOpenRouterModels(), null);
    respond = () => new Response(JSON.stringify({ models: [] }), { status: 200 });
    assert.equal(await fetchOpenRouterModels(), null);
});

await testCase('a lookup fetches the list once and answers each model\'s hugging_face_id', async () => {
    const [first, second] = await Promise.all([
        lookupOpenRouterHuggingFaceId('deepseek/deepseek-chat-v3.1'),
        lookupOpenRouterHuggingFaceId('anthropic/claude-sonnet-4'),
    ]);
    assert.deepEqual(first, { ok: true, huggingFaceId: 'deepseek-ai/DeepSeek-V3.1' });
    assert.deepEqual(second, { ok: true, huggingFaceId: null }, 'an empty hugging_face_id is none');
    assert.deepEqual(await lookupOpenRouterHuggingFaceId('openrouter/auto'), { ok: true, huggingFaceId: null });
    assert.deepEqual(await lookupOpenRouterHuggingFaceId('some/unlisted-model'), { ok: true, huggingFaceId: null });
    assert.deepEqual(requests, [MODELS_URL], 'one fetch for every lookup');
});

await testCase('a variant suffix OpenRouter doesn\'t list itself is looked up without it', async () => {
    assert.deepEqual(await lookupOpenRouterHuggingFaceId('deepseek/deepseek-chat-v3.1:nitro'), { ok: true, huggingFaceId: 'deepseek-ai/DeepSeek-V3.1' });
    assert.deepEqual(await lookupOpenRouterHuggingFaceId('google/gemma-4-31b-it:free'), { ok: true, huggingFaceId: 'google/gemma-4-31B-it' });
});

await testCase('the list is fetched again once it is more than an hour old', async () => {
    const realNow = performance.now();
    const clock = mock.method(performance, 'now', () => realNow);
    try {
        await lookupOpenRouterHuggingFaceId('deepseek/deepseek-chat-v3.1');
        clock.mock.mockImplementation(() => realNow + OPENROUTER_MODELS_MAX_AGE_MS - 1);
        await lookupOpenRouterHuggingFaceId('deepseek/deepseek-chat-v3.1');
        assert.equal(requests.length, 1, 'not refetched within the hour');

        respond = listReply([{ id: 'deepseek/deepseek-chat-v3.1', hugging_face_id: 'deepseek-ai/DeepSeek-V3.1-Terminus' }]);
        clock.mock.mockImplementation(() => realNow + OPENROUTER_MODELS_MAX_AGE_MS);
        assert.deepEqual(await lookupOpenRouterHuggingFaceId('deepseek/deepseek-chat-v3.1'), { ok: true, huggingFaceId: 'deepseek-ai/DeepSeek-V3.1-Terminus' });
        assert.equal(requests.length, 2, 'refetched after an hour');
    } finally {
        clock.mock.restore();
    }
});

await testCase('a failed fetch answers not ok, and the list is not fetched again for 60 s', async () => {
    const realNow = performance.now();
    const clock = mock.method(performance, 'now', () => realNow);
    try {
        respond = () => new Response('down', { status: 503, statusText: 'Service Unavailable' });
        assert.deepEqual(await lookupOpenRouterHuggingFaceId('deepseek/deepseek-chat-v3.1'), { ok: false });
        respond = listReply();
        clock.mock.mockImplementation(() => realNow + 59_999);
        assert.deepEqual(await lookupOpenRouterHuggingFaceId('deepseek/deepseek-chat-v3.1'), { ok: false });
        assert.equal(requests.length, 1, 'one request within 60 s');

        clock.mock.mockImplementation(() => realNow + 60_000);
        assert.deepEqual(await lookupOpenRouterHuggingFaceId('deepseek/deepseek-chat-v3.1'), { ok: true, huggingFaceId: 'deepseek-ai/DeepSeek-V3.1' });
        assert.equal(requests.length, 2, 'fetched again after 60 s');
    } finally {
        clock.mock.restore();
    }
});

await testCase('a network error answers not ok', async () => {
    assert.deepEqual(await lookupOpenRouterHuggingFaceId('x', { fetchModels: async () => { throw new Error('ECONNREFUSED'); } }), { ok: false });
});

await testCase('an hour-old list whose refetch fails answers not ok', async () => {
    const realNow = performance.now();
    const clock = mock.method(performance, 'now', () => realNow);
    try {
        rememberOpenRouterModels(LISTED);
        clock.mock.mockImplementation(() => realNow + OPENROUTER_MODELS_MAX_AGE_MS);
        assert.deepEqual(await lookupOpenRouterHuggingFaceId('deepseek/deepseek-chat-v3.1', { fetchModels: async () => null }), { ok: false });
    } finally {
        clock.mock.restore();
    }
});

// The two /status routes refresh the list with the reply they already fetched.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-openrouter-models-'));
globalThis.DATA_ROOT = root;
const directories = { root };
const { writeSecret, SECRET_KEYS } = await import('./endpoints/secrets.js');
writeSecret(directories, SECRET_KEYS.OPENROUTER, 'sk-or-test');
const { router: chatCompletionsRouter } = await import('./endpoints/backends/chat-completions.js');
const { router: textCompletionsRouter } = await import('./endpoints/backends/text-completions.js');

/**
 * @param {import('express').Router} router
 * @param {object} body
 */
async function postStatus(router, body) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        // @ts-ignore
        req.user = { directories };
        next();
    });
    app.use('/', router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
        const reply = await fetch(`http://127.0.0.1:${port}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        assert.equal(reply.status, 200);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

await testCase('the chat-completion OpenRouter /status refreshes the list', async () => {
    await postStatus(chatCompletionsRouter, { chat_completion_source: 'openrouter' });
    assert.deepEqual(requests, [MODELS_URL]);
    assert.deepEqual(await lookupOpenRouterHuggingFaceId('deepseek/deepseek-chat-v3.1', { fetchModels: noFetch }), { ok: true, huggingFaceId: 'deepseek-ai/DeepSeek-V3.1' });
});

await testCase('the text-completion OpenRouter /status refreshes the list', async () => {
    await postStatus(textCompletionsRouter, { api_type: 'openrouter', api_server: 'https://openrouter.ai/api' });
    assert.deepEqual(requests, [MODELS_URL]);
    assert.deepEqual(await lookupOpenRouterHuggingFaceId('deepseek/deepseek-chat-v3.1', { fetchModels: noFetch }), { ok: true, huggingFaceId: 'deepseek-ai/DeepSeek-V3.1' });
});

fs.rmSync(root, { recursive: true, force: true });
console.log('openrouter-models.test.js: all passed');
