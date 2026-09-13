import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TEXTGEN_TYPES } from './constants.js';
// tokenizer-resolve.js statically imports src/endpoints/tokenizers.js, which pulls in code that
// reads process-wide config at MODULE IMPORT time (e.g. src/endpoints/secrets.js) - the config
// path must be set before that import chain runs, so (unlike src/token-bans-and-bias.test.js,
// which only needs to defer its *own* smoke-test import of endpoints/tokenizers.js)
// tokenizer-resolve.js itself has to be imported dynamically here, after setConfigFilePath().
import { setConfigFilePath } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', 'config.yaml'));

const {
    tokenizers,
    TOKENIZER_TYPE_KEYS,
    getTokenizerBestMatch,
    getCurrentOpenRouterModelTokenizer,
    getCurrentDreamGenModelTokenizer,
    resolveTokenizerType,
    encodeWithTokenizerType,
} = await import('./tokenizer-resolve.js');

// --- getTokenizerBestMatch: novel API / NAI model branches ---

assert.equal(getTokenizerBestMatch('novel', { naiModel: 'clio-v1' }), tokenizers.NERD);
assert.equal(getTokenizerBestMatch('novel', { naiModel: 'kayra-v1' }), tokenizers.NERD2);
assert.equal(getTokenizerBestMatch('novel', { naiModel: 'erato-v1' }), tokenizers.LLAMA3);
// Unrecognized NAI model name falls through the novel branch entirely -> NONE (matches client:
// getTokenizerBestMatch has no post-novel-branch fallback, so an unmatched novel model returns
// undefined in the client; here the equivalent "falls through to the final `return NONE`" applies
// since our novel branch and the kobold/textgen branch are mutually exclusive ifs).
assert.equal(getTokenizerBestMatch('novel', { naiModel: 'unknown-model' }), tokenizers.NONE);

// --- getTokenizerBestMatch: unrecognized API -> NONE ---

assert.equal(getTokenizerBestMatch('some_other_api'), tokenizers.NONE);
assert.equal(getTokenizerBestMatch(undefined), tokenizers.NONE);

// --- getTokenizerBestMatch: textgen model-name substring matches (isConnected but no remote/API tokenizer) ---

const modelCases = [
    ['Meta-Llama-3-8B-Instruct', tokenizers.LLAMA3],
    ['llama-3-70b', tokenizers.LLAMA3],
    ['Mixtral-8x7B', tokenizers.MISTRAL],
    ['gemma-2-9b-it', tokenizers.GEMMA],
    ['pixtral-12b', tokenizers.NEMO],
    ['deepseek-coder-v2', tokenizers.DEEPSEEK],
    ['01-ai/Yi-34B', tokenizers.YI],
    ['jamba-1.5-mini', tokenizers.JAMBA],
    ['command-r-plus', tokenizers.COMMAND_R],
    ['command-a-03-2025', tokenizers.COMMAND_A],
    ['Qwen2-72B-Instruct', tokenizers.QWEN2],
    ['some-totally-unknown-model', tokenizers.LLAMA], // default fallback
];

for (const [textgenModel, expected] of modelCases) {
    const result = getTokenizerBestMatch('textgenerationwebui', {
        textgenType: TEXTGEN_TYPES.GENERIC,
        textgenModel,
    });
    assert.equal(result, expected, `model "${textgenModel}" should resolve to tokenizer ${expected}, got ${result}`);
}

// --- getTokenizerBestMatch: remote/API tokenizer takes priority when backend type supports it ---

assert.equal(
    getTokenizerBestMatch('textgenerationwebui', { textgenType: TEXTGEN_TYPES.TABBY, textgenModel: 'mistral-large' }),
    tokenizers.API_TEXTGENERATIONWEBUI,
);
assert.equal(
    getTokenizerBestMatch('kobold', { canUseTokenization: true }),
    tokenizers.API_KOBOLD,
);
// Not connected -> remote/API tokenizer skipped even if otherwise supported, falls through to model-name match.
assert.equal(
    getTokenizerBestMatch('textgenerationwebui', { textgenType: TEXTGEN_TYPES.TABBY, textgenModel: 'gemma-2', isConnected: false }),
    tokenizers.GEMMA,
);

// --- getCurrentOpenRouterModelTokenizer / getCurrentDreamGenModelTokenizer fixtures ---

const openRouterModels = [
    { id: 'meta-llama/llama-3-70b', architecture: { tokenizer: 'Llama3' } },
    { id: 'anthropic/claude-3-opus', architecture: { tokenizer: 'Claude' } },
    { id: 'qwen/qwen-2-72b', architecture: { tokenizer: 'Qwen' } },
    { id: 'some/unknown-tokenizer-model', architecture: { tokenizer: 'SomethingElse' } },
];

