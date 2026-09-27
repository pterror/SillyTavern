import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { mock } from 'node:test';

// This module reads process-wide config at import time (e.g. src/endpoints/secrets.js) - the
// config path must be set before that import chain runs, same approach as
// src/tokenizer-resolve.test.js and src/novel-generation-data.test.js.
import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

// Tokenizer downloads fail with 503 without touching the network, except the URLs in
// `downloadBodies`, which answer that body. Needs --experimental-test-module-mocks.
const canMockDownloads = typeof mock.module === 'function';
/** @type {string[]} URLs the download stub was asked for. */
const downloadRequests = [];
/** @type {Map<string, Buffer>} */
const downloadBodies = new Map();
if (canMockDownloads) {
    const realNodeFetch = (await import(path.join(__dirname, '..', '..', 'node_modules', 'node-fetch', 'src', 'index.js'))).default;
    mock.module('node-fetch', {
        defaultExport: async (url, opts) => {
            if (String(url).startsWith('https://github.com/SillyTavern/SillyTavern-Tokenizers/')) {
                downloadRequests.push(String(url));
                const body = downloadBodies.get(String(url));
                if (body) {
                    return new Response(body, { status: 200 });
                }
                return new Response('unavailable', { status: 503, statusText: 'Service Unavailable' });
            }
            return realNodeFetch(url, opts);
        },
        namedExports: {},
    });
} else {
    console.log('tokenizers.test.js: node:test mock.module() is unavailable (run with --experimental-test-module-mocks) - skipping the download-failure case, which needs it to stub the tokenizer download');
}

const { computeLogitBias, computeTextgenLogitBias, router, encodeTextByLocalTokenizerType, getTiktokenTokenizer, guesstimate } = await import('./tokenizers.js');
const { resolveTokenizer, encodeWithTokenizer, tokenizers } = await import('../tokenizer-resolve.js');
const { router: currentRouter } = await import('./tokenizers-current.js');
const { default: express } = await import('express');
const { Tokenizer } = await import('@agnai/web-tokenizers');

// --- computeLogitBias ---

// A real bias-preset entry with plain text resolves to a real token-id-keyed bias object, using
// the actual tiktoken-family tokenizer (cheap/synchronous/offline - no model download needed).
{
    const result = await computeLogitBias([{ text: 'hello', value: -100 }], 'gpt-3.5-turbo');
    assert.deepEqual(Object.keys(result).length > 0, true);
    assert.deepEqual(Object.values(result), [-100]);
}

// Multiple entries merge into one map; entries missing `text` are skipped.
{
    const result = await computeLogitBias([
        { text: 'hello', value: -100 },
        { text: '', value: 5 },
        { value: 5 },
    ], 'gpt-3.5-turbo');
    assert.deepEqual(Object.values(result), [-100]);
}

// A raw JSON array of token ids as `text` is used as-is instead of being tokenized.
{
    const result = await computeLogitBias([{ text: '[1, 2, 3]', value: 10 }], 'gpt-3.5-turbo');
    assert.deepEqual(result, { 1: 10, 2: 10, 3: 10 });
}

// model === 'claude' returns an empty bias object (no bias support for Claude).
{
    const result = await computeLogitBias([{ text: 'hello', value: -100 }], 'claude-3-opus');
    assert.deepEqual(result, {});
}

// Non-array input returns an empty object rather than throwing.
{
    assert.deepEqual(await computeLogitBias(undefined, 'gpt-3.5-turbo'), {});
    assert.deepEqual(await computeLogitBias(null, 'gpt-3.5-turbo'), {});
}

// Empty entries array returns an empty object.
{
    assert.deepEqual(await computeLogitBias([], 'gpt-3.5-turbo'), {});
}

// --- computeTextgenLogitBias ---

const mistralResolved = await resolveTokenizer({ api: 'textgenerationwebui', type: 'ooba', model: 'x', tokenizerSetting: tokenizers.MISTRAL });
assert.equal(mistralResolved.id, tokenizers.MISTRAL);
const mistral = { encode: (text) => encodeWithTokenizer(mistralResolved, text) };

