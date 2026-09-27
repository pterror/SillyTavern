import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock } from 'node:test';

// This module reads process-wide config at import time (e.g. src/endpoints/secrets.js) - the
// config path must be set before that import chain runs, same approach as
// src/tokenizer-resolve.test.js and src/novel-generation-data.test.js.
import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

// Tokenizer downloads fail with 503 without touching the network. Needs --experimental-test-module-mocks.
const canMockDownloads = typeof mock.module === 'function';
/** @type {string[]} URLs the download stub was asked for. */
const downloadRequests = [];
if (canMockDownloads) {
    const realNodeFetch = (await import(path.join(__dirname, '..', '..', 'node_modules', 'node-fetch', 'src', 'index.js'))).default;
    mock.module('node-fetch', {
        defaultExport: async (url, opts) => {
            if (String(url).startsWith('https://github.com/SillyTavern/SillyTavern-Tokenizers/')) {
                downloadRequests.push(String(url));
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
const { default: express } = await import('express');

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
app.use('/api/tokenizers', router);
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
    await testCase('qwen2 download failure: no llama3.json load, a throw, and a retry on the next use', async () => {
        const readPaths = [];
        const realReadFile = fs.promises.readFile;
        fs.promises.readFile = function (file, ...rest) {
            readPaths.push(String(file));
            return realReadFile.call(this, file, ...rest);
        };
        try {
            downloadRequests.length = 0;
            await assert.rejects(() => encodeTextByLocalTokenizerType('qwen2', text), /Failed to load the Web tokenizer for type: qwen2/);
            await assert.rejects(() => encodeTextByLocalTokenizerType('qwen2', text), /Failed to load the Web tokenizer for type: qwen2/);
        } finally {
            fs.promises.readFile = realReadFile;
        }
        assert.deepEqual(readPaths.filter(file => path.basename(file) === 'llama3.json'), [], 'no llama3.json load');
        assert.deepEqual(downloadRequests, [
            'https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/qwen2.json.gz',
            'https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/qwen2.json.gz',
        ], 'downloaded again on the next use');
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

server.close();
fs.rmSync(dataRoot, { recursive: true, force: true });

assert.deepEqual(caseFailures, [], 'tokenizer cases');

console.log('tokenizers.test.js: all tests passed');
