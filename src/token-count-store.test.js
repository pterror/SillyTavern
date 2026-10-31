import assert from 'node:assert/strict';
import path from 'node:path';

import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from './util.js';

setConfigFilePath(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.yaml'));

const {
    TOKEN_KEY_KINDS,
    tokenKeyHash,
    chatMessageKeyText,
    readCount,
    readIds,
    readIdsRow,
    writeBack,
    createStoredCounter,
    TOKEN_COUNT_ROW_CAP,
    LAST_USED_GRANULARITY_MS,
    PRUNE_BATCH_ROWS,
    PRUNE_PAUSE_MS,
} = await import('./token-count-store.js');
const { tokenizers, tokenizerIdentity } = await import('./tokenizer-resolve.js');
const { countChatCompletionMessages } = await import('./endpoints/tokenizers.js');
const { TABLE } = await import('./token-cache-engine.js');
const { convertedUser } = await import('../tests/converted-user.fixture.js');

const user = await convertedUser('token-count-store-test-');
const directories = user.directories;
const { store } = user;

async function counted() {
    return {
        counts: await store.lib.store.chatRead('tokenCacheCount', { table: TABLE.counts }),
        ids: await store.lib.store.chatRead('tokenCacheCount', { table: TABLE.ids }),
    };
}

/**
 * @param {number} table
 * @param {string} identity
 * @param {string} hash
 */
async function usedAt(table, identity, hash) {
    return (await store.tokens.read(table, identity, hash))?.used;
}

const fakeTokenize = { fail: false, contents: /** @type {string[]} */ ([]), withPieces: /** @type {boolean[]} */ ([]) };
const fakeServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
        if (req.url !== '/tokenize') {
            res.writeHead(404).end();
            return;
        }
        const parsed = JSON.parse(body);
        const content = String(parsed.content);
        fakeTokenize.contents.push(content);
        fakeTokenize.withPieces.push(parsed.with_pieces === true);
        if (fakeTokenize.fail) {
            res.writeHead(500).end();
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const bytes = Array.from(Buffer.from(content));
        res.end(JSON.stringify({ tokens: parsed.with_pieces ? bytes.map((byte, id) => ({ id, piece: [byte] })) : bytes.map((_, id) => id) }));
    });
});
fakeServer.listen(0, '127.0.0.1');
await new Promise(resolve => fakeServer.once('listening', resolve));
const fakeUrl = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (fakeServer.address()).port}`;
const tokenizerCalls = () => fakeTokenize.contents.length;
const resetFake = () => { fakeTokenize.fail = false; fakeTokenize.contents.length = 0; fakeTokenize.withPieces.length = 0; };

try {
    const hello = 'Hello world';
    const textHash = tokenKeyHash(TOKEN_KEY_KINDS.TEXT, hello);
    assert.match(textHash, /^[0-9a-f]{64}$/, 'sha256 hex');
    assert.equal(textHash, tokenKeyHash(TOKEN_KEY_KINDS.TEXT, hello), 'the same text gives the same key');
    assert.notEqual(textHash, tokenKeyHash(TOKEN_KEY_KINDS.PROMPT, hello), 'with BOS is another key');
    assert.notEqual(textHash, tokenKeyHash(TOKEN_KEY_KINDS.IDS, hello), 'ids are another key');
    assert.notEqual(textHash, tokenKeyHash(TOKEN_KEY_KINDS.TEXT, `${hello} `), 'any change in the text is another key');
    assert.throws(() => tokenKeyHash('bogus', hello), /kind/);

    const messages = [{ role: 'user', content: hello }];
    const ccTurbo = tokenKeyHash(TOKEN_KEY_KINDS.CC_MESSAGE, chatMessageKeyText('gpt-3.5-turbo-0301', messages));
    const ccGpt4 = tokenKeyHash(TOKEN_KEY_KINDS.CC_MESSAGE, chatMessageKeyText('gpt-4', messages));
    assert.notEqual(ccTurbo, ccGpt4, 'another model is another key');
    assert.notEqual(ccGpt4, tokenKeyHash(TOKEN_KEY_KINDS.CC_MESSAGE, chatMessageKeyText('gpt-4', [{ role: 'system', content: hello }])), 'another role is another key');
    assert.equal(chatMessageKeyText(undefined, messages), chatMessageKeyText(null, messages), 'no model is one key');

    const idA = 'file:sentencepiece:aaaa';
    const idB = 'file:sentencepiece:bbbb';
    const idsHash = tokenKeyHash(TOKEN_KEY_KINDS.IDS, hello);
    assert.equal(await readCount(directories, idA, textHash), null);
    assert.equal(await readIds(directories, idA, idsHash), null);
    const empty = await counted();
    assert.deepEqual(await counted(), empty, 'a read writes nothing');

    await writeBack(directories, {
        counts: [{ identity: idA, hash: textHash, count: 3 }, { identity: idA, hash: ccGpt4, count: 11 }],
        ids: [{ identity: idA, hash: idsHash, ids: Uint32Array.from([15496, 995]) }],
    }, 1000);
    assert.equal(await readCount(directories, idA, textHash), 3);
    assert.equal(await readCount(directories, idA, ccGpt4), 11);
    assert.deepEqual(await readIds(directories, idA, idsHash), [15496, 995]);

    assert.equal(await readCount(directories, idB, textHash), null, 'another tokenizer');
    assert.equal(await readIds(directories, idB, idsHash), null, 'another tokenizer');
    assert.equal(await readCount(directories, idA, tokenKeyHash(TOKEN_KEY_KINDS.PROMPT, hello)), null, 'another kind');
    assert.equal(await readCount(directories, idA, ccTurbo), null, 'another model');
    assert.equal(await readCount(directories, idA, idsHash), null, 'ids are not a count');
    assert.equal(await readIds(directories, idA, textHash), null, 'a count is not ids');

    assert.deepEqual(await counted(), { counts: empty.counts + 2, ids: empty.ids + 1 });
    assert.equal(await usedAt(TABLE.counts, idA, textHash), 1000);
    assert.equal(await usedAt(TABLE.counts, idA, ccGpt4), 1000);

    const DAY = LAST_USED_GRANULARITY_MS;
    assert.equal(DAY, 24 * 60 * 60 * 1000);
    await writeBack(directories, { counts: [{ identity: idA, hash: textHash, count: 3 }], ids: [{ identity: idA, hash: idsHash, ids: [15496, 995] }] }, 1000 + DAY - 1);
    assert.equal(await usedAt(TABLE.counts, idA, textHash), 1000, 'reused within a day: not marked');
    assert.equal(await usedAt(TABLE.ids, idA, idsHash), 1000);

    await writeBack(directories, { counts: [{ identity: idA, hash: textHash, count: 3 }], ids: [{ identity: idA, hash: idsHash, ids: [15496, 995] }] }, 1000 + DAY);
    assert.deepEqual(await counted(), { counts: empty.counts + 2, ids: empty.ids + 1 }, 'no entry added');
    assert.equal(await usedAt(TABLE.counts, idA, textHash), 1000 + DAY, 'marked used');
    assert.equal(await usedAt(TABLE.counts, idA, ccGpt4), 1000, 'an entry not written is untouched');
    assert.equal(await usedAt(TABLE.ids, idA, idsHash), 1000 + DAY);
    assert.equal(await readCount(directories, idA, textHash), 3);
    assert.deepEqual(await readIds(directories, idA, idsHash), [15496, 995]);

    await writeBack(directories, { counts: [{ identity: idA, hash: textHash, count: 99 }] }, 2000 + DAY);
    assert.equal(await readCount(directories, idA, textHash), 3);

    await writeBack(directories, {
        counts: [
            { identity: idA, hash: textHash, count: 3 },
            { identity: idB, hash: textHash, count: 4 },
            { identity: idB, hash: ccTurbo, count: 12 },
            { identity: idB, hash: ccTurbo, count: 12 },
        ],
    }, 3000 + DAY);
    assert.deepEqual(await counted(), { counts: empty.counts + 4, ids: empty.ids + 1 }, 'the two keys new to the table');
    assert.equal(await readCount(directories, idB, textHash), 4);

    const before = await counted();
    assert.deepEqual(await writeBack(directories, { counts: [], ids: [] }, 4000 + DAY), { prunesScheduled: [] });
    await writeBack(directories, {}, 4000 + DAY);
    assert.deepEqual(await counted(), before);

    const storedDirs = directories;
    const gpt4 = { id: tokenizers.OPENAI, model: 'gpt-4', name: 'OpenAI' };
    const llamaCpp = (localCopy = null) => ({
        kind: /** @type {const} */ ('remote'),
        id: tokenizers.API_TEXTGENERATIONWEBUI,
        name: 'API (Text Completion)',
        basis: /** @type {const} */ ('remote'),
        model: 'test-model',
        llamaCpp: { url: fakeUrl, model: 'test-model', headers: {} },
        localCopy,
    });
    const llamaIdentity = 'llamacpp:["/models/test.gguf","b1"]';
    const bytes = text => Buffer.byteLength(text);
    const byteIds = text => Array.from(Buffer.from(text)).map((_, id) => id);
    const t1 = 'The first text';
    const t2 = 'Another text';
    const m1 = [{ role: 'user', content: t1 }];
    const m1Bytes = bytes(`user\n\n${t1}`);

    {
        resetFake();
        const counter = createStoredCounter({ resolved: llamaCpp(), identity: null, directories: storedDirs });
        for (let i = 0; i < 2; i++) {
            assert.equal(await counter.countText(t1), bytes(t1));
            assert.equal(await counter.countPromptText(t1), bytes(t1));
            assert.deepEqual(await counter.encodeText(t1), byteIds(t1));
            assert.equal(await counter.countChatMessage(m1), m1Bytes);
        }
        assert.equal(tokenizerCalls(), 8, 'every call asks the tokenizer');
        assert.deepEqual(counter.pending, { counts: [], ids: [] });
    }

    const expectedRows = {
        counts: [
            { identity: llamaIdentity, hash: tokenKeyHash(TOKEN_KEY_KINDS.TEXT, t1), count: bytes(t1) },
            { identity: llamaIdentity, hash: tokenKeyHash(TOKEN_KEY_KINDS.TEXT, t2), count: bytes(t2) },
            { identity: llamaIdentity, hash: tokenKeyHash(TOKEN_KEY_KINDS.PROMPT, t1), count: bytes(t1) },
            { identity: llamaIdentity, hash: tokenKeyHash(TOKEN_KEY_KINDS.CC_MESSAGE, chatMessageKeyText('test-model', m1)), count: m1Bytes },
        ],
        ids: [
            { identity: llamaIdentity, hash: tokenKeyHash(TOKEN_KEY_KINDS.IDS, t1), ids: byteIds(t1) },
        ],
    };
    const countAll = async counter => {
        for (let i = 0; i < 2; i++) {
            assert.equal(await counter.countText(t1), bytes(t1));
            assert.equal(await counter.countText(t2), bytes(t2));
        }
        for (let i = 0; i < 2; i++) assert.equal(await counter.countPromptText(t1), bytes(t1));
        for (let i = 0; i < 2; i++) assert.deepEqual(Array.from(await counter.encodeText(t1)), byteIds(t1));
        for (let i = 0; i < 2; i++) assert.equal(await counter.countChatMessage(m1), m1Bytes);
    };
    {
        resetFake();
        const first = createStoredCounter({ resolved: llamaCpp(), identity: llamaIdentity, directories: storedDirs });
        await countAll(first);
        assert.deepEqual(fakeTokenize.contents, [t1, t2, t1, t1, `user\n\n${t1}`], 'once per distinct text and kind');
        assert.deepEqual(first.pending, expectedRows, 'one row per distinct text and kind; a count and a prompt count are two');

        await writeBack(storedDirs, first.pending);
        resetFake();
        const second = createStoredCounter({ resolved: llamaCpp(), identity: llamaIdentity, directories: storedDirs });
        await countAll(second);
        assert.equal(tokenizerCalls(), 0, 'every value read from the tables');
        assert.deepEqual(second.pending, expectedRows, 'the rows read are pending, so write-back marks them used');

        const other = createStoredCounter({ resolved: llamaCpp(), identity: 'llamacpp:["/models/test.gguf","b2"]', directories: storedDirs });
        assert.equal(await other.countText(t1), bytes(t1));
        assert.equal(await other.encodeText(t1).then(ids => ids.length), bytes(t1));
        assert.equal(tokenizerCalls(), 2, 'another identity asks the tokenizer');
        assert.deepEqual(other.pending.counts.map(row => row.identity), ['llamacpp:["/models/test.gguf","b2"]']);
    }

    {
        resetFake();
        const recounter = createStoredCounter({ resolved: llamaCpp(), identity: llamaIdentity, directories: storedDirs, recount: true });
        assert.equal(await recounter.countText(t1), bytes(t1));
        assert.deepEqual(Array.from(await recounter.encodeText(t1)), byteIds(t1));
        assert.equal(tokenizerCalls(), 1, 'the count is taken again; the ids are read');
        assert.equal(recounter.pending.counts[0].replace, true);
        await writeBack(storedDirs, { counts: [{ ...recounter.pending.counts[0], count: 12345 }] });
        const after = createStoredCounter({ resolved: llamaCpp(), identity: llamaIdentity, directories: storedDirs });
        assert.equal(await after.countText(t1), 12345, 'the recounted value replaced the stored one');
        await writeBack(storedDirs, { counts: [{ ...recounter.pending.counts[0] }] });
    }

    {
        resetFake();
        const pending = { counts: [], ids: [] };
        const a = createStoredCounter({ resolved: llamaCpp(), identity: 'shared-a', directories: storedDirs, pending });
        const b = createStoredCounter({ resolved: llamaCpp(), identity: 'shared-b', directories: storedDirs, pending });
        assert.equal(a.pending, pending);
        await a.countText(t1);
        await b.countText(t1);
        assert.deepEqual(pending.counts.map(row => row.identity), ['shared-a', 'shared-b']);
    }

    {
        resetFake();
        fakeTokenize.fail = true;
        const identityFacts = {};
        const copyIdentity = await tokenizerIdentity(gpt4, identityFacts);
        assert.ok(copyIdentity, 'tiktoken has an identity');
        const counter = createStoredCounter({ resolved: llamaCpp(gpt4), identity: llamaIdentity, directories: storedDirs, identityFacts });
        const t3 = 'Counted by the copy';
        const m3 = [{ role: 'user', content: t3 }];
        const count = await counter.countText(t3);
        const ids = await counter.encodeText(t3);
        const messagesCount = await counter.countChatMessage(m3);
        assert.equal(tokenizerCalls(), 3, 'the remote was tried each time');
        assert.equal(count, ids.length);
        assert.equal(messagesCount, await countChatCompletionMessages({ kind: 'local', ...gpt4, basis: 'local', localCopy: null }, m3));
        assert.deepEqual(counter.pending, {
            counts: [
                { identity: copyIdentity, hash: tokenKeyHash(TOKEN_KEY_KINDS.TEXT, t3), count },
                { identity: copyIdentity, hash: tokenKeyHash(TOKEN_KEY_KINDS.CC_MESSAGE, chatMessageKeyText('gpt-4', m3)), count: messagesCount },
            ],
            ids: [{ identity: copyIdentity, hash: tokenKeyHash(TOKEN_KEY_KINDS.IDS, t3), ids: Array.from(ids) }],
        });
    }

    {
        resetFake();
        fakeTokenize.fail = true;
        const noCopy = createStoredCounter({ resolved: llamaCpp(), identity: llamaIdentity, directories: storedDirs });
        const t4 = 'No tokenizer answers';
        assert.equal(typeof await noCopy.countText(t4), 'number', 'the estimate');
        assert.equal(await noCopy.encodeText(t4), null);
        assert.equal(typeof await noCopy.countChatMessage([{ role: 'user', content: t4 }]), 'number', 'the estimate');
        const withCopy = createStoredCounter({ resolved: llamaCpp(gpt4), identity: llamaIdentity, directories: storedDirs });
        assert.equal(typeof await withCopy.countPromptText(t4), 'number');
        assert.deepEqual(noCopy.pending, { counts: [], ids: [] });
        assert.deepEqual(withCopy.pending, { counts: [], ids: [] });

        const estimate = { kind: /** @type {const} */ ('estimate'), id: tokenizers.NONE, name: 'Estimate', basis: /** @type {const} */ ('unknown'), localCopy: null };
        const estimated = createStoredCounter({ resolved: estimate, identity: 'given-anyway', directories: storedDirs });
        await estimated.countText(t4);
        await estimated.countChatMessage([{ role: 'user', content: t4 }]);
        assert.deepEqual(estimated.pending, { counts: [], ids: [] }, 'an estimate resolution');

        const nullIds = createStoredCounter({
            resolved: llamaCpp(), identity: llamaIdentity, directories: storedDirs,
            encode: async (_text, answeredOut) => { answeredOut.tokenizer = null; return null; },
        });
        assert.equal(await nullIds.encodeText(t4), null);
        assert.deepEqual(nullIds.pending, { counts: [], ids: [] }, 'an encode giving null');
    }

    {
        const tiktokenIdentity = 'tiktoken:cl100k_base@test';
        const m5 = [{ role: 'user', content: 'Same messages, other model' }];
        const asGpt4 = { kind: /** @type {const} */ ('local'), ...gpt4, basis: /** @type {const} */ ('local'), localCopy: null };
        const asTurbo = { ...asGpt4, model: 'gpt-3.5-turbo-0301' };
        const first = createStoredCounter({ resolved: asGpt4, identity: tiktokenIdentity, directories: storedDirs });
        const gpt4Count = await first.countChatMessage(m5);
        await writeBack(storedDirs, first.pending);
        const second = createStoredCounter({ resolved: asTurbo, identity: tiktokenIdentity, directories: storedDirs });
        const turboCount = await second.countChatMessage(m5);
        assert.notEqual(turboCount, gpt4Count, 'the models count the messages differently');
        assert.equal(turboCount, await countChatCompletionMessages(asTurbo, m5), 'counted, not read');
        assert.notEqual(second.pending.counts[0].hash, first.pending.counts[0].hash);
    }

    {
        const copyIdentity = await tokenizerIdentity(gpt4, {});
        /** @type {Array<[string, unknown]>} */
        const calls = [];
        const resolved = llamaCpp(gpt4);
        const encode = async (text, answeredOut) => {
            calls.push(['encode', text]);
            answeredOut.tokenizer = gpt4;
            return Uint32Array.from([7, 8]);
        };
        const countMessages = async (messages, answeredOut) => {
            calls.push(['countMessages', messages]);
            answeredOut.tokenizer = resolved;
            return 42;
        };
        const m6 = [{ role: 'user', content: 'Overridden' }];

        const unstored = createStoredCounter({ resolved, identity: null, directories: storedDirs, encode, countMessages });
        assert.deepEqual(Array.from(await unstored.encodeText('six')), [7, 8]);
        assert.equal(await unstored.encodeText('six').then(ids => ids.length), 2);
        assert.equal(await unstored.countChatMessage(m6), 42);
        assert.equal(await unstored.countChatMessage(m6), 42);
        assert.deepEqual(calls.map(([name]) => name), ['encode', 'encode', 'countMessages', 'countMessages'], 'identity null: every call');
        assert.deepEqual(unstored.pending, { counts: [], ids: [] });

        calls.length = 0;
        const stored = createStoredCounter({ resolved, identity: 'overrides', directories: storedDirs, encode, countMessages });
        const ids = await stored.encodeText('six');
        assert.ok(ids instanceof Uint32Array, 'a miss returns what the encoder gave');
        await stored.encodeText('six');
        assert.equal(await stored.countChatMessage(m6), 42);
        await stored.countChatMessage(m6);
        assert.deepEqual(calls, [['encode', 'six'], ['encode', 'six'], ['countMessages', m6]]);
        assert.deepEqual(stored.pending, {
            counts: [{ identity: 'overrides', hash: tokenKeyHash(TOKEN_KEY_KINDS.CC_MESSAGE, chatMessageKeyText('test-model', m6)), count: 42 }],
            ids: [{ identity: copyIdentity, hash: tokenKeyHash(TOKEN_KEY_KINDS.IDS, 'six'), ids: [7, 8] }],
        }, 'the copy\'s answer under the copy\'s identity, the resolution\'s under the given one');
        assert.ok(Array.isArray(stored.pending.ids[0].ids));

        const byCopy = createStoredCounter({
            resolved, identity: 'overrides', directories: storedDirs,
            countMessages: async (_messages, answeredOut) => { answeredOut.tokenizer = gpt4; return 5; },
        });
        await byCopy.countChatMessage(m6);
        assert.deepEqual(byCopy.pending.counts, [
            { identity: copyIdentity, hash: tokenKeyHash(TOKEN_KEY_KINDS.CC_MESSAGE, chatMessageKeyText('gpt-4', m6)), count: 5 },
        ]);
    }

    const chunksDirs = directories;
    const idC = 'llamacpp:["/models/c.gguf","b1"]';
    const hashAe = tokenKeyHash(TOKEN_KEY_KINDS.IDS, 'aé');
    {
        await writeBack(chunksDirs, { ids: [{ identity: idC, hash: hashAe, ids: [0, 1, 2] }] }, 1000);
        assert.deepEqual(await readIdsRow(chunksDirs, idC, hashAe), { ids: [0, 1, 2], chunks: null }, 'a row stored without chunks');
        assert.deepEqual(await readIds(chunksDirs, idC, hashAe), [0, 1, 2]);

        await writeBack(chunksDirs, { ids: [{ identity: idC, hash: hashAe, ids: [0, 1, 2], chunks: ['a', 'é'] }] }, 2000);
        assert.deepEqual(await readIdsRow(chunksDirs, idC, hashAe), { ids: [0, 1, 2], chunks: ['a', 'é'] }, 'a row without chunks gets them');

        await writeBack(chunksDirs, { ids: [{ identity: idC, hash: hashAe, ids: [0, 1, 2], chunks: ['x'] }] }, 3000);
        await writeBack(chunksDirs, { ids: [{ identity: idC, hash: hashAe, ids: [0, 1, 2] }] }, 1000 + LAST_USED_GRANULARITY_MS);
        assert.deepEqual(await readIdsRow(chunksDirs, idC, hashAe), { ids: [0, 1, 2], chunks: ['a', 'é'] }, 'a row with chunks keeps them');

        const hashB = tokenKeyHash(TOKEN_KEY_KINDS.IDS, 'b');
        await writeBack(chunksDirs, { ids: [{ identity: idC, hash: hashB, ids: [0], chunks: ['b'] }] }, 5000);
        assert.deepEqual(await readIdsRow(chunksDirs, idC, hashB), { ids: [0], chunks: ['b'] }, 'a new row with chunks');
        assert.equal(await readIdsRow(chunksDirs, 'another', hashB), null);
    }

    {
        const counterDirs = directories;
        const counter = () => createStoredCounter({ resolved: llamaCpp(), identity: llamaIdentity, directories: counterDirs });

        resetFake();
        const first = counter();
        assert.deepEqual(await first.encodeTextWithChunks('aé'), { ids: [0, 1, 2], chunks: ['a', 'é'] });
        assert.deepEqual(await first.encodeTextWithChunks('aé'), { ids: [0, 1, 2], chunks: ['a', 'é'] });
        assert.deepEqual(fakeTokenize.withPieces, [true], 'asked once, with pieces');
        assert.deepEqual(first.pending, { counts: [], ids: [{ identity: llamaIdentity, hash: hashAe, ids: [0, 1, 2], chunks: ['a', 'é'] }] });
        await writeBack(counterDirs, first.pending);

        resetFake();
        const second = counter();
        assert.deepEqual(await second.encodeTextWithChunks('aé'), { ids: [0, 1, 2], chunks: ['a', 'é'] }, 'from the table');
        assert.equal(tokenizerCalls(), 0);
        assert.deepEqual(second.pending.ids, [{ identity: llamaIdentity, hash: hashAe, ids: [0, 1, 2] }], 'pending, so write-back marks it used');

        resetFake();
        const plain = counter();
        assert.deepEqual(await plain.encodeText('bé'), [0, 1, 2]);
        await writeBack(counterDirs, plain.pending);
        resetFake();
        const needsChunks = counter();
        assert.deepEqual(await needsChunks.encodeTextWithChunks('bé'), { ids: [0, 1, 2], chunks: ['b', 'é'] });
        assert.deepEqual(fakeTokenize.withPieces, [true], 'asked again, with pieces');
        await writeBack(counterDirs, needsChunks.pending);
        assert.deepEqual(await readIdsRow(counterDirs, llamaIdentity, tokenKeyHash(TOKEN_KEY_KINDS.IDS, 'bé')), { ids: [0, 1, 2], chunks: ['b', 'é'] }, 'the row got its chunks');

        resetFake();
        const both = counter();
        await both.encodeText('cé');
        assert.deepEqual(await both.encodeTextWithChunks('cé'), { ids: [0, 1, 2], chunks: ['c', 'é'] });
        assert.deepEqual(fakeTokenize.withPieces, [false, true]);
        assert.deepEqual(await both.encodeText('cé'), [0, 1, 2]);
        assert.equal(tokenizerCalls(), 2, 'ids with chunks answer a plain encode');

        resetFake();
        fakeTokenize.fail = true;
        const byCopy = createStoredCounter({ resolved: llamaCpp(gpt4), identity: llamaIdentity, directories: counterDirs });
        const copied = await byCopy.encodeTextWithChunks('dé');
        assert.deepEqual(copied, { ids: Array.from(await createStoredCounter({ resolved: { kind: 'local', ...gpt4, basis: 'local', localCopy: null }, identity: null, directories: counterDirs }).encodeText('dé')), chunks: null });
        assert.deepEqual(byCopy.pending.ids.map(row => [row.identity, row.chunks]), [[await tokenizerIdentity(gpt4), null]]);

        resetFake();
        const unstored = createStoredCounter({ resolved: llamaCpp(), identity: null, directories: counterDirs });
        assert.deepEqual(await unstored.encodeTextWithChunks('aé'), { ids: [0, 1, 2], chunks: ['a', 'é'] });
        await unstored.encodeTextWithChunks('aé');
        assert.deepEqual(fakeTokenize.withPieces, [true, true]);
        assert.deepEqual(unstored.pending, { counts: [], ids: [] });

        const local = createStoredCounter({ resolved: { kind: 'local', ...gpt4, basis: 'local', localCopy: null }, identity: 'tiktoken-test', directories: counterDirs });
        const localEncoded = await local.encodeTextWithChunks('aé');
        assert.deepEqual(Object.keys(localEncoded), ['ids']);
        assert.deepEqual(local.pending.ids.map(row => Object.keys(row)), [['identity', 'hash', 'ids']]);
    }

    assert.equal(TOKEN_COUNT_ROW_CAP, 1_000_000);
    assert.equal(PRUNE_BATCH_ROWS, 5000);
    assert.equal(PRUNE_PAUSE_MS, 50);
} finally {
    fakeServer.close();
    await user.close();
}

console.log('token-count-store.test.js: all assertions passed');
