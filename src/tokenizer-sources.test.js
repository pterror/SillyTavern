import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock } from 'node:test';

import { setConfigFilePath } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', 'config.yaml'));

if (typeof mock.module !== 'function') {
    throw new Error('tokenizer-sources.test.js needs --experimental-test-module-mocks to stub node-fetch');
}

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tokenizer-sources-'));
globalThis.DATA_ROOT = dataRoot;
const cacheDir = path.join(dataRoot, '_cache');
const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tokenizer-sources-user-'));

/** @type {{ url: string, authorization: string | undefined }[]} */
const requests = [];
/** @type {Map<string, () => Response>} URL -> response. Anything else answers 404. */
const responses = new Map();
mock.module('node-fetch', {
    defaultExport: async (url, opts) => {
        requests.push({ url: String(url), authorization: opts?.headers?.Authorization });
        const respond = responses.get(String(url));
        return respond ? respond() : new Response('not found', { status: 404, statusText: 'Not Found' });
    },
    namedExports: {},
});

const { TOKENIZER_SOURCES, getPinnedTokenizerFile, getSourceUrl, getTokenizerDisplayName, getTokenizerConfigHash, getTokenizerIdentity } = await import('./tokenizer-sources.js');
const { writeSecret, SECRET_KEYS } = await import('./endpoints/secrets.js');

/**
 * @param {string} name
 * @param {() => Promise<void> | void} fn
 */
async function testCase(name, fn) {
    requests.length = 0;
    responses.clear();
    infoLines.length = 0;
    try {
        await fn();
        console.log(`ok - ${name}`);
    } catch (error) {
        console.log(`not ok - ${name}`);
        throw error;
    }
}

/** @param {Buffer} body */
const sha256Of = body => crypto.createHash('sha256').update(body).digest('hex');

let revisionCounter = 0;
/**
 * A test-only entry for `body`, one source per repo name or URL.
 * @param {Buffer} body
 * @param {({ repo: string, gated?: boolean, path?: string } | { url: string })[]} sources
 * @param {object} [extra]
 */
function makeEntry(body, sources, extra = {}) {
    return {
        id: `test-${sha256Of(body).slice(0, 8)}`,
        family: 'Test family',
        format: 'hf-json',
        sha256: sha256Of(body),
        bytes: body.length,
        license: 'Test License 1.0',
        licenseUrl: 'https://example.invalid/license',
        sources: sources.map(source => 'url' in source ? { url: source.url } : {
            repo: source.repo,
            revision: String(++revisionCounter).padStart(40, '0'),
            path: source.path ?? 'tokenizer.json',
            gated: source.gated ?? false,
        }),
        ...extra,
    };
}

/** @param {Buffer} body */
const ok = body => () => new Response(body, { status: 200 });

/** console.info lines printed by the module since the last testCase. */
const infoLines = [];
mock.method(console, 'info', (...args) => { infoLines.push(args.join(' ')); });

const cacheFiles = () => fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).sort() : [];

await testCase('a good body is written under its sha256 name, and a second call reads it without fetching', async () => {
    const body = Buffer.from('{"good":1}');
    const entry = makeEntry(body, [{ repo: 'owner/model' }]);
    const url = getSourceUrl(entry.sources[0]);
    assert.equal(url, `https://huggingface.co/owner/model/resolve/${entry.sources[0].revision}/tokenizer.json`);
    responses.set(url, ok(body));

    const first = await getPinnedTokenizerFile(entry);
    assert.deepEqual(first, { path: path.join(cacheDir, `${entry.sha256}.json`), downloaded: true, license: 'Test License 1.0' });
    assert.deepEqual(fs.readFileSync(first.path), body);
    assert.ok(infoLines.some(line => line.includes('Test family') && line.includes('Test License 1.0')), 'a console line names the family and license');

    const second = await getPinnedTokenizerFile(entry);
    assert.deepEqual(second, { path: first.path, downloaded: false, license: 'Test License 1.0' });
    assert.equal(requests.length, 1, 'one request');
    assert.equal(infoLines.filter(line => line.includes('License')).length, 1, 'the license line is printed on the download only');
});

