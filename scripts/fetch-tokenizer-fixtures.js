#!/usr/bin/env node
/**
 * Fills DATA_ROOT/_cache with the tokenizer file of every fixture in tests/fixtures/tokenizer-reference,
 * the way SillyTavern downloads it, so `node src/tokenizer-exactness.test.js` runs every fixture.
 *
 * Usage, from the project root:
 *   node scripts/fetch-tokenizer-fixtures.js
 *   node scripts/fetch-tokenizer-fixtures.js --dataRoot ./some-data-root
 *
 * Without --dataRoot, config.yaml's dataRoot is used.
 */

import fs from 'node:fs';
import path from 'node:path';

import yaml from 'yaml';

import { setConfigFilePath } from '../src/util.js';

const configPath = './config.yaml';
const fixturesDir = path.join('tests', 'fixtures', 'tokenizer-reference');

/**
 * @param {string[]} args
 * @param {string} name
 * @returns {string|undefined}
 */
function getArg(args, name) {
    const index = args.indexOf(`--${name}`);
    return index !== -1 ? args[index + 1] : undefined;
}

const dataRoot = getArg(process.argv.slice(2), 'dataRoot') ?? yaml.parse(fs.readFileSync(configPath, 'utf8')).dataRoot;
if (!dataRoot) {
    console.error('No --dataRoot given and no "dataRoot" setting found in config.yaml.');
    process.exit(1);
}

setConfigFilePath(configPath);
globalThis.DATA_ROOT = path.resolve(dataRoot);

const { TOKENIZER_SOURCES, getPinnedTokenizerFile } = await import('../src/tokenizer-sources.js');
const { getPathToTokenizer } = await import('../src/endpoints/tokenizers.js');

let failed = 0;
for (const name of fs.readdirSync(fixturesDir).filter(file => /^[0-9a-f]{64}\.json$/.test(file)).sort()) {
    const { file } = JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8'));
    const descriptor = JSON.stringify(file);
    try {
        if (file.registry) {
            const entry = TOKENIZER_SOURCES.find(source => source.id === file.registry);
            if (!entry) {
                throw new Error('No registry entry with that id');
            }
            console.log(`${descriptor}: ${(await getPinnedTokenizerFile(entry)).path}`);
        } else if (file.download) {
            console.log(`${descriptor}: ${await getPathToTokenizer(file.download)}`);
        } else {
            console.log(`${descriptor}: bundled`);
        }
    } catch (error) {
        failed++;
        console.error(`${descriptor}: ${error.message}`);
    }
}

if (failed > 0) {
    console.error(`${failed} tokenizer file(s) could not be fetched.`);
    process.exit(1);
}
