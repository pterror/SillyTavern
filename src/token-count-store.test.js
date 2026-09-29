import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { disposeMessageTreeStores } from './message-tree-db.js';
import { getSqliteEngine } from './endpoints/sqlite-engine.js';
import {
    TOKEN_KEY_KINDS,
    tokenKeyHash,
    chatMessageKeyText,
    readCount,
    readIds,
    writeBack,
} from './token-count-store.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'token-count-store-test-'));
const directories = { root: tmpRoot };

/** Reads the rows and the running counts straight from the file, on a handle of its own. */
async function inspect() {
    const engine = await getSqliteEngine();
    const db = engine.openDatabase(path.join(tmpRoot, 'message-tree.sqlite'));
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

    // --- writeBack of an unchanged row changes only last_used and leaves the running count ---
    await writeBack(directories, { counts: [{ identity: idA, hash: textHash, count: 3 }], ids: [{ identity: idA, hash: idsHash, ids: [15496, 995] }] }, 2000);
    state = await inspect();
    assert.equal(state.countsRunning, 2, 'no row added');
    assert.equal(state.idsRunning, 1, 'no row added');
    assert.equal(state.counts.find(row => row.text_hash === textHash).last_used, 2000, 'marked used');
    assert.equal(state.counts.find(row => row.text_hash === ccGpt4).last_used, 1000, 'a row not written is untouched');
    assert.equal(state.ids[0].last_used, 2000);
    assert.equal(await readCount(directories, idA, textHash), 3);
    assert.deepEqual(await readIds(directories, idA, idsHash), [15496, 995]);

    // An existing key keeps what it holds: only last_used is written to it.
    await writeBack(directories, { counts: [{ identity: idA, hash: textHash, count: 99 }] }, 3000);
    assert.equal(await readCount(directories, idA, textHash), 3);

    // --- a mix of new and reused keys, a key twice in one write-back ---
    await writeBack(directories, {
        counts: [
            { identity: idA, hash: textHash, count: 3 },
            { identity: idB, hash: textHash, count: 4 },
            { identity: idB, hash: ccTurbo, count: 12 },
            { identity: idB, hash: ccTurbo, count: 12 },
        ],
    }, 4000);
    state = await inspect();
    assert.equal(state.counts.length, 4);
    assert.equal(state.countsRunning, 4, 'raised by the two keys new to the table');
    assert.equal(state.idsRunning, 1, 'the other table\'s count is its own');
    assert.equal(await readCount(directories, idB, textHash), 4);

    // --- nothing to write: nothing written ---
    await writeBack(directories, { counts: [], ids: [] }, 5000);
    await writeBack(directories, {}, 5000);
    const after = await inspect();
    assert.deepEqual(after, state);
} finally {
    disposeMessageTreeStores();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log('token-count-store.test.js: all assertions passed');