// A {...}-wrapped verbatim-text entry and a plain-text entry both resolve to real token-id-keyed
// bias entries via a real local tokenizer.
{
    const result = await computeTextgenLogitBias(
        [{ text: '{hello}', value: -50 }, { text: 'world', value: 25 }],
        mistral,
    );
    assert.equal(Object.keys(result).length > 0, true);
    assert.equal(Object.values(result).includes(-50), true);
    assert.equal(Object.values(result).includes(25), true);
}

// A [...]-wrapped raw JSON token-id entry passes through directly without going through the tokenizer.
{
    const result = await computeTextgenLogitBias(
        [{ text: '[7, 8, 9]', value: 3 }],
        mistral,
    );
    assert.deepEqual(result, { 7: 3, 8: 3, 9: 3 });
}

// Empty/absent logit_bias array -> {}, no computation attempted (no tokenizerOptions needed at all).
{
    assert.deepEqual(await computeTextgenLogitBias([]), {});
    assert.deepEqual(await computeTextgenLogitBias(undefined), {});
    assert.deepEqual(await computeTextgenLogitBias(null), {});
}

// Entries without text, or with only whitespace, are skipped.
{
    const result = await computeTextgenLogitBias(
        [{ value: 1 }, { text: '', value: 2 }, { text: '   ', value: 3 }, { text: 'hi', value: -1 }],
        mistral,
    );
    assert.equal(Object.keys(result).length > 0, true);
    assert.equal(Object.values(result).every(v => v === -1), true);
}

// A failing remote tokenizer with no local copy leaves the entry out and lists it.
{
    const remote = await resolveTokenizer({ api: 'textgenerationwebui', type: 'vllm', model: 'x' });
    assert.equal(remote.kind, 'remote');
    assert.equal(remote.localCopy, null);
    const encode = (text) => encodeWithTokenizer(remote, text, { encodeTextgenRemote: async () => ({ error: true }) });
    const dropped = [];
    const result = await computeTextgenLogitBias([{ text: 'hello', value: -1 }, { text: '[4]', value: 2 }], { encode }, dropped);
    assert.deepEqual(result, { 4: 2 });
    assert.deepEqual(dropped, ['hello']);
}

// A non-empty preset with no resolution throws rather than picking a tokenizer.
{
    await assert.rejects(() => computeTextgenLogitBias([{ text: 'hello', value: -1 }]), /tokenizerOptions\.encode is required/);
    await assert.rejects(() => computeTextgenLogitBias([{ text: 'hello', value: -1 }], { settingsType: 'ooba', powerUserTokenizer: 'mistral' }), /tokenizerOptions\.encode is required/);
}

const caseFailures = [];
async function testCase(name, fn) {
    try {
        await fn();
        console.log(`  pass: ${name}`);
    } catch (error) {
        caseFailures.push(name);
        console.log(`  FAIL: ${name}: ${error.message}`);
    }
}

// --- computeLogitBias on a model no tokenizer is known for ---

await testCase('computeLogitBias, unmapped model: entries needing ids dropped and listed, raw ids kept', async () => {
    const dropped = [];
    const result = await computeLogitBias([
        { text: 'hello', value: -5 },
        { text: '[11, 12]', value: 2 },
        { text: '{world}', value: 3 },
    ], 'some-unheard-of-model', dropped);
    assert.deepEqual(result, { 11: 2, 12: 2 });
    assert.deepEqual(dropped, ['hello', '{world}']);
});

await testCase('computeLogitBias, claude: no bias, nothing listed as dropped', async () => {
    const dropped = [];
    const result = await computeLogitBias([{ text: 'hello', value: -5 }, { text: '[11]', value: 2 }], 'anthropic/claude-3-opus', dropped);
    assert.deepEqual(result, {});
    assert.deepEqual(dropped, []);
});

// --- /openai/encode, /openai/decode, /openai/count ---

