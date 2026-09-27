import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TEXTGEN_TYPES } from './constants.js';
// tokenizer-resolve.js statically imports src/endpoints/tokenizers.js, which pulls in code that
// reads process-wide config at MODULE IMPORT time (e.g. src/endpoints/secrets.js) - the config
// path must be set before that import chain runs, so (unlike src/token-bans-and-bias.test.js,
// which only needs to defer its *own* smoke-test import of endpoints/tokenizers.js)
// tokenizer-resolve.js itself has to be imported dynamically here, after setConfigFilePath().
import { setConfigFilePath } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', 'config.yaml'));

const {
    tokenizers,
    TOKENIZER_TYPE_KEYS,
    encodeWithTokenizerType,
    TokenizerFailure,
} = await import('./tokenizer-resolve.js');

// --- encodeWithTokenizerType: NONE -> [] ---

{
    const ids = await encodeWithTokenizerType(tokenizers.NONE, 'hello world');
    assert.deepEqual(ids, []);
}

// --- encodeWithTokenizerType: numeric-enum -> string-key mapping table sanity ---

assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.LLAMA], 'llama');
assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.MISTRAL], 'mistral');
assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.YI], 'yi');
assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.CLAUDE], 'claude');
assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.LLAMA3], 'llama3');
assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.GEMMA], 'gemma');
assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.JAMBA], 'jamba');
assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.QWEN2], 'qwen2');
assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.COMMAND_R], 'command-r');
assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.COMMAND_A], 'command-a');
assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.NEMO], 'nemo');
assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.DEEPSEEK], 'deepseek');
assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.GPT2], 'gpt2');
assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.NERD], 'nerdstash');
assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.NERD2], 'nerdstash_v2');

// --- encodeWithTokenizerType: branch dispatch, using injected stub encoders (no real network/tokenizer files) ---

{
    // Local ENCODE_TOKENIZERS-style dispatch: mapped key passed straight through to encodeLocal.
    const calls = [];
    const encodeLocal = async (key, text) => {
        calls.push([key, text]);
        return [1, 2, 3];
    };
    const ids = await encodeWithTokenizerType(tokenizers.MISTRAL, 'hi', { encodeLocal });
    assert.deepEqual(ids, [1, 2, 3]);
    assert.deepEqual(calls, [['mistral', 'hi']]);
}

{
    // OPENAI and GPT2 both go through the flat 'gpt2' local encoder (documented judgment call).
    const calls = [];
    const encodeLocal = async (key, text) => { calls.push(key); return [42]; };
    await encodeWithTokenizerType(tokenizers.OPENAI, 'hi', { encodeLocal });
    await encodeWithTokenizerType(tokenizers.GPT2, 'hi', { encodeLocal });
    assert.deepEqual(calls, ['gpt2', 'gpt2']);
}

{
    // NovelAI clio (NERD) and kayra (NERD2).
    const calls = [];
    const encodeLocal = async (key, text) => { calls.push([key, text]); return [5]; };
    assert.deepEqual(await encodeWithTokenizerType(tokenizers.NERD, 'hi', { encodeLocal }), [5]);
    assert.deepEqual(await encodeWithTokenizerType(tokenizers.NERD2, 'hi', { encodeLocal }), [5]);
    assert.deepEqual(calls, [['nerdstash', 'hi'], ['nerdstash_v2', 'hi']]);
}

{
    // API_TEXTGENERATIONWEBUI: remote succeeds -> its ids are used, local encoder not called.
    let localCalled = false;
    const encodeTextgenRemote = async () => ({ count: 2, ids: [7, 8] });
    const encodeLocal = async () => { localCalled = true; return []; };
    const ids = await encodeWithTokenizerType(tokenizers.API_TEXTGENERATIONWEBUI, 'hi', {
        textgenBaseUrl: 'http://localhost:5000',
        textgenModel: 'some-model',
        textgenApiType: TEXTGEN_TYPES.TABBY,
        encodeTextgenRemote,
        encodeLocal,
    });
    assert.deepEqual(ids, [7, 8]);
    assert.equal(localCalled, false);
}

{
    // API_TEXTGENERATIONWEBUI / API_CURRENT: a remote error or a reply without ids is a failure,
    // not a local encode.
    let localCalled = false;
    const encodeLocal = async () => { localCalled = true; return [9]; };
    for (const reply of [{ error: true }, {}, { count: 1 }]) {
        const encodeTextgenRemote = async () => reply;
        await assert.rejects(() => encodeWithTokenizerType(tokenizers.API_TEXTGENERATIONWEBUI, 'hi', { encodeTextgenRemote, encodeLocal }), TokenizerFailure);
        await assert.rejects(() => encodeWithTokenizerType(tokenizers.API_CURRENT, 'hi', { encodeTextgenRemote, encodeLocal }), TokenizerFailure);
    }
    assert.equal(localCalled, false, 'no local encode on a remote failure');
}

{
    // API_KOBOLD: fetch succeeds -> uses returned ids.
    const fetchImpl = async () => ({
        ok: true,
        json: async () => ({ value: 2, ids: [11, 12] }),
    });
    const ids = await encodeWithTokenizerType(tokenizers.API_KOBOLD, 'hi', {
        koboldBaseUrl: 'http://localhost:5001/',
        fetchImpl,
    });
    assert.deepEqual(ids, [11, 12]);
}

{
    // API_KOBOLD: a fetch failure, an HTTP error or a reply without ids is a failure, not a local encode.
    let localCalled = false;
    const encodeLocal = async () => { localCalled = true; return [99]; };
    const fetchImpls = [
        async () => { throw new Error('connection refused'); },
        async () => ({ ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({}) }),
        async () => ({ ok: true, json: async () => ({ value: 1 }) }),
    ];
    for (const fetchImpl of fetchImpls) {
        await assert.rejects(() => encodeWithTokenizerType(tokenizers.API_KOBOLD, 'hi', {
            koboldBaseUrl: 'http://localhost:5001',
            fetchImpl,
            encodeLocal,
        }), TokenizerFailure);
    }
    assert.equal(localCalled, false, 'no local encode on a remote failure');
}

{
    // Unsupported tokenizer type -> throws.
    await assert.rejects(() => encodeWithTokenizerType(tokenizers.BEST_MATCH, 'hi'));
}

console.log('tokenizer-resolve.test.js: encodeWithTokenizerType stub-dispatch assertions passed');