await testCase('the cache extension comes from the format, not the source path', async () => {
    const expected = { 'hf-json': '.json', 'tekken': '.json', 'sentencepiece': '.model', 'tiktoken': '.tiktoken' };
    for (const [format, extension] of Object.entries(expected)) {
        const body = Buffer.from(`format ${format}`);
        const entry = makeEntry(body, [{ repo: 'owner/formats', path: 'sub/tokenizer.bin' }], { format });
        responses.set(getSourceUrl(entry.sources[0]), ok(body));
        const { path: file } = await getPinnedTokenizerFile(entry);
        assert.equal(path.basename(file), `${entry.sha256}${extension}`, format);
    }
});

await testCase('a body with a wrong hash is rejected, nothing is written, and the 60 s backoff applies', async () => {
    const body = Buffer.from('{"official":1}');
    const entry = makeEntry(body, [{ repo: 'owner/hash' }]);
    const url = getSourceUrl(entry.sources[0]);
    responses.set(url, ok(Buffer.from('{"officiaX":1}')));
    const before = cacheFiles();

    const realNow = performance.now();
    const clock = mock.method(performance, 'now', () => realNow);
    try {
        await assert.rejects(() => getPinnedTokenizerFile(entry), /Expected sha256/);
        assert.deepEqual(cacheFiles(), before, 'nothing written');

        clock.mock.mockImplementation(() => realNow + 59_999);
        await assert.rejects(() => getPinnedTokenizerFile(entry), /less than 60 s ago/);
        assert.equal(requests.length, 1, 'no new request within 60 s');

        clock.mock.mockImplementation(() => realNow + 60_000);
        responses.set(url, ok(body));
        const result = await getPinnedTokenizerFile(entry);
        assert.equal(requests.length, 2, 'downloaded again after 60 s');
        assert.deepEqual(fs.readFileSync(result.path), body);
    } finally {
        clock.mock.restore();
    }
});

await testCase('a body over bytes is rejected', async () => {
    const body = Buffer.from('{"size":1}');
    const entry = makeEntry(body, [{ repo: 'owner/size' }]);
    responses.set(getSourceUrl(entry.sources[0]), ok(Buffer.concat([body, Buffer.from('extra')])));
    const before = cacheFiles();
    await assert.rejects(() => getPinnedTokenizerFile(entry), /larger than the expected/);
    assert.deepEqual(cacheFiles(), before, 'nothing written');
});

await testCase('two entries whose paths are both tokenizer.json are cached apart', async () => {
    const bodyA = Buffer.from('{"a":1}');
    const bodyB = Buffer.from('{"b":2}');
    const entryA = makeEntry(bodyA, [{ repo: 'owner/a' }]);
    const entryB = makeEntry(bodyB, [{ repo: 'owner/b' }]);
    responses.set(getSourceUrl(entryA.sources[0]), ok(bodyA));
    responses.set(getSourceUrl(entryB.sources[0]), ok(bodyB));
    const a = await getPinnedTokenizerFile(entryA);
    const b = await getPinnedTokenizerFile(entryB);
    assert.notEqual(a.path, b.path);
    assert.deepEqual(fs.readFileSync(a.path), bodyA);
    assert.deepEqual(fs.readFileSync(b.path), bodyB);
});

await testCase('sources are tried in order: a failing official repo falls through to the verified copy', async () => {
    const body = Buffer.from('{"order":1}');
    const entry = makeEntry(body, [{ repo: 'owner/official' }, { repo: 'mirror/copy' }]);
    responses.set(getSourceUrl(entry.sources[1]), ok(body));
    const result = await getPinnedTokenizerFile(entry);
    assert.deepEqual(requests.map(r => r.url), entry.sources.map(getSourceUrl));
    assert.equal(result.downloaded, true);
    assert.deepEqual(fs.readFileSync(result.path), body);
});

await testCase('a gated official repo is skipped without a saved Hugging Face token; copies get no auth header', async () => {
    const body = Buffer.from('{"gated":0}');
    const entry = makeEntry(body, [{ repo: 'owner/gated', gated: true }, { repo: 'mirror/open' }]);
    responses.set(getSourceUrl(entry.sources[0]), ok(body));
    responses.set(getSourceUrl(entry.sources[1]), ok(body));
    await getPinnedTokenizerFile(entry);
    assert.deepEqual(requests, [{ url: getSourceUrl(entry.sources[1]), authorization: undefined }]);
});

