import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/endpoints/chat-content-search-index.js')} */
let contentIndex;
/** @type {typeof import('../src/chat-metadata-db.js')} */
let chatMetadataDb;
/** @type {typeof import('../src/endpoints/search-engine.js')} */
let searchEngine;

let tempDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    contentIndex = await import('../src/endpoints/chat-content-search-index.js');
    chatMetadataDb = await import('../src/chat-metadata-db.js');
    searchEngine = await import('../src/endpoints/search-engine.js');
});

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-chat-content-search-test-'));
    directories = {
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
    };
    fs.mkdirSync(directories.characters, { recursive: true });
    fs.mkdirSync(directories.chats, { recursive: true });
    fs.mkdirSync(directories.groups, { recursive: true });
    fs.mkdirSync(directories.groupChats, { recursive: true });
});

afterEach(() => {
    chatMetadataDb.disposeChatMetadataStores();
});

/**
 * Writes a chat file to disk AND records it in chat-metadata-db.js exactly the way trySaveChat()'s write-path
 * hook does (upsertChatFromSave, given the full in-memory array) - both halves are needed for
 * chat-content-search-index.js to do anything useful: the file itself (it reads message text off disk) and the
 * metadata row (message_count/rev drive its incremental catch-up and resolveHitsToChats()'s resolution step).
 * @param {string} filePath
 * @param {Array<object>} chatData Full chat array (index 0 = header)
 * @returns {Promise<void>}
 */
async function writeAndRecordChat(filePath, chatData) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const jsonl = chatData.map(m => JSON.stringify(m)).join('\n');
    fs.writeFileSync(filePath, jsonl);
    const stats = fs.statSync(filePath);
    await chatMetadataDb.upsertChatFromSave(directories, filePath, chatData, stats.mtimeMs, Buffer.byteLength(jsonl));
}

/**
 * @param {number} count
 * @param {(i: number) => string} textFor
 * @returns {Array<object>}
 */
function makeMessages(count, textFor) {
    const items = [{ chat_metadata: {} }];
    for (let i = 0; i < count; i++) {
        items.push({ name: i % 2 === 0 ? 'User' : 'Alice', is_user: i % 2 === 0, mes: textFor(i), send_date: `2024-01-0${(i % 9) + 1}T00:00:00.000Z` });
    }
    return items;
}

/**
 * Polls searchChatMessages() until `predicate` is satisfied or the deadline passes - needed whenever a test
 * exercises the WARM/background-catch-up path (search-index-coordinator.js's getIndex() serves a stale result
 * immediately and catches up in the background on a signature change for a handle it's already seen), same
 * pattern characters-search-index-cold-start.test.js already establishes for the identical reason.
 * @param {string} handle
 * @param {string} term
 * @param {(results: Awaited<ReturnType<typeof contentIndex.searchChatMessages>>['results']) => boolean} predicate
 * @returns {Promise<Awaited<ReturnType<typeof contentIndex.searchChatMessages>>>}
 */
async function pollUntil(handle, term, predicate) {
    let result = await contentIndex.searchChatMessages(handle, directories, term);
    const deadline = Date.now() + 10000;
    while (!predicate(result.results) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
        result = await contentIndex.searchChatMessages(handle, directories, term);
    }
    return result;
}

