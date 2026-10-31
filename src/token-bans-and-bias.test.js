import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getCustomTokenBans, calculateLogitBias } from './token-bans-and-bias.js';
import { setConfigFilePath } from './util.js';

const fakeEncode = (text) => Array.from(text).map(c => c.charCodeAt(0));

{
    const result = await getCustomTokenBans({
        bannedTokensRaw: 'foo',
        globalBannedTokensRaw: 'bar',
        sendBannedTokens: false,
        bannedWordsFromMacros: ['baz'],
        encode: fakeEncode,
    });
    assert.deepEqual(result, { banned_tokens: '', banned_strings: [] });
}

{
    const result = await getCustomTokenBans({
        bannedTokensRaw: '',
        globalBannedTokensRaw: '',
        sendBannedTokens: true,
        bannedWordsFromMacros: [],
        encode: fakeEncode,
    });
    assert.deepEqual(result, { banned_tokens: '', banned_strings: [] });
}

{
    const result = await getCustomTokenBans({
        bannedTokensRaw: '[1,2,3]',
        globalBannedTokensRaw: '',
        sendBannedTokens: true,
        bannedWordsFromMacros: [],
        encode: fakeEncode,
    });
    assert.equal(result.banned_tokens, '1,2,3');
    assert.deepEqual(result.banned_strings, []);
}

{
    const result = await getCustomTokenBans({
        bannedTokensRaw: '"hello world"',
        globalBannedTokensRaw: '',
        sendBannedTokens: true,
        bannedWordsFromMacros: [],
        encode: fakeEncode,
    });
    assert.equal(result.banned_tokens, '');
    assert.deepEqual(result.banned_strings, ['hello world']);
}

{
    const result = await getCustomTokenBans({
        bannedTokensRaw: 'ab',
        globalBannedTokensRaw: '',
        sendBannedTokens: true,
        bannedWordsFromMacros: [],
        encode: fakeEncode,
    });
    assert.equal(result.banned_tokens, fakeEncode('ab').join(','));
    assert.deepEqual(result.banned_strings, []);
}

{
    const result = await getCustomTokenBans({
        bannedTokensRaw: '[1,2]\nab',
        globalBannedTokensRaw: '[2,3]\nab',
        sendBannedTokens: true,
        bannedWordsFromMacros: ['[1,2]'],
        encode: fakeEncode,
    });
    assert.equal(result.banned_tokens, [1, 2, ...fakeEncode('ab'), 3].filter((v, i, a) => a.indexOf(v) === i).join(','));
}

{
    let result;
    await assert.doesNotReject(async () => {
        result = await getCustomTokenBans({
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

{
    const result = await getCustomTokenBans({
        bannedTokensRaw: '["a", "b"]',
        globalBannedTokensRaw: '',
        sendBannedTokens: true,
        bannedWordsFromMacros: [],
        encode: fakeEncode,
    });
    assert.equal(result.banned_tokens, '');
    assert.deepEqual(result.banned_strings, []);
}

{
    assert.deepEqual(await calculateLogitBias({ logitBiasEntries: undefined, encode: fakeEncode }), {});
    assert.deepEqual(await calculateLogitBias({ logitBiasEntries: [], encode: fakeEncode }), {});
}

{
    const result = await calculateLogitBias({
        logitBiasEntries: [{ text: '{ab}', value: 5 }],
        encode: fakeEncode,
    });
    const expected = {};
    for (const t of fakeEncode('ab')) expected[String(t)] = 5;
    assert.deepEqual(result, expected);
}

{
    const result = await calculateLogitBias({
        logitBiasEntries: [{ text: '[1,2,3]', value: -2 }],
        encode: fakeEncode,
    });
    assert.deepEqual(result, { '1': -2, '2': -2, '3': -2 });
}

{
    const result = await calculateLogitBias({
        logitBiasEntries: [{ text: 'ab', value: 1 }],
        encode: fakeEncode,
    });
    const expected = {};
    for (const t of fakeEncode(' ab')) expected[String(t)] = 1;
    assert.deepEqual(result, expected);
}

console.log('token-bans-and-bias.test.js: all assertions passed');

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