await testCase('with a saved Hugging Face token, the gated official repo is tried first with the auth header, and only it', async () => {
    const directories = /** @type {any} */ ({ root: userRoot, backups: path.join(userRoot, 'backups') });
    writeSecret(directories, SECRET_KEYS.HUGGINGFACE, 'hf_test_token');

    const body = Buffer.from('{"gated":1}');
    const entry = makeEntry(body, [{ repo: 'owner/gated2', gated: true }, { repo: 'mirror/open2' }]);
    await assert.rejects(() => getPinnedTokenizerFile(entry, directories), /Could not download/);
    assert.deepEqual(requests, [
        { url: getSourceUrl(entry.sources[0]), authorization: 'Bearer hf_test_token' },
        { url: getSourceUrl(entry.sources[1]), authorization: undefined },
    ]);
});

await testCase('a source on another host is fetched at its own URL with no auth header, and pinned by the entry\'s sha256 and bytes', async () => {
    const directories = /** @type {any} */ ({ root: userRoot, backups: path.join(userRoot, 'backups') });
    writeSecret(directories, SECRET_KEYS.HUGGINGFACE, 'hf_test_token');

    const body = Buffer.from('{"host":1}');
    const url = 'https://files.example.invalid/tokenizers/model.json';
    const entry = makeEntry(body, [{ url }]);
    assert.equal(getSourceUrl(entry.sources[0]), url);
    responses.set(url, ok(body));

    const result = await getPinnedTokenizerFile(entry, directories);
    assert.deepEqual(result, { path: path.join(cacheDir, `${entry.sha256}.json`), downloaded: true, license: 'Test License 1.0' });
    assert.deepEqual(fs.readFileSync(result.path), body);
    assert.deepEqual(requests, [{ url, authorization: undefined }]);
});

await testCase('a changed file at a URL is a failed download of that source: the next source is tried, and the URL waits out the 60 s backoff', async () => {
    const body = Buffer.from('{"host":2}');
    const url = 'https://files.example.invalid/tokenizers/changed.json';
    const entry = makeEntry(body, [{ url }, { repo: 'mirror/host-copy' }]);
    const copyUrl = getSourceUrl(entry.sources[1]);
    responses.set(url, ok(Buffer.from('{"host":3}')));
    responses.set(copyUrl, ok(body));

    const realNow = performance.now();
    const clock = mock.method(performance, 'now', () => realNow);
    try {
        const first = await getPinnedTokenizerFile(entry);
        assert.deepEqual(requests.map(r => r.url), [url, copyUrl], 'the URL failed its sha256, the copy served the file');
        assert.deepEqual(fs.readFileSync(first.path), body);

        fs.rmSync(first.path);
        requests.length = 0;
        clock.mock.mockImplementation(() => realNow + 59_999);
        await getPinnedTokenizerFile(entry);
        assert.deepEqual(requests.map(r => r.url), [copyUrl], 'the URL is not tried again within 60 s');

        fs.rmSync(first.path);
        requests.length = 0;
        responses.set(url, ok(body));
        clock.mock.mockImplementation(() => realNow + 60_000);
        await getPinnedTokenizerFile(entry);
        assert.deepEqual(requests.map(r => r.url), [url], 'after 60 s the URL is tried first again');
    } finally {
        clock.mock.restore();
    }
});

await testCase('parallel calls on a cold cache share one download; only the call that fetched reports downloaded', async () => {
    const body = Buffer.from('{"parallel":1}');
    const entry = makeEntry(body, [{ repo: 'owner/parallel' }]);
    responses.set(getSourceUrl(entry.sources[0]), ok(body));
    const results = await Promise.all([1, 2, 3, 4].map(() => getPinnedTokenizerFile(entry)));
    assert.equal(requests.length, 1, 'one request');
    assert.deepEqual(results.map(r => r.downloaded), [true, false, false, false]);
    assert.equal(new Set(results.map(r => r.path)).size, 1);
});