// Nemo and DeepSeek are downloaded tokenizers. The cache gets stand-in files so no download
// happens; they are claude.json, whose ids differ from llama3 and tiktoken.
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tokenizers-test-'));
globalThis.DATA_ROOT = dataRoot;
fs.mkdirSync(path.join(dataRoot, '_cache'));
for (const name of ['nemo.json', 'deepseek.json']) {
    fs.copyFileSync(path.join(__dirname, '..', 'tokenizers', 'claude.json'), path.join(dataRoot, '_cache', name));
}

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
    req.user = /** @type {any} */ ({ directories: { root: dataRoot } });
    next();
});
app.use('/api/tokenizers', router);
app.use('/api/tokenizers', currentRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const baseUrl = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/api/tokenizers`;
async function postTokenizer(route, model, body) {
    const response = await fetch(`${baseUrl}${route}?model=${encodeURIComponent(model)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
}

const text = 'Antidisestablishmentarianism, naïveté and 東京.';
const messages = [{ role: 'user', content: text }];

// --- a sentencepiece file that fails to load ---

// Runs before anything loads llama: a loaded tokenizer stays loaded, and a failed load is tried again.
await testCase('/current/count: a corrupt llama.model is a failed tokenizer, not 0 tokens', async () => {
    const modelPath = 'src/tokenizers/llama.model';
    const corruptPath = path.join(dataRoot, 'llama.model');
    fs.writeFileSync(corruptPath, fs.readFileSync(modelPath).subarray(0, 1024));
    const realReadFileSync = fs.readFileSync;
    fs.readFileSync = function (file, ...rest) {
        return realReadFileSync.call(this, String(file) === modelPath ? corruptPath : file, ...rest);
    };
    try {
        const response = await fetch(`${baseUrl}/current/count`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: { api: 'textgenerationwebui', type: 'generic', url: 'http://127.0.0.1:1', model: 'x', tokenizerSetting: tokenizers.LLAMA }, texts: [text] }),
        });
        assert.equal(response.status, 200);
        const counted = await response.json();
        assert.deepEqual(counted.counts, [guesstimate(text)]);
        assert.deepEqual({ id: counted.tokenizer.id, basis: counted.tokenizer.basis }, { id: tokenizers.LLAMA, basis: 'failed' });
    } finally {
        fs.readFileSync = realReadFileSync;
    }
});

await testCase('encodeTextByLocalTokenizerType: \'\' still encodes to []', async () => {
    assert.deepEqual(await encodeTextByLocalTokenizerType('llama', ''), []);
});

await testCase('/openai/*: a mixed-case Mistral-Nemo name goes to nemo', async () => {
    const nemoIds = await encodeTextByLocalTokenizerType('nemo', text);
    assert.notDeepEqual(nemoIds, await encodeTextByLocalTokenizerType('llama3', text), 'the stand-in tells nemo from llama3');
    assert.notDeepEqual(nemoIds, Array.from(getTiktokenTokenizer('gpt-3.5-turbo').encode(text)), 'the stand-in tells nemo from gpt-3.5-turbo');

    const encoded = await postTokenizer('/openai/encode', 'Mistral-Nemo-Instruct-2407', { text });
    assert.deepEqual(encoded.ids, nemoIds, 'encode');
    assert.equal(encoded.count, nemoIds.length);

    const decoded = await postTokenizer('/openai/decode', 'Mistral-Nemo-Instruct-2407', { ids: nemoIds });
    assert.equal(decoded.text, text, 'decode');

    const counted = await postTokenizer('/openai/count', 'Mistral-Nemo-Instruct-2407', messages);
    assert.deepEqual(counted, { token_count: (await encodeTextByLocalTokenizerType('nemo', `user\n\n${text}`)).length }, 'count');
});

