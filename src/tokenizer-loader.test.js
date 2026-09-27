import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock } from 'node:test';

import { setConfigFilePath } from './util.js';

// Run: node --experimental-test-module-mocks src/tokenizer-loader.test.js

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tokenizer-loader-'));
const configPath = path.join(tempDir, 'config.yaml');
// Fits llama.model and mistral.model together, not with yi.model too; gemma.model alone is bigger.
fs.writeFileSync(configPath, 'tokenizerMemoryCacheCapacity: \'1.5mb\'\n');
setConfigFilePath(configPath);
globalThis.DATA_ROOT = tempDir;

const { SentencePieceProcessor } = await import('@agnai/sentencepiece-js');
const { loadTokenizerFile } = await import('./tokenizer-loader.js');
const { getWebTokenizer } = await import('./endpoints/tokenizers.js');

const model = name => path.join(root, 'src', 'tokenizers', `${name}.model`);
const LLAMA = model('llama'); // 499,723 bytes
const MISTRAL = model('mistral'); // 493,443 bytes
const YI = model('yi'); // 1,033,105 bytes
const JAMBA = model('jamba'); // 1,124,714 bytes
const GEMMA = model('gemma'); // 4,241,003 bytes, more than the whole budget

const load = file => loadTokenizerFile(file, 'sentencepiece');

/** Loads gemma.model, which is bigger than the budget, so nothing else stays loaded. */
async function unloadAll() {
    await load(GEMMA);
}

const caseFailures = [];
/**
 * @param {string} name
 * @param {() => Promise<void>} fn
 */
async function testCase(name, fn) {
    try {
        await fn();
        console.log(`  pass: ${name}`);
    } catch (error) {
        caseFailures.push(name);
        console.log(`  FAIL: ${name}: ${error.message}`);
    }
}

/**
 * Runs an ES module snippet in a child node process from the project root, with module mocks.
 * @param {string} code
 */
function runChild(code) {
    return spawnSync(process.execPath, ['--experimental-test-module-mocks', '--no-warnings', '--input-type=module', '-e', code], { cwd: root, encoding: 'utf8' });
}

await testCase('past the budget, the least recently used tokenizer is unloaded', async () => {
    await unloadAll();
    const llama = await load(LLAMA);
    const mistral = await load(MISTRAL);
    await load(YI);
    assert.equal(await load(MISTRAL), mistral, 'mistral stays');
    assert.notEqual(await load(LLAMA), llama, 'llama was unloaded');
});

await testCase('a get makes a tokenizer the most recently used', async () => {
    await unloadAll();
    const llama = await load(LLAMA);
    const mistral = await load(MISTRAL);
    assert.equal(await load(LLAMA), llama);
    await load(YI);
    assert.equal(await load(LLAMA), llama, 'llama stays');
    assert.notEqual(await load(MISTRAL), mistral, 'mistral was unloaded');
});

await testCase('a tokenizer bigger than the budget loads and unloads all others', async () => {
    await load(YI);
    const llama = await load(LLAMA);
    const gemma = await load(GEMMA);
    assert.deepEqual(gemma.encodeIds('hello').length > 0, true, 'gemma encodes');
    assert.equal(await load(GEMMA), gemma, 'gemma stays loaded');
    assert.notEqual(await load(LLAMA), llama, 'llama was unloaded');
});

await testCase('an unloaded tokenizer loads again on its next use', async () => {
    await unloadAll();
    const llama = await load(LLAMA);
    const ids = llama.encodeIds('The quick brown fox');
    await unloadAll();
    const reloaded = await load(LLAMA);
    assert.notEqual(reloaded, llama);
    assert.deepEqual(reloaded.encodeIds('The quick brown fox'), ids);
});

await testCase('parallel loads of one file share one load', async () => {
    await unloadAll();
    const loadSpy = mock.method(SentencePieceProcessor.prototype, 'load');
    try {
        const results = await Promise.all([1, 2, 3, 4].map(() => load(JAMBA)));
        assert.equal(loadSpy.mock.callCount(), 1, 'one load');
        for (const result of results) {
            assert.equal(result, results[0]);
        }
    } finally {
        loadSpy.mock.restore();
    }
});

await testCase('web tokenizers are not unloaded', async () => {
    const claude = await getWebTokenizer('claude').get();
    assert.ok(claude);
    await load(YI);
    await unloadAll();
    assert.equal(await getWebTokenizer('claude').get(), claude);
});