await testCase('the license is that of the source the file came from: the console line, the result and the request\'s download notice name it', async () => {
    const { loadRegistryTokenizer } = await import('./tokenizer-loader.js');
    // A tekken file where every byte is its own token, after 10 special tokens.
    const body = Buffer.from(JSON.stringify({
        config: { pattern: String.raw`\S+|\s+`, default_vocab_size: 266, default_num_special_tokens: 10 },
        vocab: Array.from({ length: 256 }, (_, rank) => ({ rank, token_bytes: Buffer.from([rank]).toString('base64') })),
    }));
    const entry = makeEntry(body, [{ repo: 'owner/first' }, { repo: 'owner/second' }], { format: 'tekken' });
    entry.sources[1] = { ...entry.sources[1], license: 'Second License', licenseUrl: 'https://example.invalid/second' };
    responses.set(getSourceUrl(entry.sources[1]), ok(body));

    /** @type {{ downloads?: Array<{ family: string, license: string }> }} */
    const outcome = {};
    const { encode } = await loadRegistryTokenizer(entry.id, { registry: [entry], outcome });
    assert.deepEqual(requests.map(r => r.url), entry.sources.map(getSourceUrl), 'the first source failed, the second served the file');
    assert.deepEqual(await encode('ab'), [107, 108]);
    assert.deepEqual(outcome.downloads, [{ family: 'Test family', license: 'Second License' }]);
    assert.ok(infoLines.some(line => line.includes('Test family') && line.includes('License: Second License')), 'the console line');
    assert.ok(!infoLines.some(line => line.includes('Test License 1.0')), 'not the entry\'s license');

    const cached = await getPinnedTokenizerFile(entry);
    assert.equal(cached.downloaded, false);
});

await testCase('two entries sharing one file are told apart by their tokenizer configs', () => {
    const body = Buffer.from('shared tiktoken file');
    const config = { patStr: String.raw`\S+|\s+`, specialTokens: { '[BOS]': 0 }, reservedSpecialTokens: { start: 0, count: 1, name: '<|reserved_token_{id}|>' }, allowedSpecial: 'all', split: { maxChars: 400000, maxRun: 25000 } };
    const withKeysReordered = { split: config.split, allowedSpecial: 'all', reservedSpecialTokens: config.reservedSpecialTokens, specialTokens: config.specialTokens, patStr: config.patStr };
    const plain = makeEntry(body, [{ repo: 'owner/plain' }]);
    const all = makeEntry(body, [{ repo: 'owner/all' }], { format: 'tiktoken', tiktoken: config });
    const reordered = makeEntry(body, [{ repo: 'owner/reordered' }], { format: 'tiktoken', tiktoken: withKeysReordered });
    const none = makeEntry(body, [{ repo: 'owner/none' }], { format: 'tiktoken', tiktoken: { ...config, allowedSpecial: 'none' } });

    assert.equal(getTokenizerConfigHash(plain), null);
    assert.equal(getTokenizerIdentity(plain), plain.sha256, 'a file with no config is its sha256');
    assert.match(getTokenizerIdentity(all), new RegExp(`^${all.sha256}\\.[0-9a-f]{64}$`));
    assert.equal(getTokenizerIdentity(reordered), getTokenizerIdentity(all), 'key order doesn\'t matter');
    assert.notEqual(getTokenizerIdentity(none), getTokenizerIdentity(all), 'the special-token mode does');
});