await testCase('/openai/*: an unmapped name gets the estimate, ids: [] and { text: \'\' }', async () => {
    const encoded = await postTokenizer('/openai/encode', 'some-unheard-of-model', { text });
    assert.deepEqual(encoded, { ids: [], count: guesstimate(text), chunks: [] }, 'encode');

    const decoded = await postTokenizer('/openai/decode', 'some-unheard-of-model', { ids: [1, 2, 3] });
    assert.deepEqual(decoded, { text: '' }, 'decode');

    const counted = await postTokenizer('/openai/count', 'some-unheard-of-model', messages);
    assert.deepEqual(counted, { token_count: guesstimate(JSON.stringify(messages)) }, 'count');
});

// A tokenizer name upstream accepts in ?model= is an explicit pick of that tokenizer, even where
// the model map would leave the name unmapped.
for (const name of ['claude', 'mistral', 'llama', 'deepseek', 'jamba']) {
    await testCase(`/openai/*: the tokenizer name '${name}' picks that tokenizer`, async () => {
        const ids = await encodeTextByLocalTokenizerType(name, text);
        assert.ok(ids.length > 0);

        const encoded = await postTokenizer('/openai/encode', name, { text });
        assert.deepEqual(encoded.ids, ids, 'encode');
        assert.equal(encoded.count, ids.length);

        const decoded = await postTokenizer('/openai/decode', name, { ids });
        assert.notEqual(decoded.text, '', 'decode');

        const counted = await postTokenizer('/openai/count', name, messages);
        assert.deepEqual(counted, { token_count: (await encodeTextByLocalTokenizerType(name, `user\n\n${text}`)).length }, 'count');
    });
}

// --- downloadable tokenizers ---

if (canMockDownloads) {
    await testCase('qwen2 download failure: no llama3.json load, a throw, and no new request for 60 s', async () => {
        const readPaths = [];
        const realReadFile = fs.promises.readFile;
        fs.promises.readFile = function (file, ...rest) {
            readPaths.push(String(file));
            return realReadFile.call(this, file, ...rest);
        };
        const qwen2Url = 'https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/qwen2.json.gz';
        const realNow = performance.now();
        const clock = mock.method(performance, 'now', () => realNow);
        try {
            downloadRequests.length = 0;
            await assert.rejects(() => encodeTextByLocalTokenizerType('qwen2', text), /Failed to load the Web tokenizer for type: qwen2/);
            clock.mock.mockImplementation(() => realNow + 59_999);
            await assert.rejects(() => encodeTextByLocalTokenizerType('qwen2', text), /Failed to load the Web tokenizer for type: qwen2/);
            assert.deepEqual(downloadRequests, [qwen2Url], 'one request within 60 s');

            clock.mock.mockImplementation(() => realNow + 60_000);
            await assert.rejects(() => encodeTextByLocalTokenizerType('qwen2', text), /Failed to load the Web tokenizer for type: qwen2/);
            assert.deepEqual(downloadRequests, [qwen2Url, qwen2Url], 'downloaded again after 60 s');
        } finally {
            clock.mock.restore();
            fs.promises.readFile = realReadFile;
        }
        assert.deepEqual(readPaths.filter(file => path.basename(file) === 'llama3.json'), [], 'no llama3.json load');
    });

    await testCase('/command-r/encode: a failed download answers the estimate, not 0 tokens', async () => {
        downloadRequests.length = 0;
        const response = await fetch(`${baseUrl}/command-r/encode`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ids: [], count: guesstimate(text), chunks: [] });
        assert.deepEqual(downloadRequests, ['https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/command-r.json.gz'], 'the download was tried');
    });

    // command-a's download answers claude.json, so the load succeeds.
    await testCase('command-a, four parallel encodes on a cold cache: one request and one fromJSON', async () => {
        const commandAUrl = 'https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/command-a.json.gz';
        downloadBodies.set(commandAUrl, zlib.gzipSync(fs.readFileSync(path.join(__dirname, '..', 'tokenizers', 'claude.json'))));
        const fromJSON = mock.method(Tokenizer, 'fromJSON');
        try {
            downloadRequests.length = 0;
            const results = await Promise.all([1, 2, 3, 4].map(() => encodeTextByLocalTokenizerType('command-a', text)));
            assert.ok(results[0].length > 0);
            for (const ids of results) {
                assert.deepEqual(ids, results[0]);
            }
            assert.deepEqual(downloadRequests, [commandAUrl], 'one request');
            assert.equal(fromJSON.mock.callCount(), 1, 'one fromJSON');
        } finally {
            fromJSON.mock.restore();
            downloadBodies.delete(commandAUrl);
        }
    });
}