// --- encodeWithTokenizerType: real encodeTextByLocalTokenizerType smoke test ---
// Depends on real tokenizer model files (gpt2's tiktoken vocab), which may or may not be present
// in this checkout/CI environment. Skip gracefully rather than failing the whole file, same
// pattern as src/token-bans-and-bias.test.js's smoke test.
try {
    const ids = await encodeWithTokenizerType(tokenizers.GPT2, 'Hello world');
    assert.ok(Array.isArray(ids));
    assert.ok(ids.every(id => typeof id === 'number'));
    assert.ok(ids.length > 0);
    console.log('encodeWithTokenizerType smoke test: passed (real gpt2 tiktoken tokenizer loaded)');
} catch (err) {
    console.log(`encodeWithTokenizerType smoke test: skipped (${err.message})`);
}

// --- resolveTokenizer: one resolver, on the server ---

const http = await import('node:http');
const fs = await import('node:fs');
const os = await import('node:os');
const express = (await import('express')).default;

const {
    resolveTokenizer,
    countWithTokenizer,
    encodeWithTokenizer,
    estimateTokenCount,
    resolveProfileTokenizerSetting,
    createTokenizerOutcome,
    tokenizerOutcomeBasis,
    sendTokenizerWarnings,
} = await import('./tokenizer-resolve.js');
const { encodeTextByLocalTokenizerType } = await import('./endpoints/tokenizers.js');
const backendStatus = await import('./backend-status.js').catch(error => {
    console.log(`backend-status.js not importable: ${error.message}`);
    return {};
});

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenizer-resolve-test-'));
const directories = /** @type {any} */ ({ root: tmpRoot });

/**
 * A fake backend on an ephemeral port, recording every request path it gets.
 * @param {Record<string, (req: any, res: any) => void>} routes path -> handler; others answer 404.
 */