await testCase('every registry entry is pinned', () => {
    const ids = new Set();
    const identities = new Set();
    for (const entry of TOKENIZER_SOURCES) {
        assert.ok(!ids.has(entry.id), `${entry.id}: unique id`);
        ids.add(entry.id);
        assert.ok(!identities.has(getTokenizerIdentity(entry)), `${entry.id}: no other entry has its file and tokenizer config`);
        identities.add(getTokenizerIdentity(entry));
        if (entry.tiktoken) {
            assert.ok(['all', 'none'].includes(entry.tiktoken.allowedSpecial), `${entry.id}: allowedSpecial`);
        }
        assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${entry.id}: sha256`);
        assert.ok(Number.isInteger(entry.bytes) && entry.bytes > 0, `${entry.id}: bytes`);
        assert.ok(['hf-json', 'sentencepiece', 'tekken', 'tiktoken'].includes(entry.format), `${entry.id}: format`);
        assert.ok(entry.license && entry.licenseUrl, `${entry.id}: license`);
        assert.ok(entry.sources.length > 0, `${entry.id}: sources`);
        entry.sources.forEach((source, index) => {
            assert.equal(Boolean(source.license), Boolean(source.licenseUrl), `${entry.id}: ${source.repo ?? source.url}'s license and its URL come together`);
            if ('url' in source) {
                // A file on another host has no revision: the entry's sha256 and bytes pin it.
                assert.match(source.url, /^https:\/\/[^/]+\/./, `${entry.id}: url`);
                assert.deepEqual(Object.keys(source).filter(key => !['url', 'license', 'licenseUrl'].includes(key)), [], `${entry.id}: a URL source has no repo, revision, path or gated`);
                return;
            }
            assert.match(source.revision, /^[0-9a-f]{40}$/, `${entry.id}: revision`);
            assert.ok(source.repo && source.path, `${entry.id}: repo and path`);
            // A gated repo is the model's own, listed first, or an official repo after the ungated
            // official repos that ship the same bytes.
            const owner = source.repo.split('/')[0];
            const isAfterOfficialRepos = entry.sources.slice(0, index).every(earlier => !earlier.gated && earlier.repo?.split('/')[0] === owner);
            assert.ok(index === 0 || !source.gated || isAfterOfficialRepos, `${entry.id}: ${source.repo} is gated`);
        });
    }
    assert.ok(Object.isFrozen(TOKENIZER_SOURCES));
});

await testCase('a registry entry is named `<family> (official)`; a model\'s HF tokenizer.json, where its native file differs, `<family> (official, HF tokenizer.json)`', () => {
    const byId = id => /** @type {any} */ (TOKENIZER_SOURCES.find(entry => entry.id === id));
    assert.equal(getTokenizerDisplayName(byId('mistral-large-2411')), 'Mistral Large 2411 (official)');
    assert.equal(getTokenizerDisplayName(byId('mistral-large-2411-hf')), 'Mistral Large 2411 (official, HF tokenizer.json)');
    assert.equal(getTokenizerDisplayName(byId('qwen3')), 'Qwen3 (official)');
    assert.equal(getTokenizerDisplayName(byId('aya-vision-32b')), 'Aya Vision 32B (official)');
    assert.equal(getTokenizerDisplayName(byId('aya-vision-32b-hf')), 'Aya Vision 32B (official, HF tokenizer.json)');
});

await testCase('a file only Cohere publishes is pinned to the URL Cohere\'s API names for it, and its license says none is stated', () => {
    const entry = /** @type {any} */ (TOKENIZER_SOURCES.find(source => source.id === 'aya-vision-32b'));
    const url = 'https://storage.googleapis.com/cohere-public/tokenizers/c4ai-aya-vision-32b.json';
    assert.deepEqual(entry.sources, [{ url }]);
    assert.deepEqual({ license: entry.license, licenseUrl: entry.licenseUrl }, { license: 'Not stated (Cohere public tokenizer file)', licenseUrl: url });
});

