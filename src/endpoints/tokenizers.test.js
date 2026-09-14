import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This module reads process-wide config at import time (e.g. src/endpoints/secrets.js) - the
// config path must be set before that import chain runs, same approach as
// src/tokenizer-resolve.test.js and src/novel-generation-data.test.js.
import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

const { computeLogitBias } = await import('./tokenizers.js');

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

console.log('tokenizers.test.js: all tests passed');