async function startFakeBackend(routes) {
    const paths = [];
    const server = http.createServer((req, res) => {
        paths.push(req.url);
        const handler = routes[req.url];
        if (handler) return handler(req, res);
        res.statusCode = 404;
        res.end('not found');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, paths, url: `http://127.0.0.1:${server.address().port}` };
}

const json = (body, headers = {}) => (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.end(JSON.stringify(body));
};

const failures = [];
async function check(name, fn) {
    try {
        backendStatus.clearRemoteTokenizationMemory?.();
        await fn();
        console.log(`  pass: ${name}`);
    } catch (error) {
        failures.push(name);
        console.log(`  FAIL: ${name}: ${error.message}`);
    }
}

const TEXTGEN = 'textgenerationwebui';

const gemmaLlamaCpp = await startFakeBackend({
    '/v1/models': json({ data: [{ id: 'gemma-2-9b-it.gguf' }] }),
});

await check('llamacpp, empty model, backend reports gemma-2, BEST_MATCH -> remote with gemma as local copy', async () => {
    const resolved = await resolveTokenizer({
        api: TEXTGEN, type: TEXTGEN_TYPES.LLAMACPP, url: gemmaLlamaCpp.url, model: '', tokenizerSetting: tokenizers.BEST_MATCH,
    }, { directories });
    assert.equal(resolved.kind, 'remote');
    assert.equal(resolved.id, tokenizers.API_TEXTGENERATIONWEBUI);
    assert.equal(resolved.basis, 'remote');
    assert.equal(resolved.localCopy?.id, tokenizers.GEMMA);
    assert.ok(gemmaLlamaCpp.paths.includes('/v1/models'), 'the model name was looked up from the backend');
});

await check('same backend without a remote tokenizer (generic) -> GEMMA', async () => {
    const resolved = await resolveTokenizer({
        api: TEXTGEN, type: TEXTGEN_TYPES.GENERIC, url: gemmaLlamaCpp.url, model: '', tokenizerSetting: tokenizers.BEST_MATCH,
    }, { directories });
    assert.equal(resolved.kind, 'local');
    assert.equal(resolved.id, tokenizers.GEMMA);
    assert.equal(resolved.basis, 'local');
});

await check('API_CURRENT on a backend without a remote tokenizer resolves like best match -> GEMMA', async () => {
    const resolved = await resolveTokenizer({
        api: TEXTGEN, type: TEXTGEN_TYPES.GENERIC, url: gemmaLlamaCpp.url, model: '', tokenizerSetting: tokenizers.API_CURRENT,
    }, { directories });
    assert.equal(resolved.id, tokenizers.GEMMA);
});

await check('OOBA without the encode endpoint (probed) -> GEMMA', async () => {
    const ooba = await startFakeBackend({
        '/v1/models': json({ data: [{ id: 'gemma-2-9b-it' }] }),
    });
    try {
        const resolved = await resolveTokenizer({
            api: TEXTGEN, type: TEXTGEN_TYPES.OOBA, url: ooba.url, model: '', tokenizerSetting: tokenizers.BEST_MATCH,
        }, { directories });
        assert.equal(resolved.kind, 'local');
        assert.equal(resolved.id, tokenizers.GEMMA);
        assert.ok(ooba.paths.includes('/v1/internal/model/info'), 'the encode endpoint was probed');
    } finally {
        ooba.server.close();
    }
});

await check('llamacpp-like backend with an unmapped model, no remote tokenizer -> estimate, basis unknown, never LLAMA', async () => {
    const unmapped = await startFakeBackend({
        '/v1/models': json({ data: [{ id: 'some-unheard-of-model-q4.gguf' }] }),
    });
    try {
        const resolved = await resolveTokenizer({
            api: TEXTGEN, type: TEXTGEN_TYPES.GENERIC, url: unmapped.url, model: '', tokenizerSetting: tokenizers.BEST_MATCH,
        }, { directories });
        assert.equal(resolved.kind, 'estimate');
        assert.equal(resolved.id, tokenizers.NONE);
        assert.equal(resolved.basis, 'unknown');
        assert.equal(resolved.localCopy, null);
        assert.notEqual(resolved.id, tokenizers.LLAMA);

        const remote = await resolveTokenizer({
            api: TEXTGEN, type: TEXTGEN_TYPES.LLAMACPP, url: unmapped.url, model: '', tokenizerSetting: tokenizers.BEST_MATCH,
        }, { directories });
        assert.equal(remote.kind, 'remote');
        assert.equal(remote.localCopy, null, 'an unmapped model has no local copy (never llama)');
    } finally {
        unmapped.server.close();
    }
});

await check('an unreachable backend with an empty model -> estimate, never LLAMA', async () => {
    const resolved = await resolveTokenizer({
        api: TEXTGEN, type: TEXTGEN_TYPES.GENERIC, url: 'http://127.0.0.1:1', model: '', tokenizerSetting: tokenizers.BEST_MATCH,
    }, { directories });
    assert.equal(resolved.kind, 'estimate');
    assert.equal(resolved.basis, 'unknown');
});

gemmaLlamaCpp.server.close();

await check('Mancer llama-2-13b-chat -> LLAMA', async () => {
    const resolved = await resolveTokenizer({
        api: TEXTGEN, type: TEXTGEN_TYPES.MANCER, url: 'https://neuro.mancer.tech', model: 'llama-2-13b-chat', tokenizerSetting: tokenizers.BEST_MATCH,
    }, { directories });
    assert.equal(resolved.kind, 'local');
    assert.equal(resolved.id, tokenizers.LLAMA);
    assert.equal(resolved.localCopy?.id, tokenizers.LLAMA);
});

await check('Horde: two models mapping to LLAMA3 -> LLAMA3; mixed -> estimate; none -> estimate', async () => {
    const both = await resolveTokenizer({
        api: 'koboldhorde', hordeModels: ['koboldcpp/Llama-3-8B-Instruct', 'aphrodite/Meta-Llama-3-70B'], tokenizerSetting: tokenizers.BEST_MATCH,
    });
    assert.equal(both.kind, 'local');
    assert.equal(both.id, tokenizers.LLAMA3);

    const mixed = await resolveTokenizer({
        api: 'koboldhorde', hordeModels: ['koboldcpp/Llama-3-8B-Instruct', 'koboldcpp/gemma-2-9b-it'], tokenizerSetting: tokenizers.BEST_MATCH,
    });
    assert.equal(mixed.kind, 'estimate');
    assert.equal(mixed.basis, 'unknown');

    const none = await resolveTokenizer({ api: 'koboldhorde', hordeModels: [], tokenizerSetting: tokenizers.BEST_MATCH });
    assert.equal(none.kind, 'estimate');
    assert.equal(none.basis, 'unknown');
});

await check('profile tokenizer "llama3" -> LLAMA3 whatever the main setting', async () => {
    for (const mainSetting of [tokenizers.BEST_MATCH, tokenizers.NONE, tokenizers.GEMMA, tokenizers.API_CURRENT]) {
        const setting = resolveProfileTokenizerSetting('llama3', mainSetting);
        assert.equal(setting, tokenizers.LLAMA3);
        const resolved = await resolveTokenizer({
            api: TEXTGEN, type: TEXTGEN_TYPES.MANCER, url: 'https://neuro.mancer.tech', model: 'llama-2-13b-chat', tokenizerSetting: setting,
        }, { directories });
        assert.equal(resolved.id, tokenizers.LLAMA3);
        assert.equal(resolved.kind, 'local');
    }
    assert.equal(resolveProfileTokenizerSetting(undefined, tokenizers.GEMMA), tokenizers.GEMMA);
    assert.equal(resolveProfileTokenizerSetting('', tokenizers.GEMMA), tokenizers.GEMMA);
    assert.equal(resolveProfileTokenizerSetting('not-a-tokenizer', tokenizers.GEMMA), tokenizers.GEMMA);
    assert.equal(resolveProfileTokenizerSetting('command_r', tokenizers.GEMMA), tokenizers.COMMAND_R);
    assert.equal(resolveProfileTokenizerSetting('best_match', tokenizers.GEMMA), tokenizers.BEST_MATCH);
});

await check('chat completion Mistral-Nemo-Instruct on NanoGPT -> NEMO, and the tokenizer setting is not applied', async () => {
    for (const tokenizerSetting of [tokenizers.BEST_MATCH, tokenizers.LLAMA, tokenizers.NONE]) {
        const resolved = await resolveTokenizer({
            api: 'openai', type: 'nanogpt', source: 'nanogpt', model: 'Mistral-Nemo-Instruct', tokenizerSetting,
        });
        assert.equal(resolved.kind, 'local');
        assert.equal(resolved.id, tokenizers.NEMO);
        assert.equal(resolved.model, 'nemo');
    }
    const gpt = await resolveTokenizer({ api: 'openai', type: 'openai', source: 'openai', model: 'GPT-4o' });
    assert.equal(gpt.id, tokenizers.OPENAI);
    assert.equal(gpt.model, 'gpt-4o');
    const unknown = await resolveTokenizer({ api: 'openai', type: 'claude', source: 'claude', model: 'claude-sonnet-4' });
    assert.equal(unknown.kind, 'estimate');
    assert.equal(unknown.basis, 'unknown');
});

await check('rule 1: explicit settings, including CLAUDE, NERD, NERD2 and OPENAI, win over the backend', async () => {
    const base = { api: TEXTGEN, type: TEXTGEN_TYPES.MANCER, url: 'https://neuro.mancer.tech', model: 'llama-2-13b-chat' };
    for (const id of [tokenizers.GPT2, tokenizers.QWEN2, tokenizers.CLAUDE, tokenizers.NERD, tokenizers.NERD2, tokenizers.OPENAI]) {
        const resolved = await resolveTokenizer({ ...base, tokenizerSetting: id }, { directories });
        assert.equal(resolved.kind, 'local', `setting ${id}`);
        assert.equal(resolved.id, id, `setting ${id}`);
        assert.equal(resolved.basis, 'local', `setting ${id}`);
    }
    const openai = await resolveTokenizer({ ...base, tokenizerSetting: tokenizers.OPENAI }, { directories });
    assert.equal(openai.model, 'gpt-3.5-turbo', 'upstream counts an explicit OpenAI setting with /openai/encode and no model');
    const none = await resolveTokenizer({ ...base, tokenizerSetting: tokenizers.NONE }, { directories });
    assert.equal(none.kind, 'estimate');
    assert.equal(none.basis, 'none');
    const remote = await startFakeBackend({});
    try {
        const resolved = await resolveTokenizer({
            api: TEXTGEN, type: TEXTGEN_TYPES.LLAMACPP, url: remote.url, model: '', tokenizerSetting: tokenizers.GEMMA,
        }, { directories });
        assert.equal(resolved.id, tokenizers.GEMMA);
        assert.deepEqual(remote.paths, []);
    } finally {
        remote.server.close();
    }
});

await check('NovelAI uses the NovelAI list: clio -> NERD, kayra -> NERD2, erato -> LLAMA3, other -> estimate', async () => {
    const at = model => resolveTokenizer({ api: 'novel', model, tokenizerSetting: tokenizers.BEST_MATCH });
    assert.equal((await at('clio-v1')).id, tokenizers.NERD);
    assert.equal((await at('kayra-v1')).id, tokenizers.NERD2);
    assert.equal((await at('llama-3-erato-v1')).id, tokenizers.LLAMA3);
    assert.equal((await at('some-new-model')).kind, 'estimate');
});

await check('best match on a backend without a remote tokenizer: the map on the model name, unmapped -> estimate', async () => {
    const cases = [
        ['Meta-Llama-3-8B-Instruct', tokenizers.LLAMA3],
        ['llama-3-70b', tokenizers.LLAMA3],
        ['Mixtral-8x7B', tokenizers.MISTRAL],
        ['gemma-2-9b-it', tokenizers.GEMMA],
        ['01-ai/Yi-34B', tokenizers.YI],
        ['jamba-1.5-mini', tokenizers.JAMBA],
        ['command-r-plus', tokenizers.COMMAND_R],
        ['command-a-03-2025', tokenizers.COMMAND_A],
        ['Qwen2-72B-Instruct', tokenizers.QWEN2],
        ['pixtral-12b', null],
        ['deepseek-coder-v2', null],
        ['some-totally-unknown-model', null],
    ];
    for (const [model, expected] of cases) {
        const resolved = await resolveTokenizer({ api: TEXTGEN, type: TEXTGEN_TYPES.GENERIC, model, tokenizerSetting: tokenizers.BEST_MATCH });
        if (expected === null) {
            assert.equal(resolved.kind, 'estimate', model);
            assert.equal(resolved.basis, 'unknown', model);
        } else {
            assert.equal(resolved.kind, 'local', model);
            assert.equal(resolved.id, expected, model);
        }
    }
});

await check('OpenRouter and DreamGen resolve through the map like any textgen model', async () => {
    const cases = [
        [TEXTGEN_TYPES.OPENROUTER, 'meta-llama/llama-3-70b', tokenizers.LLAMA3],
        [TEXTGEN_TYPES.OPENROUTER, 'ai21/jamba-1.5', tokenizers.JAMBA],
        [TEXTGEN_TYPES.OPENROUTER, 'cohere/command-r', tokenizers.COMMAND_R],
        [TEXTGEN_TYPES.OPENROUTER, 'anthropic/claude-3-opus', null],
        [TEXTGEN_TYPES.OPENROUTER, 'qwen/qwen-2-72b', null],
        [TEXTGEN_TYPES.OPENROUTER, 'some/unknown-tokenizer-model', null],
        [TEXTGEN_TYPES.DREAMGEN, 'lucid-v1-medium', null],
        [TEXTGEN_TYPES.DREAMGEN, 'lucid-v1-max', null],
    ];
    for (const [type, model, expected] of cases) {
        const resolved = await resolveTokenizer({ api: TEXTGEN, type, model, tokenizerSetting: tokenizers.BEST_MATCH });
        if (expected === null) {
            assert.equal(resolved.kind, 'estimate', model);
        } else {
            assert.equal(resolved.id, expected, model);
        }
    }
});

await check('API_CURRENT on a backend with a remote tokenizer -> remote, no local copy for an unmapped model', async () => {
    const resolved = await resolveTokenizer({
        api: TEXTGEN, type: TEXTGEN_TYPES.KOBOLDCPP, model: 'unknown-model', tokenizerSetting: tokenizers.API_CURRENT,
    });
    assert.equal(resolved.kind, 'remote');
    assert.equal(resolved.id, tokenizers.API_TEXTGENERATIONWEBUI);
    assert.equal(resolved.localCopy, null);
});

await check('an unrecognized api, or textgen with nothing set -> estimate', async () => {
    for (const state of [{ api: 'some_other_api' }, { api: TEXTGEN }]) {
        const resolved = await resolveTokenizer(state);
        assert.equal(resolved.kind, 'estimate', state.api);
        assert.equal(resolved.id, tokenizers.NONE, state.api);
    }
});

// --- remote capability memory ---

await check('textgen /status on OOBA remembers encode support; resolving then probes nothing', async () => {
    const { router } = await import('./endpoints/backends/text-completions.js');
    const ooba = await startFakeBackend({
        '/v1/models': json({ data: [{ id: 'gemma-2-9b-it' }] }),
        '/v1/internal/model/info': json({ model_name: 'gemma-2-9b-it' }),
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { directories }; next(); });
    app.use('/', router);
    const st = app.listen(0, '127.0.0.1');
    await new Promise(resolve => st.once('listening', resolve));
    try {
        const res = await fetch(`http://127.0.0.1:${st.address().port}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_server: ooba.url.replace('127.0.0.1', 'localhost') + '/v1', api_type: TEXTGEN_TYPES.OOBA }),
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('x-supports-tokenization'), 'true');
        const body = await res.json();
        assert.equal(body.result, 'gemma-2-9b-it');
        assert.deepEqual(body.data, [{ id: 'gemma-2-9b-it' }]);
        assert.equal(backendStatus.recallRemoteTokenization(TEXTGEN, TEXTGEN_TYPES.OOBA, ooba.url), true, 'remembered under the cleaned url');

        ooba.paths.length = 0;
        const resolved = await resolveTokenizer({
            api: TEXTGEN, type: TEXTGEN_TYPES.OOBA, url: ooba.url, model: 'gemma-2-9b-it', tokenizerSetting: tokenizers.BEST_MATCH,
        }, { directories });
        assert.equal(resolved.kind, 'remote');
        assert.deepEqual(ooba.paths, [], 'the remembered answer is used, no probe');
    } finally {
        st.close();
        ooba.server.close();
    }
});

await check('OOBA capability is probed once on first need, then remembered', async () => {
    const ooba = await startFakeBackend({
        '/v1/models': json({ data: [{ id: 'x' }] }),
        '/v1/internal/model/info': json({ model_name: 'gemma-2-9b-it' }),
    });
    try {
        const state = { api: TEXTGEN, type: TEXTGEN_TYPES.OOBA, url: ooba.url, model: 'gemma-2-9b-it', tokenizerSetting: tokenizers.BEST_MATCH };
        assert.equal(backendStatus.recallRemoteTokenization(TEXTGEN, TEXTGEN_TYPES.OOBA, ooba.url), undefined);
        const first = await resolveTokenizer(state, { directories });
        assert.equal(first.kind, 'remote');
        assert.equal(ooba.paths.filter(p => p === '/v1/internal/model/info').length, 1);
        const second = await resolveTokenizer(state, { directories });
        assert.equal(second.kind, 'remote');
        assert.equal(ooba.paths.filter(p => p === '/v1/internal/model/info').length, 1, 'no second probe');
    } finally {
        ooba.server.close();
    }
});

await check('OOBA that looks like LM Studio has no encode endpoint', async () => {
    const lmStudio = await startFakeBackend({
        '/v1/models': json({ data: [{ id: 'gemma-2-9b-it' }] }, { 'X-Powered-By': 'Express' }),
        '/v1/internal/model/info': json({ model_name: 'gemma-2-9b-it' }),
    });
    try {
        const resolved = await resolveTokenizer({
            api: TEXTGEN, type: TEXTGEN_TYPES.OOBA, url: lmStudio.url, model: '', tokenizerSetting: tokenizers.BEST_MATCH,
        }, { directories });
        assert.equal(resolved.kind, 'local');
        assert.equal(resolved.id, tokenizers.GEMMA);
        assert.equal(backendStatus.recallRemoteTokenization(TEXTGEN, TEXTGEN_TYPES.OOBA, lmStudio.url), false);
    } finally {
        lmStudio.server.close();
    }
});

await check('kobold /status remembers can_use_tokenization from the /extra/version result field (KoboldCpp quirk)', async () => {
    const { router } = await import('./endpoints/backends/kobold.js');
    const kcpp = await startFakeBackend({
        '/api/v1/info/version': json({ result: '1.2.5' }),
        '/api/extra/version': json({ result: 'KoboldCpp', version: '1.70' }),
        '/api/v1/model': json({ result: 'koboldcpp/gemma-2-9b-it' }),
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { directories }; next(); });
    app.use('/', router);
    const st = app.listen(0, '127.0.0.1');
    await new Promise(resolve => st.once('listening', resolve));
    try {
        const res = await fetch(`http://127.0.0.1:${st.address().port}/status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_server: `${kcpp.url}/api` }),
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(body, { koboldUnitedVersion: '1.2.5', koboldCppVersion: 'KoboldCpp', model: 'koboldcpp/gemma-2-9b-it' });
        // 'KoboldCpp' is not a version, but upstream's versionCompare puts letters after digits,
        // so any KoboldCpp passes the 1.41 gate.
        assert.equal(backendStatus.recallRemoteTokenization('kobold', undefined, `${kcpp.url}/api`), true);

        kcpp.paths.length = 0;
        const resolved = await resolveTokenizer({ api: 'kobold', url: `${kcpp.url}/api`, model: '', tokenizerSetting: tokenizers.BEST_MATCH }, { directories });
        assert.equal(resolved.kind, 'remote');
        assert.equal(resolved.id, tokenizers.API_KOBOLD);
        assert.equal(resolved.localCopy?.id, tokenizers.GEMMA);
        assert.ok(!kcpp.paths.includes('/api/extra/version'), 'no probe once /status filled it');
    } finally {
        st.close();
        kcpp.server.close();
    }
});

await check('kobold without /extra/version cannot tokenize (probed on first need) -> the map', async () => {
    const classic = await startFakeBackend({
        '/api/v1/model': json({ result: 'KoboldAI/llama-2-13b' }),
    });
    try {
        const state = { api: 'kobold', url: `${classic.url}/api`, model: '', tokenizerSetting: tokenizers.BEST_MATCH };
        const resolved = await resolveTokenizer(state, { directories });
        assert.equal(resolved.kind, 'local');
        assert.equal(resolved.id, tokenizers.LLAMA);
        assert.equal(backendStatus.recallRemoteTokenization('kobold', undefined, `${classic.url}/api`), false);
        const probes = classic.paths.filter(p => p === '/api/extra/version').length;
        assert.equal(probes, 1);
        await resolveTokenizer(state, { directories });
        assert.equal(classic.paths.filter(p => p === '/api/extra/version').length, 1, 'remembered, no second probe');
    } finally {
        classic.server.close();
    }
});

await check('kobold version gate matches the client versionCompare', async () => {
    assert.equal(backendStatus.koboldCanUseTokenization('KoboldCpp'), true);
    assert.equal(backendStatus.koboldCanUseTokenization('1.41'), true);
    assert.equal(backendStatus.koboldCanUseTokenization('1.40'), false);
    assert.equal(backendStatus.koboldCanUseTokenization('1.9'), false);
    assert.equal(backendStatus.koboldCanUseTokenization(undefined), false);
});

// --- model lookup ---

await check('model lookup: placeholder answers and failures mean unknown', async () => {
    const valid = await startFakeBackend({ '/v1/models': json({ data: [] }) });
    const tabbyNone = await startFakeBackend({ '/v1/model/list': json({ data: [{ id: 'a' }] }) });
    const tabbyLoaded = await startFakeBackend({
        '/v1/model/list': json({ data: [{ id: 'a' }] }),
        '/v1/model': json({ id: 'Qwen2-7B-exl2' }),
    });
    const readOnly = await startFakeBackend({ '/api/v1/model': json({ result: 'ReadOnly' }) });
    try {
        const lookup = backendStatus.lookupBackendModel;
        assert.equal(await lookup({ api: TEXTGEN, type: TEXTGEN_TYPES.GENERIC, url: valid.url, directories }), null, '\'Valid\'');
        assert.equal(await lookup({ api: TEXTGEN, type: TEXTGEN_TYPES.TABBY, url: tabbyNone.url, directories }), null, 'Tabby \'None\'');
        assert.equal(await lookup({ api: TEXTGEN, type: TEXTGEN_TYPES.TABBY, url: tabbyLoaded.url, directories }), 'Qwen2-7B-exl2');
        assert.equal(await lookup({ api: 'kobold', url: `${readOnly.url}/api`, directories }), null, '\'ReadOnly\'');
        assert.equal(await lookup({ api: 'kobold', url: 'http://127.0.0.1:1/api', directories }), null, 'failed kobold lookup');
        assert.equal(await lookup({ api: TEXTGEN, type: TEXTGEN_TYPES.GENERIC, url: 'http://127.0.0.1:1', directories }), null, 'failed textgen lookup');
        assert.equal(await lookup({ api: 'novel', url: '', directories }), null, 'no lookup for other apis');
    } finally {
        for (const b of [valid, tabbyNone, tabbyLoaded, readOnly]) b.server.close();
    }
});

await check('a non-empty model setting is used as is; the backend is not asked', async () => {
    const backend = await startFakeBackend({ '/v1/models': json({ data: [{ id: 'gemma-2-9b-it' }] }) });
    try {
        const resolved = await resolveTokenizer({
            api: TEXTGEN, type: TEXTGEN_TYPES.GENERIC, url: backend.url, model: 'Qwen2-72B-Instruct', tokenizerSetting: tokenizers.BEST_MATCH,
        }, { directories });
        assert.equal(resolved.id, tokenizers.QWEN2);
        assert.deepEqual(backend.paths, []);
    } finally {
        backend.server.close();
    }
});

// --- counting ---

await check('estimate is bytes / 3.35 rounded up; countWithTokenizer uses it for an estimate', async () => {
    assert.equal(estimateTokenCount('Hello world'), Math.ceil(11 / 3.35));
    assert.equal(estimateTokenCount('héllo'), Math.ceil(6 / 3.35));
    const estimate = await resolveTokenizer({ api: TEXTGEN, type: TEXTGEN_TYPES.MANCER, model: 'unknown', tokenizerSetting: tokenizers.NONE });
    assert.equal(await countWithTokenizer(estimate, 'Hello world'), Math.ceil(11 / 3.35));
});

await check('countWithTokenizer counts with the resolved tokenizer', async () => {
    const calls = [];
    const encodeLocal = async (key, text) => { calls.push(key); return [1, 2, 3, 4]; };
    const gemma = { kind: 'local', id: tokenizers.GEMMA, name: 'Gemma / Gemini', basis: 'local', localCopy: null };
    assert.equal(await countWithTokenizer(gemma, 'hi', { encodeLocal }), 4);
    assert.deepEqual(calls, ['gemma']);

    const remote = { kind: 'remote', id: tokenizers.API_TEXTGENERATIONWEBUI, name: 'API (Text Completion)', basis: 'remote', localCopy: null };
    const encodeTextgenRemote = async () => ({ count: 2, ids: [7, 8] });
    assert.equal(await countWithTokenizer(remote, 'hi', { encodeTextgenRemote }), 2);

    const openai = await resolveTokenizer({ api: 'openai', source: 'openai', model: 'gpt-4o' });
    assert.equal(await countWithTokenizer(openai, 'Hello world'), 2, 'tiktoken gpt-4o');
    assert.equal(await countWithTokenizer(openai, ''), 0);
});

// --- a failing tokenizer ---

const failingRemote = async () => ({ error: true });
const refusedFetch = async () => { throw new Error('connection refused'); };

await check('remote error with a gemma-2 model: gemma ids and a fallback-copy warning', async () => {
    const state = { api: TEXTGEN, type: TEXTGEN_TYPES.LLAMACPP, url: 'http://127.0.0.1:1', model: 'gemma-2-9b-it', tokenizerSetting: tokenizers.BEST_MATCH };
    const resolved = await resolveTokenizer(state, { directories });
    assert.equal(resolved.kind, 'remote');
    const outcome = createTokenizerOutcome();
    const localKeys = [];
    const encodeLocal = async (key, text) => { localKeys.push(key); return encodeTextByLocalTokenizerType(key, text); };

    const ids = await encodeWithTokenizer(resolved, 'Hello world', { encodeTextgenRemote: failingRemote, encodeLocal, outcome });
    assert.deepEqual(ids, await encodeTextByLocalTokenizerType('gemma', 'Hello world'));
    assert.equal(await countWithTokenizer(resolved, 'Hello world', { encodeTextgenRemote: failingRemote, encodeLocal, outcome }), ids.length);
    assert.deepEqual(localKeys, ['gemma', 'gemma']);
    assert.equal(tokenizerOutcomeBasis(resolved, outcome), 'fallback');

    const warnings = sendTokenizerWarnings(state, resolved, outcome, []);
    assert.deepEqual(warnings.map(w => w.kind), ['fallback-copy']);
    assert.ok(warnings[0].message.includes('Gemma'), warnings[0].message);
    assert.equal(warnings[0].key, `${TEXTGEN}|llamacpp|http://127.0.0.1:1|gemma-2-9b-it|api_textgenerationwebui`);
});

await check('remote error with an unmapped model: no ids, estimate counts, trim-estimate and dropped', async () => {
    const state = { api: TEXTGEN, type: TEXTGEN_TYPES.LLAMACPP, url: 'http://127.0.0.1:1', model: 'some-unheard-of-model', tokenizerSetting: tokenizers.BEST_MATCH };
    const resolved = await resolveTokenizer(state, { directories });
    assert.equal(resolved.localCopy, null);
    const outcome = createTokenizerOutcome();
    let localCalled = false;
    const encodeLocal = async () => { localCalled = true; return [1]; };

    assert.equal(await encodeWithTokenizer(resolved, 'hello', { encodeTextgenRemote: failingRemote, encodeLocal, outcome }), null);
    assert.equal(await countWithTokenizer(resolved, 'Hello world', { encodeTextgenRemote: failingRemote, encodeLocal, outcome }), estimateTokenCount('Hello world'));
    assert.equal(localCalled, false, 'no local encode');
    assert.equal(tokenizerOutcomeBasis(resolved, outcome), 'failed');

    const warnings = sendTokenizerWarnings(state, resolved, outcome, ['hello']);
    assert.deepEqual(warnings.map(w => w.kind), ['trim-estimate', 'dropped']);
    assert.deepEqual(warnings[1].entries, ['hello']);
    assert.ok(/tokenizer failed/.test(warnings[1].message), warnings[1].message);
});

await check('an unmapped model whose remote works: no warnings', async () => {
    const state = { api: TEXTGEN, type: TEXTGEN_TYPES.LLAMACPP, url: 'http://127.0.0.1:1', model: 'some-unheard-of-model', tokenizerSetting: tokenizers.BEST_MATCH };
    const resolved = await resolveTokenizer(state, { directories });
    const outcome = createTokenizerOutcome();
    const encodeTextgenRemote = async () => ({ count: 2, ids: [7, 8] });
    assert.deepEqual(await encodeWithTokenizer(resolved, 'hi', { encodeTextgenRemote, outcome }), [7, 8]);
    assert.equal(tokenizerOutcomeBasis(resolved, outcome), 'remote');
    assert.deepEqual(sendTokenizerWarnings(state, resolved, outcome, []), []);
});

await check('kobold fetch failure: the local copy, else no ids', async () => {
    const state = { api: 'kobold', url: 'http://127.0.0.1:1/api', model: '' };
    const withCopy = { kind: 'remote', id: tokenizers.API_KOBOLD, name: 'API (KoboldAI Classic)', basis: 'remote', localCopy: { id: tokenizers.GEMMA, name: 'Gemma / Gemini' } };
    const copyOutcome = createTokenizerOutcome();
    const encodeLocal = async (key) => { assert.equal(key, 'gemma'); return [3, 4]; };
    assert.deepEqual(await encodeWithTokenizer(withCopy, 'hi', { koboldBaseUrl: state.url, fetchImpl: refusedFetch, encodeLocal, outcome: copyOutcome }), [3, 4]);
    assert.deepEqual(sendTokenizerWarnings(state, withCopy, copyOutcome, []).map(w => w.kind), ['fallback-copy']);

    const withoutCopy = { ...withCopy, localCopy: null };
    const outcome = createTokenizerOutcome();
    assert.equal(await encodeWithTokenizer(withoutCopy, 'hi', { koboldBaseUrl: state.url, fetchImpl: refusedFetch, outcome }), null);
    const warnings = sendTokenizerWarnings(state, withoutCopy, outcome, ['hi']);
    assert.deepEqual(warnings.map(w => w.kind), ['dropped']);
    assert.equal(tokenizerOutcomeBasis(withoutCopy, outcome), 'failed');
});

await check('two failures then a success: every call tries the remote again', async () => {
    const resolved = { kind: 'remote', id: tokenizers.API_TEXTGENERATIONWEBUI, name: 'API (Text Completion)', basis: 'remote', localCopy: null };
    let remoteCalls = 0;
    const encodeTextgenRemote = async () => (++remoteCalls <= 2 ? { error: true } : { count: 1, ids: [5] });
    assert.equal(await encodeWithTokenizer(resolved, 'hi', { encodeTextgenRemote }), null);
    assert.equal(await encodeWithTokenizer(resolved, 'hi', { encodeTextgenRemote }), null);
    assert.equal(remoteCalls, 2, 'the second call tried the remote again');
    assert.deepEqual(await encodeWithTokenizer(resolved, 'hi', { encodeTextgenRemote }), [5]);
    assert.equal(remoteCalls, 3);
});

await check('a local tokenizer that fails to load: no ids, estimate counts, dropped', async () => {
    const state = { api: TEXTGEN, type: TEXTGEN_TYPES.GENERIC, url: '', model: 'Qwen2-7B', tokenizerSetting: tokenizers.BEST_MATCH };
    const resolved = { kind: 'local', id: tokenizers.QWEN2, name: 'Qwen2', basis: 'local', localCopy: { id: tokenizers.QWEN2, name: 'Qwen2' } };
    const outcome = createTokenizerOutcome();
    const encodeLocal = async () => { throw new Error('Failed to load the Web tokenizer for type: qwen2'); };
    assert.equal(await encodeWithTokenizer(resolved, 'hi', { encodeLocal, outcome }), null);
    assert.equal(await countWithTokenizer(resolved, 'Hello world', { encodeLocal, outcome }), estimateTokenCount('Hello world'));
    assert.equal(tokenizerOutcomeBasis(resolved, outcome), 'failed');
    const warnings = sendTokenizerWarnings(state, resolved, outcome, ['hi']);
    assert.deepEqual(warnings.map(w => w.kind), ['trim-estimate', 'dropped']);
    assert.ok(warnings[1].message.includes('Qwen2'), warnings[1].message);
});

// --- registry entries ---

const { lookupModelTokenizer } = await import('./tokenizer-model-map.js');
const { tokenizerAnswer, tokenizerResponseWarnings, ENCODE_TOKENIZERS } = await import('./tokenizer-resolve.js');

/** Test-only entries under production ids, so they have `tokenizers` values. */
const testRegistry = [
    { id: 'qwen3', family: 'Test Qwen', format: 'hf-json', sha256: 'a'.repeat(64), bytes: 1, license: 'Test License A', licenseUrl: 'https://example.invalid/a', sources: [] },
    { id: 'kimi', family: 'Test Kimi', format: 'tiktoken', sha256: 'b'.repeat(64), bytes: 1, license: 'Test License B', licenseUrl: 'https://example.invalid/b', sources: [] },
];
/** @type {string[]} */
const registryLoads = [];
let nextLoadDownloads = false;
/** A stub loader: qwen3 encodes to [1000, length], kimi to [2000, length]. */
const loadPinned = async (entry) => {
    registryLoads.push(entry.id);
    const downloaded = nextLoadDownloads;
    nextLoadDownloads = false;
    const first = entry.id === 'qwen3' ? 1000 : 2000;
    return {
        encode: async (text) => [first, text.length],
        decode: async (ids) => ids.join(','),
        downloaded,
    };
};
const testModels = {
    'test-qwen-model.gguf': { source: 'qwen3' },
    'test-kimi-model.gguf': { source: 'kimi' },
    'test-several-files': { byBackend: { vendorApis: { mistralai: { source: 'qwen3' } }, hf: { source: 'kimi' } } },
};
const lookupModel = (api, name) => testModels[name] ?? lookupModelTokenizer(api, name);
const registryDeps = { directories, registry: testRegistry, lookupModel };
const registryOptions = { registry: testRegistry, loadPinned };

await check('registry values join ENCODE_TOKENIZERS', async () => {
    for (const id of [tokenizers.QWEN3, tokenizers.LLAMA3_1, tokenizers.NEMO_TEKKEN, tokenizers.KIMI]) {
        assert.ok(Number.isInteger(id) && ENCODE_TOKENIZERS.includes(id), String(id));
    }
});

await check('llamacpp BEST_MATCH with a registry model -> remote, the entry as local copy', async () => {
    const state = { api: TEXTGEN, type: TEXTGEN_TYPES.LLAMACPP, url: 'http://127.0.0.1:1', model: 'test-qwen-model.gguf', tokenizerSetting: tokenizers.BEST_MATCH };
    const resolved = await resolveTokenizer(state, registryDeps);
    assert.equal(resolved.kind, 'remote');
    assert.deepEqual(resolved.localCopy, { id: tokenizers.QWEN3, source: 'qwen3', name: 'Test Qwen (official)' });
});

await check('llamacpp /tokenize failing with a registry model -> the entry\'s ids, basis fallback', async () => {
    const state = { api: TEXTGEN, type: TEXTGEN_TYPES.LLAMACPP, url: 'http://127.0.0.1:1', model: 'test-qwen-model.gguf', tokenizerSetting: tokenizers.BEST_MATCH };
    const resolved = await resolveTokenizer(state, registryDeps);
    const outcome = createTokenizerOutcome();
    registryLoads.length = 0;
    const ids = await encodeWithTokenizer(resolved, 'hello', { encodeTextgenRemote: failingRemote, ...registryOptions, outcome });
    assert.deepEqual(ids, [1000, 5]);
    assert.deepEqual(registryLoads, ['qwen3']);
    assert.equal(tokenizerOutcomeBasis(resolved, outcome), 'fallback');
    const answer = tokenizerAnswer(state, resolved, outcome);
    assert.deepEqual({ id: answer.id, name: answer.name, basis: answer.basis }, { id: tokenizers.QWEN3, name: 'Test Qwen (official)', basis: 'fallback' });
    const warnings = sendTokenizerWarnings(state, resolved, outcome, []);
    assert.deepEqual(warnings.map(w => w.kind), ['fallback-copy']);
    assert.ok(warnings[0].message.includes('Test Qwen (official)'), warnings[0].message);
});

await check('kobold without tokenization and a registry model -> local, with source', async () => {
    const classic = await startFakeBackend({});
    try {
        const state = { api: 'kobold', url: `${classic.url}/api`, model: 'test-kimi-model.gguf', tokenizerSetting: tokenizers.BEST_MATCH };
        const resolved = await resolveTokenizer(state, registryDeps);
        assert.deepEqual(
            { kind: resolved.kind, id: resolved.id, source: resolved.source, name: resolved.name, basis: resolved.basis },
            { kind: 'local', id: tokenizers.KIMI, source: 'kimi', name: 'Test Kimi (official)', basis: 'local' },
        );
        assert.equal(resolved.localCopy?.source, 'kimi');
        assert.equal(await countWithTokenizer(resolved, 'hi', registryOptions), 2);
        assert.deepEqual(await encodeWithTokenizer(resolved, 'hey', registryOptions), [2000, 3]);
    } finally {
        classic.server.close();
    }
});

await check('the key differs between two models on the same URL with an empty model setting that map to different entries', async () => {
    let reported = 'test-qwen-model.gguf';
    const llamacpp = await startFakeBackend({
        '/v1/models': (req, res) => json({ data: [{ id: reported }] })(req, res),
    });
    try {
        const state = { api: TEXTGEN, type: TEXTGEN_TYPES.LLAMACPP, url: llamacpp.url, model: '', tokenizerSetting: tokenizers.BEST_MATCH };
        const qwen = tokenizerAnswer(state, await resolveTokenizer(state, registryDeps), createTokenizerOutcome());
        reported = 'test-kimi-model.gguf';
        const kimi = tokenizerAnswer(state, await resolveTokenizer(state, registryDeps), createTokenizerOutcome());
        assert.notEqual(qwen.key, kimi.key);
        assert.equal(qwen.key, `${TEXTGEN}|llamacpp|${llamacpp.url}||qwen3`);
        assert.equal(kimi.key, `${TEXTGEN}|llamacpp|${llamacpp.url}||kimi`);
    } finally {
        llamacpp.server.close();
    }
});

await check('a local registry resolution\'s key ends with the entry id', async () => {
    const state = { api: TEXTGEN, type: TEXTGEN_TYPES.GENERIC, url: '', model: 'test-qwen-model.gguf', tokenizerSetting: tokenizers.BEST_MATCH };
    const answer = tokenizerAnswer(state, await resolveTokenizer(state, registryDeps), createTokenizerOutcome());
    assert.equal(answer.key, `${TEXTGEN}|generic||test-qwen-model.gguf|qwen3`);
});

await check('an explicit pick of a registry value is rule 1: that entry, whatever the backend', async () => {
    const state = { api: TEXTGEN, type: TEXTGEN_TYPES.LLAMACPP, url: 'http://127.0.0.1:1', model: 'gemma-2-9b-it', tokenizerSetting: tokenizers.QWEN3 };
    const resolved = await resolveTokenizer(state, registryDeps);
    assert.deepEqual(
        { kind: resolved.kind, id: resolved.id, source: resolved.source, name: resolved.name, localCopy: resolved.localCopy },
        { kind: 'local', id: tokenizers.QWEN3, source: 'qwen3', name: 'Test Qwen (official)', localCopy: null },
    );
    const production = await resolveTokenizer({ ...state, tokenizerSetting: tokenizers.LLAMA3_1 });
    assert.deepEqual({ id: production.id, source: production.source, name: production.name }, { id: tokenizers.LLAMA3_1, source: 'llama3.1', name: 'Llama 3.1 (official)' });
});

await check('Horde: two models mapping to one registry entry -> that entry', async () => {
    const resolved = await resolveTokenizer({
        api: 'koboldhorde', hordeModels: ['test-qwen-model.gguf', 'test-qwen-model.gguf'], tokenizerSetting: tokenizers.BEST_MATCH,
    }, registryDeps);
    assert.equal(resolved.kind, 'local');
    assert.equal(resolved.source, 'qwen3');
});

await check('the request that downloads an entry\'s file carries a license warning; later requests don\'t', async () => {
    const state = { api: TEXTGEN, type: TEXTGEN_TYPES.GENERIC, url: '', model: 'test-qwen-model.gguf', tokenizerSetting: tokenizers.BEST_MATCH };
    const resolved = await resolveTokenizer(state, registryDeps);

    nextLoadDownloads = true;
    const downloading = createTokenizerOutcome();
    await countWithTokenizer(resolved, 'hi', { ...registryOptions, outcome: downloading });
    const expected = {
        kind: 'license',
        key: `${TEXTGEN}|generic||test-qwen-model.gguf|qwen3`,
        message: 'Downloaded the Test Qwen tokenizer. License: Test License A',
    };
    assert.deepEqual(tokenizerResponseWarnings(state, resolved, downloading), [expected]);
    assert.deepEqual(sendTokenizerWarnings(state, resolved, downloading, []), [expected]);
    assert.equal(tokenizerOutcomeBasis(resolved, downloading), 'local');

    const later = createTokenizerOutcome();
    await countWithTokenizer(resolved, 'hi', { ...registryOptions, outcome: later });
    assert.deepEqual(tokenizerResponseWarnings(state, resolved, later), []);
});

await check('one model, several official files: the vendor\'s own API gets its file; other backends get none', async () => {
    const mistral = await resolveTokenizer({ api: 'openai', source: 'mistralai', model: 'test-several-files' }, registryDeps);
    assert.deepEqual({ kind: mistral.kind, source: mistral.source, localCopy: mistral.localCopy?.source }, { kind: 'local', source: 'qwen3', localCopy: 'qwen3' });

    const openrouter = await resolveTokenizer({ api: 'openai', source: 'openrouter', model: 'test-several-files' }, registryDeps);
    assert.deepEqual({ kind: openrouter.kind, basis: openrouter.basis }, { kind: 'estimate', basis: 'unknown' });

    // No backend is counted as HF-based serving by assumption, so the HF file is used by none.
    const generic = await resolveTokenizer({ api: TEXTGEN, type: TEXTGEN_TYPES.GENERIC, model: 'test-several-files', tokenizerSetting: tokenizers.BEST_MATCH }, registryDeps);
    assert.deepEqual({ kind: generic.kind, basis: generic.basis }, { kind: 'estimate', basis: 'unknown' });

    const llamacpp = await resolveTokenizer({ api: TEXTGEN, type: TEXTGEN_TYPES.LLAMACPP, url: 'http://127.0.0.1:1', model: 'test-several-files', tokenizerSetting: tokenizers.BEST_MATCH }, registryDeps);
    assert.deepEqual({ kind: llamacpp.kind, localCopy: llamacpp.localCopy }, { kind: 'remote', localCopy: null });
});

await check('the old resolvers and their llama defaults are no longer exported', async () => {
    const modules = {
        './tokenizer-resolve.js': ['getTokenizerBestMatch', 'resolveTokenizerType', 'getCurrentOpenRouterModelTokenizer', 'getCurrentDreamGenModelTokenizer'],
        './endpoints/tokenizers.js': ['resolveTextgenTokenizerForTokenIds', 'TEXTGEN_ENCODE_TOKENIZER_TYPES', 'TEXTGEN_API_TOKENIZER_TYPES'],
        './novel-generation-data.js': ['getTokenizerTypeForModel'],
    };
    for (const [specifier, names] of Object.entries(modules)) {
        const module = await import(specifier);
        for (const name of names) {
            assert.equal(name in module, false, `${specifier} still exports ${name}`);
        }
    }
});

fs.rmSync(tmpRoot, { recursive: true, force: true });

if (failures.length > 0) {
    console.log(`tokenizer-resolve.test.js: ${failures.length} resolveTokenizer case(s) failed`);
    process.exit(1);
}

console.log('tokenizer-resolve.test.js: all assertions passed');
