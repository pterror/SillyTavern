import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { disposeMessageTreeStores } from './message-tree-db.js';
import { getSqliteEngine } from './endpoints/sqlite-engine.js';
// token-count-store.js imports tokenizer-resolve.js, whose import chain reads process-wide config at import
// time (src/endpoints/secrets.js), so the config path is set first and the module imported after it.
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
    pruneBatch,
    pruneTokenTable,
    startTokenCountMaintenance,
    tokenCountMaintenanceIdle,
} = await import('./token-count-store.js');
const { tokenizers, tokenizerIdentity } = await import('./tokenizer-resolve.js');
const { countChatCompletionMessages } = await import('./endpoints/tokenizers.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'token-count-store-test-'));
const directories = { root: tmpRoot };
const storedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'token-count-store-test-'));
const chunksRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'token-count-store-test-'));
const oldRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'token-count-store-test-'));
const pruneRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'token-count-store-test-'));

/**
 * Reads the rows and the running counts straight from the file, on a handle of its own.
 * @param {string} [root]
 */
async function inspect(root = tmpRoot) {
    const engine = await getSqliteEngine();
    const db = engine.openDatabase(path.join(root, 'message-tree.sqlite'));
    try {
        const rows = table => db.readBounded(`SELECT identity, text_hash, last_used FROM ${table} ORDER BY identity, text_hash`, [], 100);
        const running = key => {
            const row = /** @type {{ value: string } | undefined} */ (db.get('SELECT value FROM meta WHERE key = @key', { key }));
            return row === undefined ? undefined : Number(row.value);
        };
        return {
            counts: rows('token_counts'),
            ids: rows('token_ids'),
            countsRunning: running('token_counts_rows'),
            idsRunning: running('token_ids_rows'),
        };
    } finally {
        db.close();
    }
}

