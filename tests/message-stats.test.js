import { describe, test, expect, jest, beforeAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import NodeSqlite3Wasm from 'node-sqlite3-wasm';
import { isBusyError, openWasmDatabase, streamRows } from '../src/endpoints/sqlite-engine.js';

const { Database: WasmDatabase } = NodeSqlite3Wasm;

jest.unstable_mockModule('../src/endpoints/sqlite-engine.js', () => ({
    getSqliteEngine: async () => ({
        kind: 'wasm',
        openDatabase: (dbPath, options) => openWasmDatabase(WasmDatabase, dbPath, options),
    }),
    openWasmDatabase,
    openNativeDatabase: jest.fn(),
    streamRows,
    isBusyError,
}));

/** @type {typeof import('../src/message-tree-db.js')} */
let treeDb;
/** @type {typeof import('../src/message-stats.js')} */
let stats;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    treeDb = await import('../src/message-tree-db.js');
    stats = await import('../src/message-stats.js');
});

const tmpDirs = [];

function makeDirectories() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'message-stats-test-'));
    tmpDirs.push(root);
    return { root };
}

afterEach(() => {
    treeDb.disposeMessageTreeStores();
    for (const dir of tmpDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

const T0 = Date.parse('2026-09-01T10:00:00.000Z');

/** @param {string} mes @param {number} at */
function userMessage(mes, at) {
    return { name: 'User', is_user: true, mes, send_date: at, extra: {} };
}

/** @param {string} mes @param {number | null} [tookMs] How long it took to generate; null for a reply saved without times. */
function charMessage(mes, tookMs = null) {
    const message = { name: 'Rex', is_user: false, mes, send_date: T0, extra: {} };
    if (tookMs !== null) {
        message.gen_started = new Date(T0).toISOString();
        message.gen_finished = new Date(T0 + tookMs).toISOString();
    }
    return message;
}

/** @param {{ root: string }} directories @param {string} ownerId */
async function live(directories, ownerId) {
    const read = await treeDb.readMessageStats(directories, [ownerId]);
    return read.owners.get(ownerId);
}

/** @param {{ root: string }} directories @param {string} ownerId */
async function recount(directories, ownerId) {
    return stats.countOwnerStatsSync(await treeDb.getMessageTreeDb(directories), ownerId);
}

/**
 * A chat: a greeting, then user / character pairs.
 * @param {{ root: string }} directories @param {string} ownerId
 */
async function seedChat(directories, ownerId) {
    const saved = /** @type {any} */ (await treeDb.saveChatToTree(directories, ownerId, 'main', [
        { chat_metadata: {} },
        charMessage('Welcome, traveller.'),
        userMessage('Hello there friend', T0 + 1000),
        charMessage('Good to see you again', 4000),
    ]));
    return saved.assignedNodeIds.map(a => a.node_id);
}

describe('message stats are counted from the stored messages', () => {
    test('a chat counts its user and character messages and words, not its greeting', async () => {
        const directories = makeDirectories();
        await seedChat(directories, 'rex');

        expect(await live(directories, 'rex')).toEqual({
            user_msgs: 1, char_msgs: 1, user_words: 3, char_words: 5, swipes: 0,
            gen_ms: 4000, gen_unknown: 0, first_user_at: T0 + 1000,
        });
    });

    test('a reply\'s words are counted from its stored text, however it was streamed', async () => {
        const directories = makeDirectories();
        const [, , replyId] = await seedChat(directories, 'rex');
        const result = await treeDb.appendMessages(directories, 'rex', replyId, [
            userMessage('and you', T0 + 5000),
            charMessage('one two three four five six seven', 1500),
        ]);
        expect(result.ok).toBe(true);

        const counted = await live(directories, 'rex');
        expect(counted.char_words).toBe(5 + 7);
        expect(counted.char_msgs).toBe(2);
        expect(counted.gen_ms).toBe(4000 + 1500);
    });

    test('swipes are the extra character messages under one parent; a reply without times is counted as unknown', async () => {
        const directories = makeDirectories();
        const [, , replyId] = await seedChat(directories, 'rex');
        const added = await treeDb.addAlternatives(directories, 'rex', replyId, [charMessage('Another take'), charMessage('A third one', 2000)]);
        expect(added.ok).toBe(true);

        const counted = await live(directories, 'rex');
        expect(counted.swipes).toBe(2);
        expect(counted.char_msgs).toBe(3);
        expect(counted.gen_unknown).toBe(1);
        expect(counted.gen_ms).toBe(4000 + 2000);

        const removed = await treeDb.deleteAlternative(directories, 'rex', added.node_ids[0]);
        expect(removed.ok).toBe(true);
        expect((await live(directories, 'rex')).swipes).toBe(1);
        expect(await live(directories, 'rex')).toEqual(await recount(directories, 'rex'));
    });

    test('an edit changes the counts by the difference', async () => {
        const directories = makeDirectories();
        const [, userId] = await seedChat(directories, 'rex');
        const edited = await treeDb.editMessages(directories, 'rex', [{ node_id: userId, content: userMessage('Hi', T0 + 1000) }]);
        expect(edited.applied).toBe(1);

        expect((await live(directories, 'rex')).user_words).toBe(1);
        expect(await live(directories, 'rex')).toEqual(await recount(directories, 'rex'));
    });

    test('after any mix of writes, the counters equal a recount of the rows, and the totals equal the sum of the owners', async () => {
        const directories = makeDirectories();
        let seed = 7;
        const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
        const owners = ['rex', 'mira', 'ivo'];
        /** @type {Record<string, string[]>} */
        const nodes = {};
        for (const owner of owners) nodes[owner] = await seedChat(directories, owner);

        for (let step = 0; step < 400; step++) {
            const owner = owners[Math.floor(random() * owners.length)];
            const ids = nodes[owner];
            const target = ids[Math.floor(random() * ids.length)];
            const roll = random();
            const words = Array.from({ length: 1 + Math.floor(random() * 6) }, (_, i) => `w${step}x${i}`).join(' ');
            // Send dates in any order, so deletes and edits take away an owner's earliest user message.
            const at = T0 + Math.floor(random() * 50) * 1000;
            if (roll < 0.35) {
                const result = await treeDb.appendMessages(directories, owner, target, [random() < 0.5 ? userMessage(words, at) : charMessage(words, random() < 0.7 ? 100 * step : null)]);
                if (result.ok) ids.push(...result.node_ids);
            } else if (roll < 0.6) {
                const result = await treeDb.addAlternatives(directories, owner, target, [charMessage(words, random() < 0.5 ? 50 : null)]);
                if (result.ok) ids.push(...result.node_ids);
            } else if (roll < 0.85) {
                await treeDb.editMessages(directories, owner, [{ node_id: target, content: random() < 0.5 ? userMessage(words, at) : charMessage(words, 10) }]);
            } else {
                const result = await treeDb.deleteAlternative(directories, owner, target);
                if (result.ok) ids.splice(ids.indexOf(target), 1);
            }

            for (const o of owners) {
                expect([step, o, await live(directories, o)]).toEqual([step, o, await recount(directories, o)]);
            }
            const read = await treeDb.readMessageStats(directories, owners);
            const sum = (key) => owners.reduce((n, o) => n + read.owners.get(o)[key], 0);
            for (const key of ['user_msgs', 'char_msgs', 'user_words', 'char_words', 'swipes', 'gen_ms', 'gen_unknown']) {
                expect([step, key, read.totals[key]]).toEqual([step, key, sum(key)]);
            }
            const firsts = owners.map(o => read.owners.get(o).first_user_at).filter(at => at !== null);
            expect([step, read.totals.first_user_at]).toEqual([step, firsts.length === 0 ? null : Math.min(...firsts)]);
        }
    });

    test('the fill counts chats stored before the counters existed, and a restart counts them again', async () => {
        const directories = makeDirectories();
        await seedChat(directories, 'rex');
        await seedChat(directories, 'mira');

        // As if the counters were new: drop them and start the fill over.
        const db = await treeDb.getMessageTreeDb(directories);
        db.run('DELETE FROM owner_message_stats');
        await treeDb.restartMessageStatsFill(directories);
        expect((await treeDb.readMessageStats(directories, [])).filled).toBe(false);

        let result;
        do {
            result = await treeDb.fillMessageStats(directories, 1);
        } while (!result.done);

        const read = await treeDb.readMessageStats(directories, ['rex', 'mira']);
        expect(read.filled).toBe(true);
        expect(read.owners.get('rex')).toEqual(await recount(directories, 'rex'));
        expect(read.owners.get('mira')).toEqual(await recount(directories, 'mira'));
        expect(read.totals.user_msgs).toBe(2);
        expect(read.totals.char_words).toBe(10);
    });
});