// --- /remote/textgenerationwebui/encode ---

// An api_type with no remote tokenize endpoint answers HTTP 400, as upstream does.
await testCase('/remote/textgenerationwebui/encode: an unknown api_type answers 400', async () => {
    for (const apiType of ['some-unknown-type', undefined]) {
        const response = await fetch(`${baseUrl}/remote/textgenerationwebui/encode`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, url: 'http://127.0.0.1:1', model: 'x', api_type: apiType }),
        });
        assert.equal(response.status, 400, String(apiType));
    }
});

// --- /current/* ---

// A fake llama.cpp: `/tokenize` fails, or answers one token per character.
let fakeTokenizeMode = 'fail';
let fakeTokenizeCalls = 0;
const fakeLlamaCpp = express();
fakeLlamaCpp.use(express.json());
fakeLlamaCpp.post('/tokenize', (req, res) => {
    fakeTokenizeCalls++;
    if (fakeTokenizeMode === 'fail') return res.sendStatus(500);
    return res.send({ tokens: Array.from(String(req.body.content), (_, i) => i) });
});
const fakeServer = fakeLlamaCpp.listen(0, '127.0.0.1');
await new Promise(resolve => fakeServer.once('listening', resolve));
const fakeUrl = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (fakeServer.address()).port}`;

async function postCurrent(route, body) {
    const response = await fetch(`${baseUrl}/current/${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, route);
    return response.json();
}

const llama3State = { api: 'textgenerationwebui', type: 'generic', url: 'http://127.0.0.1:1', model: 'x', tokenizerSetting: tokenizers.LLAMA3 };
const unmappedState = { api: 'textgenerationwebui', type: 'generic', url: 'http://127.0.0.1:1', model: 'some-unheard-of-model', tokenizerSetting: tokenizers.BEST_MATCH };
const remoteGemmaState = { api: 'textgenerationwebui', type: 'llamacpp', url: fakeUrl, model: 'gemma-2-9b-it', tokenizerSetting: tokenizers.BEST_MATCH };
const remoteUnmappedState = { ...remoteGemmaState, model: 'some-unheard-of-model' };

await testCase('/current/*: each route names the tokenizer it used', async () => {
    const llama3Ids = await encodeTextByLocalTokenizerType('llama3', text);
    const expected = { id: tokenizers.LLAMA3, name: 'Llama 3', basis: 'local' };
    const check = (answer, route) => {
        assert.deepEqual({ id: answer.id, name: answer.name, basis: answer.basis }, expected, route);
        assert.equal(typeof answer.key, 'string', route);
    };

    const counted = await postCurrent('count', { state: llama3State, texts: ['', text], padding: 2 });
    assert.deepEqual(counted.counts, [0, llama3Ids.length + 2], 'count');
    assert.equal(counted.warnings, undefined);
    check(counted.tokenizer, 'count');

    const encoded = await postCurrent('encode', { state: llama3State, texts: [text] });
    assert.deepEqual(encoded.ids, [llama3Ids], 'encode');
    assert.equal(encoded.chunks[0].join(''), text, 'encode chunks');
    check(encoded.tokenizer, 'encode');

    const decoded = await postCurrent('decode', { state: llama3State, ids: llama3Ids });
    assert.equal(decoded.text, text, 'decode');
    check(decoded.tokenizer, 'decode');

    const trimmed = await postCurrent('trim', { state: llama3State, text, limit: 3, direction: 'start' });
    check(trimmed.tokenizer, 'trim');

    const answered = await postCurrent('tokenizer', { state: llama3State });
    check(answered.tokenizer, 'tokenizer');
    assert.deepEqual(Object.keys(answered), ['tokenizer']);
});