// A fake llama.cpp `/tokenize`: one token per UTF-8 byte, ids 0..n-1, or 500 when `fakeTokenize.fail`. With
// `with_pieces`, each token's piece is its byte as a list, as llama.cpp gives a piece that isn't valid UTF-8.
// Every request is recorded, so a test counts the tokenizer calls a counter made.
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
    // --- keys: the kind and everything the result depends on besides the tokenizer ---
    const hello = 'Hello world';
    const textHash = tokenKeyHash(TOKEN_KEY_KINDS.TEXT, hello);
    assert.match(textHash, /^[0-9a-f]{64}$/, 'sha256 hex');
    assert.equal(textHash, tokenKeyHash(TOKEN_KEY_KINDS.TEXT, hello), 'the same text gives the same key');
    assert.notEqual(textHash, tokenKeyHash(TOKEN_KEY_KINDS.PROMPT, hello), 'with BOS is another key');
    assert.notEqual(textHash, tokenKeyHash(TOKEN_KEY_KINDS.IDS, hello), 'ids are another key');
    assert.notEqual(textHash, tokenKeyHash(TOKEN_KEY_KINDS.TEXT, `${hello} `), 'any change in the text is another key');
    assert.throws(() => tokenKeyHash('bogus', hello), /kind/);

    // A chat-completion message count adds per-message overhead that depends on the model
    // (gpt-3.5-turbo-0301 vs gpt-4, both cl100k_base), so the model is part of its key.
    const messages = [{ role: 'user', content: hello }];
    const ccTurbo = tokenKeyHash(TOKEN_KEY_KINDS.CC_MESSAGE, chatMessageKeyText('gpt-3.5-turbo-0301', messages));
    const ccGpt4 = tokenKeyHash(TOKEN_KEY_KINDS.CC_MESSAGE, chatMessageKeyText('gpt-4', messages));
    assert.notEqual(ccTurbo, ccGpt4, 'another model is another key');
    assert.notEqual(ccGpt4, tokenKeyHash(TOKEN_KEY_KINDS.CC_MESSAGE, chatMessageKeyText('gpt-4', [{ role: 'system', content: hello }])), 'another role is another key');
    assert.equal(chatMessageKeyText(undefined, messages), chatMessageKeyText(null, messages), 'no model is one key');

    // --- nothing stored: a miss ---
    const idA = 'file:sentencepiece:aaaa';
    const idB = 'file:sentencepiece:bbbb';
    const idsHash = tokenKeyHash(TOKEN_KEY_KINDS.IDS, hello);
    assert.equal(await readCount(directories, idA, textHash), null);
    assert.equal(await readIds(directories, idA, idsHash), null);
    let state = await inspect();
    assert.equal(state.counts.length, 0);
    assert.equal(state.countsRunning, undefined, 'a read writes nothing');

    // --- a written count and ids array read back under their identity and hash ---
    await writeBack(directories, {
        counts: [{ identity: idA, hash: textHash, count: 3 }, { identity: idA, hash: ccGpt4, count: 11 }],
        ids: [{ identity: idA, hash: idsHash, ids: Uint32Array.from([15496, 995]) }],
    }, 1000);
    assert.equal(await readCount(directories, idA, textHash), 3);
    assert.equal(await readCount(directories, idA, ccGpt4), 11);
    assert.deepEqual(await readIds(directories, idA, idsHash), [15496, 995]);

    // ...and not under another identity or another kind.
    assert.equal(await readCount(directories, idB, textHash), null, 'another tokenizer');
    assert.equal(await readIds(directories, idB, idsHash), null, 'another tokenizer');
    assert.equal(await readCount(directories, idA, tokenKeyHash(TOKEN_KEY_KINDS.PROMPT, hello)), null, 'another kind');
    assert.equal(await readCount(directories, idA, ccTurbo), null, 'another model');
    assert.equal(await readCount(directories, idA, idsHash), null, 'ids are not a count');
    assert.equal(await readIds(directories, idA, textHash), null, 'a count is not ids');

    // --- inserting rows raises the running count by that many ---
    state = await inspect();
    assert.equal(state.counts.length, 2);
    assert.equal(state.countsRunning, 2);
    assert.equal(state.ids.length, 1);
    assert.equal(state.idsRunning, 1);
    assert.ok(state.counts.every(row => row.last_used === 1000));

    // --- a reused key within LAST_USED_GRANULARITY_MS of its last_used writes nothing ---
    const DAY = LAST_USED_GRANULARITY_MS;
    assert.equal(DAY, 24 * 60 * 60 * 1000);
    const beforeReuse = await inspect();
    await writeBack(directories, { counts: [{ identity: idA, hash: textHash, count: 3 }], ids: [{ identity: idA, hash: idsHash, ids: [15496, 995] }] }, 1000 + DAY - 1);
    assert.deepEqual(await inspect(), beforeReuse, 'reused within a day: nothing written');

    // --- writeBack of an unchanged row a day or more later changes only last_used and leaves the running count ---
    await writeBack(directories, { counts: [{ identity: idA, hash: textHash, count: 3 }], ids: [{ identity: idA, hash: idsHash, ids: [15496, 995] }] }, 1000 + DAY);
    state = await inspect();
    assert.equal(state.countsRunning, 2, 'no row added');
    assert.equal(state.idsRunning, 1, 'no row added');
    assert.equal(state.counts.find(row => row.text_hash === textHash).last_used, 1000 + DAY, 'marked used');
    assert.equal(state.counts.find(row => row.text_hash === ccGpt4).last_used, 1000, 'a row not written is untouched');
    assert.equal(state.ids[0].last_used, 1000 + DAY);
    assert.equal(await readCount(directories, idA, textHash), 3);
    assert.deepEqual(await readIds(directories, idA, idsHash), [15496, 995]);

    // An existing key keeps what it holds: only last_used is written to it.
    await writeBack(directories, { counts: [{ identity: idA, hash: textHash, count: 99 }] }, 2000 + DAY);
    assert.equal(await readCount(directories, idA, textHash), 3);

    // --- a mix of new and reused keys, a key twice in one write-back ---
    await writeBack(directories, {
        counts: [
            { identity: idA, hash: textHash, count: 3 },
            { identity: idB, hash: textHash, count: 4 },
            { identity: idB, hash: ccTurbo, count: 12 },
            { identity: idB, hash: ccTurbo, count: 12 },
        ],
    }, 3000 + DAY);
    state = await inspect();
    assert.equal(state.counts.length, 4);
    assert.equal(state.countsRunning, 4, 'raised by the two keys new to the table');
    assert.equal(state.idsRunning, 1, 'the other table\'s count is its own');
    assert.equal(await readCount(directories, idB, textHash), 4);

    // --- nothing to write: nothing written ---
    await writeBack(directories, { counts: [], ids: [] }, 4000 + DAY);
    await writeBack(directories, {}, 4000 + DAY);
    const after = await inspect();
    assert.deepEqual(after, state);

    // ===== createStoredCounter =====
    const storedDirs = { root: storedRoot };
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

    // --- identity null: the tokenizer on every call, nothing pending ---
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

    // --- identity set: once per distinct text, one row each ---
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
    /** Every method on t1/t2/m1, each text twice, checking the values. */
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

        // --- after write-back, a new counter reads them all: no tokenizer call, the same rows pending ---
        await writeBack(storedDirs, first.pending);
        resetFake();
        const second = createStoredCounter({ resolved: llamaCpp(), identity: llamaIdentity, directories: storedDirs });
        await countAll(second);
        assert.equal(tokenizerCalls(), 0, 'every value read from the tables');
        assert.deepEqual(second.pending, expectedRows, 'the rows read are pending, so write-back marks them used');

        // --- another identity misses ---
        const other = createStoredCounter({ resolved: llamaCpp(), identity: 'llamacpp:["/models/test.gguf","b2"]', directories: storedDirs });
        assert.equal(await other.countText(t1), bytes(t1));
        assert.equal(await other.encodeText(t1).then(ids => ids.length), bytes(t1));
        assert.equal(tokenizerCalls(), 2, 'another identity asks the tokenizer');
        assert.deepEqual(other.pending.counts.map(row => row.identity), ['llamacpp:["/models/test.gguf","b2"]']);
    }

    // --- a pending object shared across counters ---
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

    // --- the local copy answering for a failed remote: the row goes under the copy's identity ---
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

    // --- an estimate answer, or no ids, pushes nothing ---
    {
        resetFake();
        fakeTokenize.fail = true;
        const noCopy = createStoredCounter({ resolved: llamaCpp(), identity: llamaIdentity, directories: storedDirs });
        const t4 = 'No tokenizer answers';
        assert.equal(typeof await noCopy.countText(t4), 'number', 'the estimate');
        assert.equal(await noCopy.encodeText(t4), null);
        assert.equal(typeof await noCopy.countChatMessage([{ role: 'user', content: t4 }]), 'number', 'the estimate');
        // The copy doesn't answer a prompt count for llama.cpp, so that one is the estimate too.
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

    // --- a messages count is keyed by the counting tokenizer's model too ---
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

    // --- the encode and countMessages overrides, and where the answeredOut they set puts the row ---
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
        // The copy's row is under the copy's identity, and reads are under the resolution's, so the copy
        // is asked again for the same text; its row is pending once.
        assert.deepEqual(calls, [['encode', 'six'], ['encode', 'six'], ['countMessages', m6]]);
        assert.deepEqual(stored.pending, {
            counts: [{ identity: 'overrides', hash: tokenKeyHash(TOKEN_KEY_KINDS.CC_MESSAGE, chatMessageKeyText('test-model', m6)), count: 42 }],
            ids: [{ identity: copyIdentity, hash: tokenKeyHash(TOKEN_KEY_KINDS.IDS, 'six'), ids: [7, 8] }],
        }, 'the copy\'s answer under the copy\'s identity, the resolution\'s under the given one');
        assert.ok(Array.isArray(stored.pending.ids[0].ids));

        // A messages count the copy answered is keyed by the copy's model.
        const byCopy = createStoredCounter({
            resolved, identity: 'overrides', directories: storedDirs,
            countMessages: async (_messages, answeredOut) => { answeredOut.tokenizer = gpt4; return 5; },
        });
        await byCopy.countChatMessage(m6);
        assert.deepEqual(byCopy.pending.counts, [
            { identity: copyIdentity, hash: tokenKeyHash(TOKEN_KEY_KINDS.CC_MESSAGE, chatMessageKeyText('gpt-4', m6)), count: 5 },
        ]);
    }

    // ===== chunks: a token_ids row may hold llama.cpp's pieces, as /current/encode answers them =====
    const chunksDirs = { root: chunksRoot };
    const idC = 'llamacpp:["/models/c.gguf","b1"]';
    const hashAe = tokenKeyHash(TOKEN_KEY_KINDS.IDS, 'aé');
    {
        await writeBack(chunksDirs, { ids: [{ identity: idC, hash: hashAe, ids: [0, 1, 2] }] }, 1000);
        assert.deepEqual(await readIdsRow(chunksDirs, idC, hashAe), { ids: [0, 1, 2], chunks: null }, 'a row stored without chunks');
        assert.deepEqual(await readIds(chunksDirs, idC, hashAe), [0, 1, 2]);

        await writeBack(chunksDirs, { ids: [{ identity: idC, hash: hashAe, ids: [0, 1, 2], chunks: ['a', 'é'] }] }, 2000);
        assert.deepEqual(await readIdsRow(chunksDirs, idC, hashAe), { ids: [0, 1, 2], chunks: ['a', 'é'] }, 'a row without chunks gets them');
        let state = await inspect(chunksRoot);
        assert.equal(state.idsRunning, 1, 'no row added');
        assert.equal(state.ids[0].last_used, 1000, 'chunks written; last_used within a day left as it was');

        await writeBack(chunksDirs, { ids: [{ identity: idC, hash: hashAe, ids: [0, 1, 2], chunks: ['x'] }] }, 3000);
        await writeBack(chunksDirs, { ids: [{ identity: idC, hash: hashAe, ids: [0, 1, 2] }] }, 1000 + LAST_USED_GRANULARITY_MS);
        assert.deepEqual(await readIdsRow(chunksDirs, idC, hashAe), { ids: [0, 1, 2], chunks: ['a', 'é'] }, 'a row with chunks keeps them');
        state = await inspect(chunksRoot);
        assert.equal(state.ids[0].last_used, 1000 + LAST_USED_GRANULARITY_MS, 'marked used');

        const hashB = tokenKeyHash(TOKEN_KEY_KINDS.IDS, 'b');
        await writeBack(chunksDirs, { ids: [{ identity: idC, hash: hashB, ids: [0], chunks: ['b'] }] }, 5000);
        assert.deepEqual(await readIdsRow(chunksDirs, idC, hashB), { ids: [0], chunks: ['b'] }, 'a new row with chunks');
        assert.equal((await inspect(chunksRoot)).idsRunning, 2);
        assert.equal(await readIdsRow(chunksDirs, 'another', hashB), null);
    }

    // A store whose token_ids was created before it had a chunks column gains it, keeping its rows.
    {
        const engine = await getSqliteEngine();
        const old = engine.openDatabase(path.join(oldRoot, 'message-tree.sqlite'));
        old.exec(`CREATE TABLE token_ids (identity TEXT NOT NULL, text_hash TEXT NOT NULL, ids TEXT NOT NULL,
                  last_used INTEGER NOT NULL, PRIMARY KEY (identity, text_hash))`);
        old.run('INSERT INTO token_ids (identity, text_hash, ids, last_used) VALUES (@identity, @hash, @ids, 1)', { identity: idC, hash: hashAe, ids: '[0,1,2]' });
        old.close();
        const oldDirs = { root: oldRoot };
        assert.deepEqual(await readIdsRow(oldDirs, idC, hashAe), { ids: [0, 1, 2], chunks: null });
        await writeBack(oldDirs, { ids: [{ identity: idC, hash: hashAe, ids: [0, 1, 2], chunks: ['a', 'é'] }] }, 2);
        assert.deepEqual(await readIdsRow(oldDirs, idC, hashAe), { ids: [0, 1, 2], chunks: ['a', 'é'] });
    }

    // --- encodeTextWithChunks ---
    {
        const counterDirs = { root: fs.mkdtempSync(path.join(chunksRoot, 'counter-')) };
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

        // A row stored without chunks, as a server-side encode stores it, met by a request that needs them: a miss.
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

        // The same within one counter: ids without chunks don't answer a request that needs them.
        resetFake();
        const both = counter();
        await both.encodeText('cé');
        assert.deepEqual(await both.encodeTextWithChunks('cé'), { ids: [0, 1, 2], chunks: ['c', 'é'] });
        assert.deepEqual(fakeTokenize.withPieces, [false, true]);
        assert.deepEqual(await both.encodeText('cé'), [0, 1, 2]);
        assert.equal(tokenizerCalls(), 2, 'ids with chunks answer a plain encode');

        // A failing llama.cpp answered by its copy: no chunks, as before, and the row under the copy's identity.
        resetFake();
        fakeTokenize.fail = true;
        const byCopy = createStoredCounter({ resolved: llamaCpp(gpt4), identity: llamaIdentity, directories: counterDirs });
        const copied = await byCopy.encodeTextWithChunks('dé');
        assert.deepEqual(copied, { ids: Array.from(await createStoredCounter({ resolved: { kind: 'local', ...gpt4, basis: 'local', localCopy: null }, identity: null, directories: counterDirs }).encodeText('dé')), chunks: null });
        assert.deepEqual(byCopy.pending.ids.map(row => [row.identity, row.chunks]), [[await tokenizerIdentity(gpt4), null]]);

        // identity null: llama.cpp with pieces on every call, nothing pending.
        resetFake();
        const unstored = createStoredCounter({ resolved: llamaCpp(), identity: null, directories: counterDirs });
        assert.deepEqual(await unstored.encodeTextWithChunks('aé'), { ids: [0, 1, 2], chunks: ['a', 'é'] });
        await unstored.encodeTextWithChunks('aé');
        assert.deepEqual(fakeTokenize.withPieces, [true, true]);
        assert.deepEqual(unstored.pending, { counts: [], ids: [] });

        // A tokenizer that isn't llama.cpp has no chunks to give: ids only, as before.
        const local = createStoredCounter({ resolved: { kind: 'local', ...gpt4, basis: 'local', localCopy: null }, identity: 'tiktoken-test', directories: counterDirs });
        const localEncoded = await local.encodeTextWithChunks('aé');
        assert.deepEqual(Object.keys(localEncoded), ['ids']);
        assert.deepEqual(local.pending.ids.map(row => Object.keys(row)), [['identity', 'hash', 'ids']]);
    }

    // --- pruning, with the constants passed in small ---
    assert.equal(TOKEN_COUNT_ROW_CAP, 1_000_000);
    assert.equal(PRUNE_BATCH_ROWS, 5000);
    assert.equal(PRUNE_PAUSE_MS, 50);

    const pruneIdentity = 'file:sentencepiece:prune';
    /** One count row per `last_used`, written one write-back each, so each has its own time. */
    const writeRows = async (dirs, lastUseds, limits = undefined) => {
        for (const lastUsed of lastUseds) {
            await writeBack(dirs, { counts: [{ identity: pruneIdentity, hash: tokenKeyHash(TOKEN_KEY_KINDS.TEXT, `row ${lastUsed}`), count: 1 }] }, lastUsed, limits);
        }
    };
    const lastUseds = rows => rows.map(row => Number(row.last_used)).sort((a, b) => a - b);
    const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
    /** Sets a running count by hand, on a handle of its own, as a store whose count went wrong. */
    const setRunning = async (root, key, value) => {
        const engine = await getSqliteEngine();
        const db = engine.openDatabase(path.join(root, 'message-tree.sqlite'));
        try {
            db.run('INSERT INTO meta (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = @value', { key, value: String(value) });
        } finally {
            db.close();
        }
    };

    // A batch deletes the least recently used, at most the batch size and never below the cap.
    {
        const dirs = { root: fs.mkdtempSync(path.join(pruneRoot, 'batch-')) };
        await writeRows(dirs, range(1, 25));
        const limits = { cap: 10, batchRows: 5, pauseMs: 0 };
        assert.equal(await pruneBatch(dirs, 'token_counts', limits), 5, 'one batch is the batch size');
        let pruned = await inspect(dirs.root);
        assert.deepEqual(lastUseds(pruned.counts), range(6, 25), 'the 5 least recently used went');
        assert.equal(pruned.countsRunning, 20);

        const logged = [];
        const log = console.log;
        console.log = (...args) => { logged.push(args.join(' ')); };
        let batches, idle;
        try {
            batches = await pruneTokenTable(dirs, 'token_counts', limits);
            idle = await pruneTokenTable(dirs, 'token_counts', limits);
        } finally {
            console.log = log;
        }
        assert.equal(batches, 2, 'the rest in two more batches of 5');
        assert.equal(idle, 0);
        assert.equal(logged.length, 1, 'one line for the pass that pruned, none for the one that had nothing to prune');
        assert.match(logged[0], /\b10 rows\b.*\btoken_counts\b/);
        assert.ok(logged[0].includes(dirs.root));
        pruned = await inspect(dirs.root);
        assert.deepEqual(lastUseds(pruned.counts), range(16, 25), 'the 10 most recently used are left');
        assert.equal(pruned.countsRunning, 10, 'the running count is the real count');
        assert.equal(await pruneBatch(dirs, 'token_counts', limits), 0, 'at the cap: nothing to delete');

        // Near the cap a batch takes only what is over it.
        await writeRows(dirs, range(26, 27));
        assert.equal(await pruneBatch(dirs, 'token_counts', limits), 2);
        pruned = await inspect(dirs.root);
        assert.deepEqual(lastUseds(pruned.counts), range(18, 27));
        assert.equal(pruned.countsRunning, 10);
        assert.equal(pruned.idsRunning, undefined, 'the other table is untouched');
    }

    // A write-back that crosses the cap schedules one prune, and the table ends at the cap.
    {
        const dirs = { root: fs.mkdtempSync(path.join(pruneRoot, 'crossing-')) };
        const limits = { cap: 10, batchRows: 4, pauseMs: 30 };
        await writeRows(dirs, range(1, 10), limits);
        assert.equal((await inspect(dirs.root)).counts.length, 10, 'at the cap: nothing pruned');
        assert.deepEqual(await writeBack(dirs, { counts: [{ identity: pruneIdentity, hash: tokenKeyHash(TOKEN_KEY_KINDS.TEXT, 'row 11'), count: 1 }] }, 11, limits),
            { prunesScheduled: ['token_counts'] }, 'crossing the cap schedules a prune');
        // While that prune pauses between batches, more rows cross the cap again: no second prune.
        assert.deepEqual(await writeBack(dirs, {
            counts: range(12, 20).map(n => ({ identity: pruneIdentity, hash: tokenKeyHash(TOKEN_KEY_KINDS.TEXT, `row ${n}`), count: 1 })),
        }, 20, limits), { prunesScheduled: [] }, 'one prune pending at a time');
        await tokenCountMaintenanceIdle(dirs);
        const after = await inspect(dirs.root);
        assert.equal(after.counts.length, 10, 'the table ends at the cap');
        assert.equal(after.countsRunning, 10, 'the running count equals the real row count');
        assert.deepEqual(lastUseds(after.counts), [...range(12, 20).map(() => 20), 11].sort((a, b) => a - b), 'the most recently used are kept');
        // Under the cap, a write-back schedules nothing.
        assert.deepEqual(await writeBack(dirs, { counts: [{ identity: pruneIdentity, hash: tokenKeyHash(TOKEN_KEY_KINDS.TEXT, 'row 12'), count: 1 }] }, 21, limits),
            { prunesScheduled: [] });
    }

    // After listen: each table's running count is set from a paged count, then a table over the cap is pruned.
    {
        const dirs = { root: fs.mkdtempSync(path.join(pruneRoot, 'boot-')) };
        await writeRows(dirs, range(1, 13));
        await writeBack(dirs, { ids: [{ identity: pruneIdentity, hash: tokenKeyHash(TOKEN_KEY_KINDS.IDS, 'x'), ids: [1] }] }, 1);
        await setRunning(dirs.root, 'token_counts_rows', 999);
        await setRunning(dirs.root, 'token_ids_rows', 0);

        // Under a cap it doesn't reach: the counts are corrected, nothing pruned.
        await startTokenCountMaintenance([dirs], { cap: 100, batchRows: 4, pauseMs: 0 });
        let state = await inspect(dirs.root);
        assert.equal(state.countsRunning, 13, 'a wrong running count is set to the real one');
        assert.equal(state.idsRunning, 1);
        assert.equal(state.counts.length, 13);

        // Rows written while the count pauses between pages are counted once, on either side of where it has got to.
        await setRunning(dirs.root, 'token_counts_rows', 999);
        const counting = startTokenCountMaintenance([dirs], { cap: 100, batchRows: 4, pauseMs: 100 });
        await new Promise(resolve => setTimeout(resolve, 150));
        const early = { identity: '', hash: tokenKeyHash(TOKEN_KEY_KINDS.TEXT, 'early') };
        const late = { identity: '￿', hash: tokenKeyHash(TOKEN_KEY_KINDS.TEXT, 'late') };
        await writeBack(dirs, { counts: [{ ...early, count: 1 }, { ...late, count: 1 }] }, 50, { cap: 100, batchRows: 4, pauseMs: 100 });
        await counting;
        state = await inspect(dirs.root);
        assert.equal(state.counts.length, 15);
        assert.equal(state.countsRunning, 15, 'the running count equals the real row count');

        // Over the cap at boot: pruned to it.
        await startTokenCountMaintenance([dirs], { cap: 6, batchRows: 4, pauseMs: 0 });
        state = await inspect(dirs.root);
        assert.equal(state.counts.length, 6);
        assert.equal(state.countsRunning, 6);
        assert.deepEqual(lastUseds(state.counts), [10, 11, 12, 13, 50, 50]);
    }

    // A store whose running count already matches isn't written.
    {
        const dirs = { root: fs.mkdtempSync(path.join(pruneRoot, 'unchanged-')) };
        await startTokenCountMaintenance([dirs], { cap: 10, batchRows: 4, pauseMs: 0 });
        const state = await inspect(dirs.root);
        assert.equal(state.countsRunning, undefined, 'an empty table with no running count gets none');
        assert.equal(state.idsRunning, undefined);
    }

    // The server starts it after it listens, unawaited.
    {
        const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'server-main.js'), 'utf8');
        const postSetup = source.slice(source.indexOf('async function postSetupTasks('));
        const postSetupBody = postSetup.slice(0, postSetup.indexOf('\n}\n'));
        assert.match(postSetupBody, /startTokenCountMaintenance\(/);
        assert.doesNotMatch(postSetupBody, /await\s+startTokenCountMaintenance/);
        const preSetup = source.slice(source.indexOf('async function preSetupTasks('));
        assert.doesNotMatch(preSetup.slice(0, preSetup.indexOf('\n}\n')), /startTokenCountMaintenance\(/);
    }
} finally {
    fakeServer.close();
    disposeMessageTreeStores();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(storedRoot, { recursive: true, force: true });
    fs.rmSync(chunksRoot, { recursive: true, force: true });
    fs.rmSync(oldRoot, { recursive: true, force: true });
    fs.rmSync(pruneRoot, { recursive: true, force: true });
}

console.log('token-count-store.test.js: all assertions passed');