describe('chat-content-search-index.js', () => {
    test('resolveHitsToChats collapses multiple message hits from the same chat into one result with match_count', async () => {
        const filePath = path.join(directories.chats, 'Alice', 'chat1.jsonl');
        await writeAndRecordChat(filePath, makeMessages(3, () => 'hello'));

        const hits = [
            { raw: JSON.stringify({ chatId: filePath, messageIndex: 0, characterOrGroupId: 'Alice.png', date: null, isUser: false }), score: 5 },
            { raw: JSON.stringify({ chatId: filePath, messageIndex: 2, characterOrGroupId: 'Alice.png', date: null, isUser: false }), score: 1 },
        ];

        const resolved = await contentIndex.resolveHitsToChats(directories, hits);
        expect(resolved).toHaveLength(1);
        expect(resolved[0].file_path).toBe(filePath);
        expect(resolved[0].match_count).toBe(2);
        expect(resolved[0].best_score).toBe(1);
        expect(resolved[0].message_count).toBe(3);
        // The client (public/script.js's displayChats()) renders this straight into the chat-list row - has to
        // be a human-readable string like every other /api/chats/search result already carries, not the raw
        // byte count chat-metadata-db.js's row stores it as (a real bug this test would have caught: an earlier
        // version of this function left it `undefined`, which the client would have rendered as literal "(undefined,").
        expect(typeof resolved[0].file_size).toBe('string');
        expect(resolved[0].file_size).not.toBe('undefined');
    });

    test('resolveHitsToChats drops a hit whose chat has since been deleted from the metadata store', async () => {
        const hits = [{ raw: JSON.stringify({ chatId: path.join(directories.chats, 'nope.jsonl'), messageIndex: 0 }), score: 1 }];
        const resolved = await contentIndex.resolveHitsToChats(directories, hits);
        expect(resolved).toEqual([]);
    });

    test('a full build finds a word in message content and resolves it back to the right chat', async () => {
        const engine = await searchEngine.resolveSearchEngine();
        if (engine.tier !== 'tantivy') {
            return; // tantivy isn't the resolved engine on this install - this module is tantivy-only, see its own header
        }

        const filePath = path.join(directories.chats, 'Alice', 'chat1.jsonl');
        await writeAndRecordChat(filePath, makeMessages(3, (i) => i === 1 ? 'a friendly dragon appears' : 'hello there'));

        const buildResult = await contentIndex.rebuildChatContentIndex('handle-full-build', directories);
        expect(buildResult).toEqual({ ok: true, backend: 'tantivy' });

        const { results, backend } = await contentIndex.searchChatMessages('handle-full-build', directories, 'dragon');
        expect(backend).toBe('tantivy');
        expect(results).toHaveLength(1);
        expect(results[0].file_path).toBe(filePath);
        expect(results[0].message_count).toBe(3);

        const noMatch = await contentIndex.searchChatMessages('handle-full-build', directories, 'nonexistentword');
        expect(noMatch.results).toEqual([]);
    }, 20000);

    test('an append-only save is caught up incrementally: new tail message becomes searchable without a full rebuild', async () => {
        const engine = await searchEngine.resolveSearchEngine();
        if (engine.tier !== 'tantivy') {
            return;
        }

        const filePath = path.join(directories.chats, 'Bob', 'chat1.jsonl');
        const handle = 'handle-append';
        await writeAndRecordChat(filePath, makeMessages(2, () => 'ordinary chat text'));
        await contentIndex.rebuildChatContentIndex(handle, directories);

        // Confirm the not-yet-appended word genuinely doesn't match yet.
        const before = await contentIndex.searchChatMessages(handle, directories, 'wizard');
        expect(before.results).toEqual([]);

        // Append two more messages - a real save() would replace the whole file with the full array; the first
        // two messages' text is deliberately unchanged, exercising the append-only (not full-reindex) path.
        await writeAndRecordChat(filePath, makeMessages(4, (i) => i < 2 ? 'ordinary chat text' : 'a wizard casts a spell'));

        const after = await pollUntil(handle, 'wizard', results => results.length > 0);
        expect(after.results).toHaveLength(1);
        expect(after.results[0].file_path).toBe(filePath);
        expect(after.results[0].message_count).toBe(4);
    }, 20000);

    test('a save that removes messages (count decreases) forces a full reindex, dropping stale hits for removed content', async () => {
        const engine = await searchEngine.resolveSearchEngine();
        if (engine.tier !== 'tantivy') {
            return;
        }

        const filePath = path.join(directories.chats, 'Carol', 'chat1.jsonl');
        const handle = 'handle-shrink';
        await writeAndRecordChat(filePath, makeMessages(4, (i) => i === 3 ? 'a secret treasure map' : 'small talk'));
        await contentIndex.rebuildChatContentIndex(handle, directories);

        const before = await contentIndex.searchChatMessages(handle, directories, 'treasure');
        expect(before.results).toHaveLength(1);

        // The chat got truncated back down to 2 messages (e.g. branch swap / edit that dropped the tail) - the
        // message that matched "treasure" no longer exists.
        await writeAndRecordChat(filePath, makeMessages(2, () => 'small talk'));

        // Poll on the actual tantivy-level condition (the stale "treasure" doc being gone), not on the
        // chat-metadata-db.js row (that updates synchronously at write time, independent of - and therefore not
        // a valid proxy for - whether the background tantivy catch-up has actually run yet).
        const after = await pollUntil(handle, 'treasure', results => results.length === 0);
        expect(after.results).toEqual([]);

        const smallTalk = await contentIndex.searchChatMessages(handle, directories, 'small');
        const match = smallTalk.results.find(r => r.file_path === filePath);
        expect(match?.message_count).toBe(2);
    }, 20000);
});