await testCase('/current/count: chat-completion messages count like /openai/count, naming the model\'s tokenizer', async () => {
    const counted = await postCurrent('count', { state: { api: 'openai', source: 'openai', model: 'gpt-4o' }, messages });
    const upstream = await postTokenizer('/openai/count', 'gpt-4o', messages);
    assert.equal(counted.count, upstream.token_count);
    const { id, name, model, basis, key } = counted.tokenizer;
    assert.deepEqual({ id, name, model, basis, key }, { id: tokenizers.OPENAI, name: 'gpt-4o', model: 'gpt-4o', basis: 'local', key: 'openai|openai||gpt-4o|openai' });
});

await testCase('/current/*: the answer carries the server-built `dropped` wording for the browser to fill in', async () => {
    const unmapped = (await postCurrent('tokenizer', { state: unmappedState })).tokenizer;
    assert.deepEqual(unmapped.messages, {
        dropped: {
            one: 'Left out {count} entry that need token ids, because no tokenizer is known for this model: {entries}',
            many: 'Left out {count} entries that need token ids, because no tokenizer is known for this model: {entries}',
        },
        trimEstimate: 'The None / Estimated tokenizer failed, so the prompt was fitted to the context by an estimated token count.',
        unknownModel: 'No tokenizer is known for this model, so token counts are estimates. A tokenizer can be picked in Advanced Formatting → Tokenizer.',
    });

    const none = (await postCurrent('encode', { state: { ...unmappedState, tokenizerSetting: tokenizers.NONE }, texts: [text] })).tokenizer;
    assert.equal(none.messages.dropped.many, 'Left out {count} entries that need token ids, because the tokenizer is set to None: {entries}');

    const local = (await postCurrent('count', { state: llama3State, texts: [text] })).tokenizer;
    assert.equal(local.messages.dropped.one, 'Left out {count} entry that need token ids, because the Llama 3 tokenizer failed: {entries}');
});

await testCase('/current/*: the answer carries the server-built `trim-estimate` and unknown-model wording, the same as a send\'s', async () => {
    const { sendTokenizerWarnings, createTokenizerOutcome } = await import('../tokenizer-resolve.js');
    const unknownModel = 'No tokenizer is known for this model, so token counts are estimates. A tokenizer can be picked in Advanced Formatting → Tokenizer.';
    for (const state of [llama3State, remoteGemmaState]) {
        const answer = (await postCurrent('tokenizer', { state })).tokenizer;
        const resolved = await resolveTokenizer(state, {});
        const outcome = { ...createTokenizerOutcome(), countEstimated: true };
        const sendWarning = sendTokenizerWarnings(state, resolved, outcome, []).find(w => w.kind === 'trim-estimate');
        assert.equal(answer.messages.trimEstimate, sendWarning.message, `trimEstimate for ${state.type}`);
        assert.equal(answer.messages.unknownModel, unknownModel, `unknownModel for ${state.type}`);
    }
    const remote = (await postCurrent('tokenizer', { state: remoteGemmaState })).tokenizer;
    assert.equal(remote.messages.trimEstimate, 'The backend\'s tokenizer failed, so the prompt was fitted to the context by an estimated token count.');
});

await testCase('/current/*: a failing llama.cpp /tokenize with a gemma-2 model counts with gemma, basis fallback', async () => {
    fakeTokenizeMode = 'fail';
    fakeTokenizeCalls = 0;
    const gemmaIds = await encodeTextByLocalTokenizerType('gemma', text);

    const counted = await postCurrent('count', { state: remoteGemmaState, texts: [text] });
    assert.deepEqual(counted.counts, [gemmaIds.length]);
    assert.equal(counted.tokenizer.basis, 'fallback');
    assert.equal(counted.tokenizer.id, tokenizers.GEMMA);
    assert.deepEqual(counted.warnings.map(w => w.kind), ['fallback-copy']);
    assert.equal(counted.warnings[0].key, counted.tokenizer.key);

    const encoded = await postCurrent('encode', { state: remoteGemmaState, texts: [text] });
    assert.deepEqual(encoded.ids, [gemmaIds]);
    assert.equal(encoded.tokenizer.basis, 'fallback');
    assert.equal(fakeTokenizeCalls, 2, 'the remote is tried on every request');
});

