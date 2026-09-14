import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This module reads process-wide config at import time (e.g. src/endpoints/secrets.js) - the
// config path must be set before that import chain runs, same approach as
// src/tokenizer-resolve.test.js and src/novel-generation-data.test.js.
import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

const { computeLogitBias, computeTextgenLogitBias, resolveTextgenTokenizerForTokenIds } = await import('./tokenizers.js');

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

// --- resolveTextgenTokenizerForTokenIds ---

// No options at all -> falls all the way through to the final tokenizers.LLAMA-equivalent default.
{
    const result = resolveTextgenTokenizerForTokenIds();
    assert.deepEqual(result, { kind: 'local', type: 'llama' });
}

// A directly-selected power_user.tokenizer equivalent that's in TEXTGEN_ENCODE_TOKENIZER_TYPES wins
// regardless of live connection state (pure, matches ENCODE_TOKENIZERS.includes(power_user.tokenizer)).
{
    const result = resolveTextgenTokenizerForTokenIds({ settingsType: 'ooba', powerUserTokenizer: 'gemma' });
    assert.deepEqual(result, { kind: 'local', type: 'gemma' });
}

// isConnected + hasTokenizerError=false + a TEXTGEN_API_TOKENIZER_TYPES member (non-OOBA, so
// hasValidEndpoint isn't consulted) -> resolves to the live current-API tokenizer, dispatched by
// mainApi.
{
    const textgen = resolveTextgenTokenizerForTokenIds({ settingsType: 'vllm', mainApi: 'textgenerationwebui', isConnected: true });
    assert.deepEqual(textgen, { kind: 'remote-textgen' });

    const kobold = resolveTextgenTokenizerForTokenIds({ settingsType: 'vllm', mainApi: 'kobold', isConnected: true });
    assert.deepEqual(kobold, { kind: 'remote-kobold' });
}

// OOBA specifically also needs hasValidEndpoint - without it, falls through even while connected.
{
    const withoutEndpoint = resolveTextgenTokenizerForTokenIds({ settingsType: 'ooba', mainApi: 'textgenerationwebui', isConnected: true });
    assert.deepEqual(withoutEndpoint, { kind: 'local', type: 'llama' });

    const withEndpoint = resolveTextgenTokenizerForTokenIds({ settingsType: 'ooba', mainApi: 'textgenerationwebui', isConnected: true, hasValidEndpoint: true });
    assert.deepEqual(withEndpoint, { kind: 'remote-textgen' });
}

// OpenRouter: jamba model id short-circuits; otherwise dispatches on the found model's architecture.tokenizer.
{
    const jamba = resolveTextgenTokenizerForTokenIds({ settingsType: 'openrouter', openRouterModelId: 'ai21/jamba-mini' });
    assert.deepEqual(jamba, { kind: 'local', type: 'jamba' });

    const cohere = resolveTextgenTokenizerForTokenIds({
        settingsType: 'openrouter', openRouterModelId: 'cohere/command-r',
        openRouterModels: [{ id: 'cohere/command-r', architecture: { tokenizer: 'Cohere' } }],
    });
    assert.deepEqual(cohere, { kind: 'local', type: 'command-r' });

    // Live model list not given (honest default []) -> .find() misses -> falls to the OPENAI default case.
    const noList = resolveTextgenTokenizerForTokenIds({ settingsType: 'openrouter', openRouterModelId: 'some/model' });
    assert.deepEqual(noList, { kind: 'openai' });
}

// DreamGen: recognized large-model id prefixes map to llama3, everything else (including an
// unresolved model - the deliberate divergence from the client's own throwing behavior, see this
// function's doc comment) falls to mistral.
{
    const large = resolveTextgenTokenizerForTokenIds({
        settingsType: 'dreamgen', dreamGenModelId: 'lucid-v1-max',
        dreamGenModels: [{ id: 'lucid-v1-max' }],
    });
    assert.deepEqual(large, { kind: 'local', type: 'llama3' });

    const unresolved = resolveTextgenTokenizerForTokenIds({ settingsType: 'dreamgen', dreamGenModelId: 'unknown-model' });
    assert.deepEqual(unresolved, { kind: 'local', type: 'mistral' });
}

// --- computeTextgenLogitBias ---

// A {...}-wrapped verbatim-text entry and a plain-text entry both resolve to real token-id-keyed
// bias entries via a real local tokenizer. gpt2/tiktoken (this file's other tests' choice) isn't
// reachable via resolveTextgenTokenizerForTokenIds(), so tokenizerOptions instead selects the local
// 'mistral' sentencepiece tokenizer - one of the values ENCODE_TOKENIZERS/TEXTGEN_ENCODE_TOKENIZER_
// TYPES actually resolves to, and cheap/offline (small on-disk model, no network).
{
    const result = await computeTextgenLogitBias(
        [{ text: '{hello}', value: -50 }, { text: 'world', value: 25 }],
        { settingsType: 'ooba', powerUserTokenizer: 'mistral' },
    );
    assert.equal(Object.keys(result).length > 0, true);
    assert.equal(Object.values(result).includes(-50), true);
    assert.equal(Object.values(result).includes(25), true);
}

// A [...]-wrapped raw JSON token-id entry passes through directly without going through the tokenizer.
{
    const result = await computeTextgenLogitBias(
        [{ text: '[7, 8, 9]', value: 3 }],
        { settingsType: 'ooba', powerUserTokenizer: 'mistral' },
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
        { settingsType: 'ooba', powerUserTokenizer: 'mistral' },
    );
    assert.equal(Object.keys(result).length > 0, true);
    assert.equal(Object.values(result).every(v => v === -1), true);
}

// A remote-textgen/remote-kobold resolution with no `request`/`baseUrl` in remoteContext degrades
// to "no tokens for this entry" instead of attempting a real network call or throwing - this is the
// documented behavior when a caller resolves to a live backend but can't supply the live context.
{
    const result = await computeTextgenLogitBias(
        [{ text: 'hello', value: -1 }],
        { settingsType: 'vllm', mainApi: 'textgenerationwebui', isConnected: true },
        {},
    );
    assert.deepEqual(result, {});
}

console.log('tokenizers.test.js: all tests passed');
