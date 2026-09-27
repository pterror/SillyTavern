import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// @agnai/web-tokenizers' emscripten glue installed an empty process-wide uncaughtException
// listener on first load, swallowing every later crash (scripts/patch-web-tokenizers.cjs removes
// it). Each case runs in a child process, since a swallowed crash in this process would exit 0.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Runs an ES module snippet in a child node process from the project root.
 * @param {string} code
 */
function runChild(code) {
    return spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, encoding: 'utf8' });
}

const loadTokenizer = `
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/package.json');
const { Tokenizer } = require('@agnai/web-tokenizers');
await Tokenizer.fromJSON(await fs.promises.readFile('src/tokenizers/claude.json'));
`;

const thrown = runChild(`${loadTokenizer}
throw new Error('deliberate failure after tokenizer load');
`);
assert.notEqual(thrown.status, 0, `child exited ${thrown.status} after throwing; stderr: ${thrown.stderr}`);

const counted = runChild(`
const before = process.listenerCount('uncaughtException');
${loadTokenizer}
console.log(JSON.stringify({ before, after: process.listenerCount('uncaughtException') }));
`);
assert.equal(counted.status, 0, `listener-count child exited ${counted.status}; stderr: ${counted.stderr}`);
const { before, after } = JSON.parse(counted.stdout.trim().split('\n').at(-1));
assert.equal(after, before, `uncaughtException listeners before load: ${before}, after: ${after}`);
