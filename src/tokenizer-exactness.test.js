import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'yaml';

import { setConfigFilePath } from './util.js';

// Every fixture in tests/fixtures/tokenizer-reference holds the ids the vendor's own tool gives for
// the samples. Each file is read through the reader SillyTavern uses for it, and must give the same
// ids. A file that isn't in the cache is not run; `node scripts/fetch-tokenizer-fixtures.js` fills it.
//
// A fixture is named by its tokenizer's identity: the file's sha256, then `.<config hash>` for a
// registry entry with a tokenizer config (src/tokenizer-sources.js getTokenizerIdentity()). A
// registry fixture's name must be its entry's identity, so an entry whose config changed fails.
//
// A fixture whose `file` is {"sameContentAs": <identity>, ...} was made from a file with the same
// content as the file of fixture <identity>, which is the file SillyTavern reads. That fixture must
// exist; its format may differ (a `.model` whose json SillyTavern reads). Its file is located and
// sha-checked through that fixture's own `file`, `format` and `sha256`, so it is not run when that
// file isn't in the cache, and it must give this fixture's ids.
//
// Usage: node src/tokenizer-exactness.test.js [--dataRoot <dir>]
// Without --dataRoot, config.yaml's dataRoot is used.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'config.yaml');
const fixturesDir = path.join(root, 'tests', 'fixtures', 'tokenizer-reference');

const args = process.argv.slice(2);
const dataRootIndex = args.indexOf('--dataRoot');
const dataRoot = path.resolve(root, dataRootIndex !== -1
    ? args[dataRootIndex + 1]
    : yaml.parse(fs.readFileSync(configPath, 'utf8')).dataRoot);

setConfigFilePath(configPath);
globalThis.DATA_ROOT = dataRoot;

const { encodeTextByLocalTokenizerType } = await import('./endpoints/tokenizers.js');
const { loadPinnedTokenizer } = await import('./tokenizer-loader.js');
const { TOKENIZER_SOURCES, CACHE_EXTENSIONS, getTokenizerIdentity } = await import('./tokenizer-sources.js');

/**
 * Where SillyTavern keeps a fixture's file, and how it encodes with it.
 * @param {any} file The fixture's `file` descriptor
 * @param {string} format
 * @returns {{ filePath: string, getEncode: () => Promise<(text: string) => Promise<number[]>> }}
 */
function locate(file, format) {
    if (file.bundled) {
        const type = path.basename(file.bundled, path.extname(file.bundled));
        return {
            filePath: path.join(root, file.bundled),
            getEncode: async () => text => encodeTextByLocalTokenizerType(type, text),
        };
    }
    if (file.download) {
        const type = path.basename(file.cacheName, path.extname(file.cacheName));
        return {
            filePath: path.join(dataRoot, '_cache', file.cacheName),
            getEncode: async () => text => encodeTextByLocalTokenizerType(type, text),
        };
    }
    const entry = TOKENIZER_SOURCES.find(source => source.id === file.registry);
    if (!entry) {
        throw new Error(`No registry entry ${file.registry}`);
    }
    return {
        filePath: path.join(dataRoot, '_cache', `${entry.sha256}${CACHE_EXTENSIONS[format]}`),
        getEncode: async () => (await loadPinnedTokenizer(entry)).encode,
    };
}

const summary = { run: 0, notRun: 0, failed: 0 };
const failures = [];

const fixtureFiles = fs.readdirSync(fixturesDir).filter(name => /^[0-9a-f]{64}(\.[0-9a-f]{64})?\.json$/.test(name)).sort();
for (const name of fixtureFiles) {
    const fixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8'));
    const descriptor = JSON.stringify(fixture.file);

    if (fixture.file.registry) {
        const entry = TOKENIZER_SOURCES.find(source => source.id === fixture.file.registry);
        const identity = entry ? getTokenizerIdentity(entry) : undefined;
        if (`${identity}.json` !== name) {
            summary.failed++;
            failures.push(descriptor);
            console.log(`not ok - ${descriptor}: the fixture is ${name}, the entry's identity is ${identity}`);
            continue;
        }
    }

    // The fixture that says where SillyTavern keeps the file and which sha256 it has.
    let read = fixture;
    if (fixture.file.sameContentAs) {
        const referencedPath = path.join(fixturesDir, `${fixture.file.sameContentAs}.json`);
        if (!fs.existsSync(referencedPath)) {
            summary.failed++;
            failures.push(descriptor);
            console.log(`not ok - ${descriptor}: no fixture ${fixture.file.sameContentAs}`);
            continue;
        }
        read = JSON.parse(fs.readFileSync(referencedPath, 'utf8'));
    }
    const { filePath, getEncode } = locate(read.file, read.format);

    if (!fs.existsSync(filePath)) {
        summary.notRun++;
        console.log(`not run: ${descriptor} (${filePath} is missing)`);
        continue;
    }
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    if (sha256 !== read.sha256) {
        summary.notRun++;
        console.log(`not run: ${descriptor} (${filePath} has sha256 ${sha256}, the fixture is for ${read.sha256})`);
        continue;
    }

    summary.run++;
    try {
        const encode = await getEncode();
        const mismatched = [];
        for (const [index, sample] of fixture.samples.entries()) {
            const ids = Array.from(await encode(sample.text));
            if (!Array.isArray(ids) || ids.length !== sample.ids.length || ids.some((id, i) => id !== sample.ids[i])) {
                mismatched.push(`sample ${index + 1}: ${ids.length} ids, reference ${sample.ids.length}`);
            }
        }
        if (mismatched.length > 0) {
            throw new Error(mismatched.join('; '));
        }
        console.log(`ok - ${descriptor}: ${fixture.samples.length} samples`);
    } catch (error) {
        summary.failed++;
        failures.push(descriptor);
        console.log(`not ok - ${descriptor}: ${error.message}`);
    }
}

console.log(`tokenizer-exactness.test.js: ${summary.run} run, ${summary.notRun} not run, ${summary.failed} failed`);
assert.deepEqual(failures, [], 'tokenizer fixtures whose ids differ from the reference');