await testCase('/current/*: an unmapped model gets estimate counts, basis unknown', async () => {
    const counted = await postCurrent('count', { state: unmappedState, texts: [text] });
    assert.deepEqual(counted.counts, [guesstimate(text)]);
    assert.deepEqual({ id: counted.tokenizer.id, basis: counted.tokenizer.basis }, { id: tokenizers.NONE, basis: 'unknown' });
    assert.equal(counted.warnings, undefined);

    const encoded = await postCurrent('encode', { state: unmappedState, texts: [text] });
    assert.deepEqual(encoded.ids, [null]);

    const decoded = await postCurrent('decode', { state: unmappedState, ids: [1, 2] });
    assert.equal(decoded.text, '');

    // Upstream /trimtokens' character-proportion fallback.
    const limit = 5;
    const trimIndex = Math.floor(text.length * (limit / guesstimate(text)));
    const trimmedEnd = await postCurrent('trim', { state: unmappedState, text, limit, direction: 'end' });
    assert.equal(trimmedEnd.text, text.substring(0, text.length - trimIndex));
    const trimmedStart = await postCurrent('trim', { state: unmappedState, text, limit, direction: 'start' });
    assert.equal(trimmedStart.text, text.substring(trimIndex));
    assert.equal(trimmedStart.tokenizer.basis, 'unknown');
});

await testCase('/current/trim: the same text as encode-slice-decode for a local tokenizer', async () => {
    const ids = await encodeTextByLocalTokenizerType('llama3', text);
    const limit = 4;
    for (const [direction, slice] of [['start', ids.slice(0, limit)], ['end', ids.slice(-limit)]]) {
        const { text: expected } = await postCurrent('decode', { state: llama3State, ids: slice });
        const trimmed = await postCurrent('trim', { state: llama3State, text, limit, direction });
        assert.equal(trimmed.text, expected, direction);
    }
    assert.equal((await postCurrent('trim', { state: llama3State, text, limit: ids.length })).text, text, 'within the limit');
    assert.equal((await postCurrent('trim', { state: llama3State, text, limit: 0 })).text, '', 'limit 0');
    assert.equal((await postCurrent('trim', { state: llama3State, text, limit: 'x' })).text, text, 'no limit');
});

// The reference ids from python tokenizers 0.23.2 for a string where llama3.json's `ignore_merges`
// matters (tests/fixtures/tokenizer-reference, sample 15). @agnai/web-tokenizers gives 40 ids.
const ignoreMergesText = 'Ở Việt Nam, việc này có nhiều điều hợp lý; jeho každý характер değişti.';
const ignoreMergesIds = [5080, 252, 101798, 31074, 11, 100769, 97635, 29876, 100937, 101309, 100827, 101226, 26, 101503, 112357, 105670, 409, 44907, 7370, 10462, 13];

await testCase('llama3.json: /llama3/*, /openai/* and /current/* give the reference ids where ignore_merges matters', async () => {
    const legacy = await postTokenizer('/llama3/encode', '', { text: ignoreMergesText });
    assert.deepEqual({ ids: legacy.ids, count: legacy.count }, { ids: ignoreMergesIds, count: ignoreMergesIds.length }, '/llama3/encode');
    assert.equal(legacy.chunks.join(''), ignoreMergesText, '/llama3/encode chunks');
    assert.equal((await postTokenizer('/llama3/decode', '', { ids: ignoreMergesIds })).text, ignoreMergesText, '/llama3/decode');

    assert.deepEqual((await postTokenizer('/openai/encode', 'llama3', { text: ignoreMergesText })).ids, ignoreMergesIds, '/openai/encode');

    const current = await postCurrent('encode', { state: llama3State, texts: [ignoreMergesText] });
    assert.deepEqual(current.ids, [ignoreMergesIds], '/current/encode');
    const counted = await postCurrent('count', { state: llama3State, texts: [ignoreMergesText] });
    assert.deepEqual(counted.counts, [ignoreMergesIds.length], '/current/count');
});