await testCase('every registry entry has its fixed `tokenizers` value, on the server, in the browser and in Advanced Formatting', async () => {
    const { tokenizers, TOKENIZER_TYPE_KEYS } = await import('./tokenizer-ids.js');
    // Fixed forever once shipped: never renumbered, reused or removed.
    const expected = { QWEN3: 1000, LLAMA3_1: 1001, NEMO_TEKKEN: 1002, KIMI: 1003, QWEN2_VL: 1004, QWEN2_5: 1005, QWEN3_5: 1006, QWEN3_5_BASE: 1007, QWEN3_8: 1008, CODEQWEN1_5: 1009, DEEPSEEK_V2: 1010, DEEPSEEK_V2_5: 1011, DEEPSEEK_R1: 1012, DEEPSEEK_V3_1: 1013, DEEPSEEK_V3_2: 1014, DEEPSEEK_V4: 1015, DEEPSEEK_V4_1: 1016, DEEPSEEK_R1_DISTILL_QWEN: 1017, DEEPSEEK_R1_DISTILL_LLAMA: 1018, DEEPSEEK_R1_0528_QWEN3: 1019, GEMMA_4: 1020, GEMMA_4_ASSISTANT: 1021, GEMMA_3_IT: 1022, GEMMA_3_PT: 1023, GEMMA_3N: 1024, CODEGEMMA: 1025, GEMMA_2_JPN: 1026, LLAMA3_1_BASE: 1027, LLAMA3_3: 1028, LLAMA4: 1029, LLAMA_GUARD_3_8B: 1030, LLAMA_GUARD_3_11B_VISION: 1031, LLAMA_GUARD_2: 1032, LLAMA_GUARD_4: 1033, MISTRAL_7B_V0_3: 1034, MATHSTRAL: 1035, MISTRAL_LARGE_2411: 1036, MISTRAL_7B_V0_3_HF: 1037, CODESTRAL_22B_HF: 1038, CODESTRAL_MAMBA_HF: 1039, MATHSTRAL_HF: 1040, MISTRAL_LARGE_2411_HF: 1041, MINISTRAL_8B_2410_HF: 1042, MINISTRAL_3_INSTRUCT_HF: 1043, MINISTRAL_3_BASE_HF: 1044, MISTRAL_SMALL_4_HF: 1045, SHIELDSTRAL_HF: 1046, MISTRAL_SMALL_3_HF: 1047, COMMAND_A_VISION: 1048, COMMAND_A_PLUS: 1049, AYA_VISION_32B: 1050, TINY_AYA: 1051, TINY_AYA_BASE: 1052, COMMAND_R_08_2024_HF: 1053, AYA_VISION_32B_HF: 1054, GLM_4_0414: 1055, GLM_4_5: 1056, GLM_5: 1057, GLM_EDGE: 1058, AUTOGLM_PHONE: 1059, KIMI_K2_BASE: 1060, KIMI_K2_THINKING: 1061, KIMI_K2_5: 1062, KIMI_K3: 1063, KIMI_VL: 1064, MOONLIGHT: 1065, MINIMAX_TEXT_01: 1066, MINIMAX_M1: 1067, MINIMAX_M2: 1068, MINIMAX_M3: 1069, GPT_OSS: 1070, PHI_1: 1071, PHI_3_HF: 1072, PHI_3_SMALL: 1073, PHI_3_VISION: 1074, PHI_4: 1075, PHI_4_MINI: 1076, PHI_4_MULTIMODAL: 1077, PHI_4_REASONING: 1078, PHI_4_REASONING_VISION: 1079, NEMOTRON_4: 1080, LLAMA_3_1_NEMOTRON_51B: 1081, NEMOTRON_H: 1082, LLAMA_3_1_NEMOTRON_NANO_VL: 1083, ACEREASON_NEMOTRON_1_1: 1084, NEMOTRON_NANO_12B_V2_VL: 1085, NEMOTRON_3: 1086 };
    const clientEnum = fs.readFileSync(path.join(__dirname, '..', 'public', 'scripts', 'tokenizers.js'), 'utf8');
    const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const registryKeys = new Set();
    for (const entry of TOKENIZER_SOURCES) {
        const key = entry.id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
        registryKeys.add(key);
        const value = tokenizers[key];
        assert.equal(value, expected[key], `${entry.id}: tokenizers.${key}`);
        assert.equal(TOKENIZER_TYPE_KEYS[value], entry.id, `${entry.id}: TOKENIZER_TYPE_KEYS`);
        assert.ok(clientEnum.includes(`\n    ${key}: ${value},\n`), `${entry.id}: the browser's tokenizers.${key}`);
        assert.ok(indexHtml.includes(`<option value="${value}">${getTokenizerDisplayName(entry)}</option>`), `${entry.id}: its #tokenizer option`);
    }
    assert.deepEqual([...registryKeys].sort(), Object.keys(expected).sort());
    for (const [key, value] of Object.entries(tokenizers)) {
        assert.equal(value >= 1000, registryKeys.has(key), `tokenizers.${key}: only registry entries are 1000 and up`);
    }
});

fs.rmSync(dataRoot, { recursive: true, force: true });
fs.rmSync(userRoot, { recursive: true, force: true });