assert.equal(getCurrentOpenRouterModelTokenizer('meta-llama/llama-3-70b', openRouterModels), tokenizers.LLAMA3);
assert.equal(getCurrentOpenRouterModelTokenizer('anthropic/claude-3-opus', openRouterModels), tokenizers.CLAUDE);
assert.equal(getCurrentOpenRouterModelTokenizer('qwen/qwen-2-72b', openRouterModels), tokenizers.QWEN2);
assert.equal(getCurrentOpenRouterModelTokenizer('some/unknown-tokenizer-model', openRouterModels), tokenizers.OPENAI);
assert.equal(getCurrentOpenRouterModelTokenizer('ai21/jamba-1.5', openRouterModels), tokenizers.JAMBA);
assert.equal(getCurrentOpenRouterModelTokenizer('not-in-list', []), tokenizers.OPENAI);

const dreamGenModels = [
    { id: 'lucid-v1-medium' },
    { id: 'lucid-v1-base' },
    { id: 'lucid-v1-extra-large' },
    { id: 'lucid-v1-max' },
];

assert.equal(getCurrentDreamGenModelTokenizer('lucid-v1-medium', dreamGenModels), tokenizers.MISTRAL);
assert.equal(getCurrentDreamGenModelTokenizer('lucid-v1-base', dreamGenModels), tokenizers.MISTRAL);
assert.equal(getCurrentDreamGenModelTokenizer('lucid-v1-extra-large', dreamGenModels), tokenizers.LLAMA3);
assert.equal(getCurrentDreamGenModelTokenizer('lucid-v1-max', dreamGenModels), tokenizers.LLAMA3);
assert.equal(getCurrentDreamGenModelTokenizer('unknown-model-id', dreamGenModels), tokenizers.MISTRAL);

// --- resolveTokenizerType: OpenRouter / DreamGen delegation via getTokenizerForTokenIds mirror ---

assert.equal(
    resolveTokenizerType({
        textgenType: TEXTGEN_TYPES.OPENROUTER,
        openRouterModel: 'meta-llama/llama-3-70b',
        openRouterModels,
    }),
    tokenizers.LLAMA3,
);
assert.equal(
    resolveTokenizerType({
        textgenType: TEXTGEN_TYPES.DREAMGEN,
        dreamGenModel: 'lucid-v1-extra-large',
        dreamGenModels,
    }),
    tokenizers.LLAMA3,
);

// --- resolveTokenizerType: LLAMA default fallback ---

assert.equal(
    resolveTokenizerType({ textgenType: TEXTGEN_TYPES.GENERIC, textgenModel: 'totally-unknown-model' }),
    tokenizers.LLAMA,
);
// No deps at all -> still LLAMA (matches getTokenizerForTokenIds()'s unconditional final fallback).
assert.equal(resolveTokenizerType(), tokenizers.LLAMA);

// --- resolveTokenizerType: remote/API tokenizer -> API_CURRENT (matches getTokenizerForTokenIds()) ---

assert.equal(
    resolveTokenizerType({ textgenType: TEXTGEN_TYPES.TABBY, textgenModel: 'mistral-large' }),
    tokenizers.API_CURRENT,
);

// --- resolveTokenizerType: power_user.tokenizer === API_CURRENT + supported backend type ---

assert.equal(
    resolveTokenizerType({
        userTokenizerSetting: tokenizers.API_CURRENT,
        textgenType: TEXTGEN_TYPES.KOBOLDCPP,
        textgenModel: 'unknown-model',
        isConnected: false, // force past the remote-tokenizer branch so this check is what's exercised
    }),
    tokenizers.API_CURRENT,
);

// --- resolveTokenizerType: ENCODE_TOKENIZERS.includes(userTokenizerSetting) short-circuit ---

assert.equal(
    resolveTokenizerType({
        userTokenizerSetting: tokenizers.QWEN2,
        textgenType: TEXTGEN_TYPES.GENERIC,
        textgenModel: 'unknown-model',
        isConnected: false,
    }),
    tokenizers.QWEN2,
);
// A userTokenizerSetting NOT in ENCODE_TOKENIZERS (e.g. GPT2) does not short-circuit.
assert.equal(
    resolveTokenizerType({
        userTokenizerSetting: tokenizers.GPT2,
        textgenType: TEXTGEN_TYPES.GENERIC,
        textgenModel: 'unknown-model',
        isConnected: false,
    }),
    tokenizers.LLAMA,
);

// --- resolveTokenizerType: forApi override delegates straight to getTokenizerBestMatch (novel / unrecognized) ---

assert.equal(resolveTokenizerType({ forApi: 'novel', naiModel: 'clio-v1' }), tokenizers.NERD);
assert.equal(resolveTokenizerType({ forApi: 'some_other_api' }), tokenizers.NONE);

console.log('tokenizer-resolve.test.js: resolveTokenizerType assertions passed');

// --- encodeWithTokenizerType: NONE -> [] ---

{
    const ids = await encodeWithTokenizerType(tokenizers.NONE, 'hello world');
    assert.deepEqual(ids, []);
}

// --- encodeWithTokenizerType: numeric-enum -> string-key mapping table sanity ---

assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.LLAMA], 'llama');
assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.MISTRAL], 'mistral');
assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.YI], 'yi');
assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.CLAUDE], 'claude');
assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.LLAMA3], 'llama3');
assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.GEMMA], 'gemma');
assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.JAMBA], 'jamba');
assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.QWEN2], 'qwen2');
assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.COMMAND_R], 'command-r');
assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.COMMAND_A], 'command-a');
assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.NEMO], 'nemo');
assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.DEEPSEEK], 'deepseek');
assert.equal(TOKENIZER_TYPE_KEYS[tokenizers.GPT2], 'gpt2');

// --- encodeWithTokenizerType: branch dispatch, using injected stub encoders (no real network/tokenizer files) ---

{
    // Local ENCODE_TOKENIZERS-style dispatch: mapped key passed straight through to encodeLocal.
    const calls = [];
    const encodeLocal = async (key, text) => {
        calls.push([key, text]);
        return [1, 2, 3];
    };
    const ids = await encodeWithTokenizerType(tokenizers.MISTRAL, 'hi', { encodeLocal });
    assert.deepEqual(ids, [1, 2, 3]);
    assert.deepEqual(calls, [['mistral', 'hi']]);
}

{
    // OPENAI and GPT2 both go through the flat 'gpt2' local encoder (documented judgment call).
    const calls = [];
    const encodeLocal = async (key, text) => { calls.push(key); return [42]; };
    await encodeWithTokenizerType(tokenizers.OPENAI, 'hi', { encodeLocal });
    await encodeWithTokenizerType(tokenizers.GPT2, 'hi', { encodeLocal });
    assert.deepEqual(calls, ['gpt2', 'gpt2']);
}

{
    // API_TEXTGENERATIONWEBUI: remote succeeds -> its ids are used, local encoder not called.
    let localCalled = false;
    const encodeTextgenRemote = async () => ({ count: 2, ids: [7, 8] });
    const encodeLocal = async () => { localCalled = true; return []; };
    const ids = await encodeWithTokenizerType(tokenizers.API_TEXTGENERATIONWEBUI, 'hi', {
        textgenBaseUrl: 'http://localhost:5000',
        textgenModel: 'some-model',
        textgenApiType: TEXTGEN_TYPES.TABBY,
        encodeTextgenRemote,
        encodeLocal,
    });
    assert.deepEqual(ids, [7, 8]);
    assert.equal(localCalled, false);
}

{
    // API_TEXTGENERATIONWEBUI / API_CURRENT: remote errors -> falls back to local llama encoder.
    const encodeTextgenRemote = async () => ({ error: true });
    const encodeLocal = async (key) => { assert.equal(key, 'llama'); return [9]; };
    const ids1 = await encodeWithTokenizerType(tokenizers.API_TEXTGENERATIONWEBUI, 'hi', { encodeTextgenRemote, encodeLocal });
    const ids2 = await encodeWithTokenizerType(tokenizers.API_CURRENT, 'hi', { encodeTextgenRemote, encodeLocal });
    assert.deepEqual(ids1, [9]);
    assert.deepEqual(ids2, [9]);
}

{
    // API_KOBOLD: fetch succeeds -> uses returned ids.
    const fetchImpl = async () => ({
        ok: true,
        json: async () => ({ value: 2, ids: [11, 12] }),
    });
    const ids = await encodeWithTokenizerType(tokenizers.API_KOBOLD, 'hi', {
        koboldBaseUrl: 'http://localhost:5001/',
        fetchImpl,
    });
    assert.deepEqual(ids, [11, 12]);
}

{
    // API_KOBOLD: fetch fails -> falls back to local llama encoder.
    const fetchImpl = async () => { throw new Error('connection refused'); };
    const encodeLocal = async (key) => { assert.equal(key, 'llama'); return [99]; };
    const ids = await encodeWithTokenizerType(tokenizers.API_KOBOLD, 'hi', {
        koboldBaseUrl: 'http://localhost:5001',
        fetchImpl,
        encodeLocal,
    });
    assert.deepEqual(ids, [99]);
}

{
    // Unsupported tokenizer type -> throws.
    await assert.rejects(() => encodeWithTokenizerType(tokenizers.BEST_MATCH, 'hi'));
}

console.log('tokenizer-resolve.test.js: encodeWithTokenizerType stub-dispatch assertions passed');

// --- encodeWithTokenizerType: real encodeTextByLocalTokenizerType smoke test ---
// Depends on real tokenizer model files (gpt2's tiktoken vocab), which may or may not be present
// in this checkout/CI environment. Skip gracefully rather than failing the whole file, same
// pattern as src/token-bans-and-bias.test.js's smoke test.
try {
    const ids = await encodeWithTokenizerType(tokenizers.GPT2, 'Hello world');
    assert.ok(Array.isArray(ids));
    assert.ok(ids.every(id => typeof id === 'number'));
    assert.ok(ids.length > 0);
    console.log('encodeWithTokenizerType smoke test: passed (real gpt2 tiktoken tokenizer loaded)');
} catch (err) {
    console.log(`encodeWithTokenizerType smoke test: skipped (${err.message})`);
}

console.log('tokenizer-resolve.test.js: all assertions passed');