await testCase('llama3.json: chat-completion message counts give the reference count where ignore_merges matters', async () => {
    // A message's values are joined with '\n\n', so a message with one value counts that value alone.
    const llama3Messages = [{ content: ignoreMergesText }];

    const state = { api: 'openai', source: 'openrouter', model: 'meta-llama/llama-3-70b-instruct' };
    const current = await postCurrent('count', { state, messages: llama3Messages });
    assert.deepEqual({ id: current.tokenizer.id, basis: current.tokenizer.basis }, { id: tokenizers.LLAMA3, basis: 'local' }, 'the model maps to llama3');

    const openai = await postTokenizer('/openai/count', 'llama3', llama3Messages);
    assert.deepEqual(
        { openaiCount: openai.token_count, currentCount: current.count },
        { openaiCount: ignoreMergesIds.length, currentCount: ignoreMergesIds.length },
    );
});

await testCase('/current/*: a working remote tokenizer with an exact local copy decodes and trims with the copy', async () => {
    fakeTokenizeMode = 'ok';
    const gemmaIds = await encodeTextByLocalTokenizerType('gemma', text);
    const remoteAnswer = { id: tokenizers.API_TEXTGENERATIONWEBUI, basis: 'remote' };

    const counted = await postCurrent('count', { state: remoteGemmaState, texts: [text] });
    assert.deepEqual(counted.counts, [text.length], 'counted by the remote');
    assert.deepEqual({ id: counted.tokenizer.id, basis: counted.tokenizer.basis }, remoteAnswer);

    const decoded = await postCurrent('decode', { state: remoteGemmaState, ids: gemmaIds });
    assert.equal(decoded.text, text);
    assert.deepEqual({ id: decoded.tokenizer.id, basis: decoded.tokenizer.basis }, remoteAnswer);

    const limit = 4;
    const { text: expected } = await postCurrent('decode', { state: { ...llama3State, tokenizerSetting: tokenizers.GEMMA }, ids: gemmaIds.slice(-limit) });
    const trimmed = await postCurrent('trim', { state: remoteGemmaState, text, limit, direction: 'end' });
    assert.equal(trimmed.text, expected);
    assert.deepEqual({ id: trimmed.tokenizer.id, basis: trimmed.tokenizer.basis }, remoteAnswer);
});

await testCase('/current/*: a working remote tokenizer with no local copy decodes to \'\' and trims by proportion of its count', async () => {
    fakeTokenizeMode = 'ok';
    const decoded = await postCurrent('decode', { state: remoteUnmappedState, ids: [1, 2, 3] });
    assert.equal(decoded.text, '');
    assert.deepEqual(decoded.chunks, []);

    const limit = 5;
    const trimIndex = Math.floor(text.length * (limit / text.length));
    const trimmed = await postCurrent('trim', { state: remoteUnmappedState, text, limit, direction: 'end' });
    assert.equal(trimmed.text, text.substring(0, text.length - trimIndex));
    assert.equal(trimmed.tokenizer.basis, 'remote');

    const answered = await postCurrent('tokenizer', { state: remoteUnmappedState });
    assert.deepEqual({ id: answered.tokenizer.id, basis: answered.tokenizer.basis }, { id: tokenizers.API_TEXTGENERATIONWEBUI, basis: 'remote' });
});

await testCase('/current/*: a request without state answers 400', async () => {
    for (const route of ['count', 'encode', 'decode', 'trim', 'tokenizer']) {
        const response = await fetch(`${baseUrl}/current/${route}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texts: [text] }),
        });
        assert.equal(response.status, 400, route);
    }
});

fakeServer.close();
server.close();
fs.rmSync(dataRoot, { recursive: true, force: true });

assert.deepEqual(caseFailures, [], 'tokenizer cases');

console.log('tokenizers.test.js: all tests passed');