await testCase('without the setting, the budget is 256mb', async () => {
    const childDir = fs.mkdtempSync(path.join(tempDir, 'default-'));
    fs.writeFileSync(path.join(childDir, 'config.yaml'), 'enableDownloadableTokenizers: true\n');
    const MIB = 1024 * 1024;
    // Sparse files: only their size on disk counts, and the mocked reader doesn't read them.
    const sizes = { a: 128 * MIB, b: 128 * MIB, c: 1 };
    for (const [name, size] of Object.entries(sizes)) {
        fs.closeSync(fs.openSync(path.join(childDir, name), 'w'));
        fs.truncateSync(path.join(childDir, name), size);
    }
    const child = runChild(`
        import { mock } from 'node:test';
        mock.module('tokenizers', { namedExports: { Tokenizer: { fromFile: file => ({ file }) } } });
        const { setConfigFilePath } = await import('./src/util.js');
        setConfigFilePath(${JSON.stringify(path.join(childDir, 'config.yaml'))});
        const { loadTokenizerFile } = await import('./src/tokenizer-loader.js');
        const dir = ${JSON.stringify(childDir)};
        const load = name => loadTokenizerFile(dir + '/' + name, 'hf-json');
        const a = await load('a');
        const b = await load('b');
        const atBudget = (await load('a')) === a && (await load('b')) === b;
        await load('c');
        const pastBudget = (await load('b')) === b && (await load('a')) !== a;
        console.log(JSON.stringify({ atBudget, pastBudget }));
    `);
    const lines = child.stdout.trim().split('\n');
    assert.equal(child.status, 0, `child exited ${child.status}: ${child.stderr}`);
    assert.deepEqual(JSON.parse(lines.at(-1)), { atBudget: true, pastBudget: true },
        '256 MiB of tokenizers stay loaded; one byte more unloads the least recently used');
});

await testCase('a failing import(\'tokenizers\') fails the hf-json load, and the count goes to the failure path', async () => {
    const child = runChild(`
        import assert from 'node:assert/strict';
        import { mock } from 'node:test';
        mock.module('tokenizers', { namedExports: { get Tokenizer() { throw new Error('Failed to load native binding (mocked)'); } } });
        const { setConfigFilePath } = await import('./src/util.js');
        setConfigFilePath(${JSON.stringify(configPath)});
        globalThis.DATA_ROOT = ${JSON.stringify(tempDir)};
        const { loadTokenizerFile } = await import('./src/tokenizer-loader.js');
        await assert.rejects(() => loadTokenizerFile('src/tokenizers/llama3.json', 'hf-json'), /native binding/);

        const { router, guesstimate } = await import('./src/endpoints/tokenizers.js');
        const { router: currentRouter } = await import('./src/endpoints/tokenizers-current.js');
        const { tokenizers } = await import('./src/tokenizer-resolve.js');
        const { default: express } = await import('express');
        const app = express();
        app.use(express.json());
        app.use('/api/tokenizers', router);
        app.use('/api/tokenizers', currentRouter);
        const server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const baseUrl = 'http://127.0.0.1:' + server.address().port + '/api/tokenizers';
        const text = 'The quick brown fox jumps over the lazy dog.';
        const state = { api: 'textgenerationwebui', type: 'generic', url: 'http://127.0.0.1:1', model: 'x', tokenizerSetting: tokenizers.LLAMA3 };
        const counted = await (await fetch(baseUrl + '/current/count', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, texts: [text] }),
        })).json();
        const encoded = await (await fetch(baseUrl + '/llama3/encode', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
        })).json();
        server.close();
        console.log(JSON.stringify({
            counts: counted.counts, basis: counted.tokenizer.basis, id: counted.tokenizer.id, llama3: tokenizers.LLAMA3,
            encoded, estimate: guesstimate(text),
        }));
    `);
    assert.equal(child.status, 0, `child exited ${child.status}: ${child.stderr}`);
    const result = JSON.parse(child.stdout.trim().split('\n').at(-1));
    assert.deepEqual(result.counts, [result.estimate], '/current/count answers the estimate');
    assert.deepEqual({ id: result.id, basis: result.basis }, { id: result.llama3, basis: 'failed' });
    assert.deepEqual(result.encoded, { ids: [], count: result.estimate, chunks: [] }, '/llama3/encode answers the estimate');
});

fs.rmSync(tempDir, { recursive: true, force: true });

assert.deepEqual(caseFailures, [], 'tokenizer loader cases');

console.log('tokenizer-loader.test.js: all tests passed');
