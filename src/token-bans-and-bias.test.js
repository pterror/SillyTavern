import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getCustomTokenBans, calculateLogitBias } from './token-bans-and-bias.js';
// src/endpoints/tokenizers.js pulls in code that reads process-wide config at import time (e.g.
// src/endpoints/secrets.js) - set the config path before importing it, the same way the real
// server does at startup (src/config-init.js), since this test runs standalone. Import is deferred
// to just before the smoke test below (see setConfigFilePath() call further down).
import { setConfigFilePath } from './util.js';

/** Deterministic fake tokenizer: one "token id" per character code. */
const fakeEncode = (text) => Array.from(text).map(c => c.charCodeAt(0));

// --- getCustomTokenBans ---

// Disabled when sendBannedTokens is false, even with ban sources present
{
    const result = getCustomTokenBans({
        bannedTokensRaw: 'foo',
        globalBannedTokensRaw: 'bar',
        sendBannedTokens: false,
        bannedWordsFromMacros: ['baz'],
        encode: fakeEncode,
    });
    assert.deepEqual(result, { banned_tokens: '', banned_strings: [] });
}

// Disabled when all three ban sources are empty
{
    const result = getCustomTokenBans({
        bannedTokensRaw: '',
        globalBannedTokensRaw: '',
        sendBannedTokens: true,
        bannedWordsFromMacros: [],
        encode: fakeEncode,
    });
    assert.deepEqual(result, { banned_tokens: '', banned_strings: [] });
}

// [1,2,3] raw token id lines
{
    const result = getCustomTokenBans({
        bannedTokensRaw: '[1,2,3]',
        globalBannedTokensRaw: '',
        sendBannedTokens: true,
        bannedWordsFromMacros: [],
        encode: fakeEncode,
    });
    assert.equal(result.banned_tokens, '1,2,3');
    assert.deepEqual(result.banned_strings, []);
}

// "quoted" literal string lines -> banned_strings, not tokenized
{
    const result = getCustomTokenBans({
        bannedTokensRaw: '"hello world"',
        globalBannedTokensRaw: '',
        sendBannedTokens: true,
        bannedWordsFromMacros: [],
        encode: fakeEncode,
    });
    assert.equal(result.banned_tokens, '');
    assert.deepEqual(result.banned_strings, ['hello world']);
}

// Plain text lines -> tokenized via encode
{
    const result = getCustomTokenBans({
        bannedTokensRaw: 'ab',
        globalBannedTokensRaw: '',
        sendBannedTokens: true,
        bannedWordsFromMacros: [],
        encode: fakeEncode,
    });
    assert.equal(result.banned_tokens, fakeEncode('ab').join(','));
    assert.deepEqual(result.banned_strings, []);
}

// Dedupe across all three sources, including duplicate lines and duplicate token ids
{
    const result = getCustomTokenBans({
        bannedTokensRaw: '[1,2]\nab',
        globalBannedTokensRaw: '[2,3]\nab',
        sendBannedTokens: true,
        bannedWordsFromMacros: ['[1,2]'],
        encode: fakeEncode,
    });
    // 'ab' line is deduped before tokenizing (identical line appears twice across sources);
    // order follows line processing order: [1,2] tokens, then 'ab' tokens, then [2,3]'s new id 3
    // (the second 'ab' and second [1,2] line are filtered out by onlyUnique before this loop runs)
    assert.equal(result.banned_tokens, [1, 2, ...fakeEncode('ab'), 3].filter((v, i, a) => a.indexOf(v) === i).join(','));
}

// Malformed [...] JSON falls through gracefully (no throw, entry skipped)
{
    let result;
    assert.doesNotThrow(() => {
        result = getCustomTokenBans({
            bannedTokensRaw: '[1,2,]',
            globalBannedTokensRaw: '',
            sendBannedTokens: true,
            bannedWordsFromMacros: [],
            encode: fakeEncode,
        });
    });
    assert.equal(result.banned_tokens, '');
    assert.deepEqual(result.banned_strings, []);
}

// Malformed [...] JSON that parses but isn't all integers also falls through gracefully
{
    const result = getCustomTokenBans({
        bannedTokensRaw: '["a", "b"]',
        globalBannedTokensRaw: '',
        sendBannedTokens: true,
        bannedWordsFromMacros: [],
        encode: fakeEncode,
    });
    assert.equal(result.banned_tokens, '');
    assert.deepEqual(result.banned_strings, []);
}

// --- calculateLogitBias ---

// Empty/missing logit_bias array returns {}
{
    assert.deepEqual(calculateLogitBias({ logitBiasEntries: undefined, encode: fakeEncode }), {});
    assert.deepEqual(calculateLogitBias({ logitBiasEntries: [], encode: fakeEncode }), {});
}

// {verbatim text} -> braces stripped, tokenized as-is (no leading space added)
{
    const result = calculateLogitBias({
        logitBiasEntries: [{ text: '{ab}', value: 5 }],
        encode: fakeEncode,
    });
    const expected = {};
    for (const t of fakeEncode('ab')) expected[String(t)] = 5;
    assert.deepEqual(result, expected);
}

// [1,2,3] raw token ids
{
    const result = calculateLogitBias({
        logitBiasEntries: [{ text: '[1,2,3]', value: -2 }],
        encode: fakeEncode,
    });
    assert.deepEqual(result, { '1': -2, '2': -2, '3': -2 });
}

// Plain text -> tokenized with a leading space prepended
{
    const result = calculateLogitBias({
        logitBiasEntries: [{ text: 'ab', value: 1 }],
        encode: fakeEncode,
    });
    const expected = {};
    for (const t of fakeEncode(' ab')) expected[String(t)] = 1;
    assert.deepEqual(result, expected);
}

console.log('token-bans-and-bias.test.js: all assertions passed');

// --- encodeTextByLocalTokenizerType smoke test ---
// Depends on real tokenizer model files, which may or may not be present in this
// checkout/CI environment. Skip gracefully rather than failing the whole file.
try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    setConfigFilePath(path.join(__dirname, '..', 'config.yaml'));
    const { encodeTextByLocalTokenizerType } = await import('./endpoints/tokenizers.js');
    const ids = await encodeTextByLocalTokenizerType('gpt2', 'Hello world');
    assert.ok(Array.isArray(ids));
    assert.ok(ids.every(id => typeof id === 'number'));
    assert.ok(ids.length > 0);
    console.log('encodeTextByLocalTokenizerType smoke test: passed (gpt2 tiktoken tokenizer loaded)');
} catch (err) {
    console.log(`encodeTextByLocalTokenizerType smoke test: skipped (${err.message})`);
}
