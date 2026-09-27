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

const { TOKENIZER_SOURCES, getPinnedTokenizerFile, getSourceUrl } = await import('./tokenizer-sources.js');
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
 * A test-only entry for `body`, one source per repo name.
 * @param {Buffer} body
 * @param {{ repo: string, gated?: boolean, path?: string }[]} sources
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
        sources: sources.map(source => ({
            repo: source.repo,
            revision: String(++revisionCounter).padStart(40, '0'),
            path: source.path ?? 'tokenizer.json',
            gated: source.gated ?? false,
        })),
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

await testCase('parallel calls on a cold cache share one download; only the call that fetched reports downloaded', async () => {
    const body = Buffer.from('{"parallel":1}');
    const entry = makeEntry(body, [{ repo: 'owner/parallel' }]);
    responses.set(getSourceUrl(entry.sources[0]), ok(body));
    const results = await Promise.all([1, 2, 3, 4].map(() => getPinnedTokenizerFile(entry)));
    assert.equal(requests.length, 1, 'one request');
    assert.deepEqual(results.map(r => r.downloaded), [true, false, false, false]);
    assert.equal(new Set(results.map(r => r.path)).size, 1);
});

await testCase('every registry entry is pinned', () => {
    const ids = new Set();
    for (const entry of TOKENIZER_SOURCES) {
        assert.ok(!ids.has(entry.id), `${entry.id}: unique id`);
        ids.add(entry.id);
        assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${entry.id}: sha256`);
        assert.ok(Number.isInteger(entry.bytes) && entry.bytes > 0, `${entry.id}: bytes`);
        assert.ok(['hf-json', 'sentencepiece', 'tekken', 'tiktoken'].includes(entry.format), `${entry.id}: format`);
        assert.ok(entry.license, `${entry.id}: license`);
        assert.ok(entry.sources.length > 0, `${entry.id}: sources`);
        entry.sources.forEach((source, index) => {
            assert.match(source.revision, /^[0-9a-f]{40}$/, `${entry.id}: revision`);
            assert.ok(source.repo && source.path, `${entry.id}: repo and path`);
            assert.ok(index === 0 || !source.gated, `${entry.id}: only the model's own repo, listed first, can be gated`);
        });
    }
    assert.ok(Object.isFrozen(TOKENIZER_SOURCES));
});

await testCase('every registry entry has its fixed `tokenizers` value, on the server, in the browser and in Advanced Formatting', async () => {
    const { tokenizers, TOKENIZER_TYPE_KEYS } = await import('./tokenizer-ids.js');
    // Fixed forever once shipped: never renumbered, reused or removed.
    const expected = { QWEN3: 1000, LLAMA3_1: 1001, NEMO_TEKKEN: 1002, KIMI: 1003, QWEN2_VL: 1004, QWEN2_5: 1005, QWEN3_5: 1006, QWEN3_5_BASE: 1007, QWEN3_8: 1008, CODEQWEN1_5: 1009 };
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
        assert.ok(indexHtml.includes(`<option value="${value}">${entry.family} (official)</option>`), `${entry.id}: its #tokenizer option`);
    }
    assert.deepEqual([...registryKeys].sort(), Object.keys(expected).sort());
    for (const [key, value] of Object.entries(tokenizers)) {
        assert.equal(value >= 1000, registryKeys.has(key), `tokenizers.${key}: only registry entries are 1000 and up`);
    }
});

fs.rmSync(dataRoot, { recursive: true, force: true });
fs.rmSync(userRoot, { recursive: true, force: true });
