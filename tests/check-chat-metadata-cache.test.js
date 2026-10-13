import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setConfigFilePath } from '../src/util.js';
import { getBetterSqlite3 } from '../src/endpoints/native-sqlite.js';
import { main } from '../src/migrations/check-chat-metadata-cache.js';

/** @type {any} */
let Database;
/** @type {string[]} */
const dirs = [];

beforeAll(async () => {
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    Database = await getBetterSqlite3();
    if (!Database) throw new Error('these tests need the native better-sqlite3 binding');
    engine = (await import('../engine/load.js')).loadEngine().binding;
});

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const notRunning = async () => ({ running: false, lines: [] });

/** @type {any} */
let engine;

/**
 * A user converted from the synthetic old user (`buildOldUser()`), with a chat-metadata.sqlite in the shape
 * acd2252fd^'s chat-metadata-db.js made.
 * @param {[string, string | null][]} rows [path relative to the user dir, chat_metadata_json]
 */
async function userDir(rows) {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-chat-metadata-'));
    dirs.push(dataRoot);
    const root = path.join(dataRoot, 'u');
    await (await import('./convert-to-engine.fixture.js')).buildOldUser(root);
    (await import('../src/character-metadata-db.js')).disposeMetadataStores();
    (await import('../src/message-tree-db.js')).disposeMessageTreeStores();
    const code = await (await import('../src/migrations/convert-to-engine.js')).runConversion({
        dataRoot, handle: 'u', Database, engine: () => engine, apply: true, serverStopped: true,
        probeServer: notRunning, log: () => {}, warn: () => {},
    });
    if (code !== 0) throw new Error(`the conversion failed: ${code}`);
    const cache = new Database(path.join(root, 'chat-metadata.sqlite'));
    cache.exec(`CREATE TABLE chats (file_path TEXT PRIMARY KEY, file_name TEXT NOT NULL, mtime INTEGER NOT NULL, file_size INTEGER NOT NULL,
        message_count INTEGER NOT NULL, last_mes TEXT, preview TEXT, chat_metadata_json TEXT, change_seq INTEGER NOT NULL,
        indexed_message_count INTEGER NOT NULL DEFAULT -1);
        CREATE TABLE changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL, op TEXT NOT NULL);
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);`);
    const insert = cache.prepare('INSERT INTO chats (file_path, file_name, mtime, file_size, message_count, last_mes, preview, chat_metadata_json, change_seq) VALUES (?, ?, 1, 2, 3, \'x\', \'y\', ?, 4)');
    for (const [rel, json] of rows) insert.run(path.join('/old/install/data/u', rel), path.basename(rel), json);
    cache.close();
    return { dataRoot, cachePath: path.join(root, 'chat-metadata.sqlite') };
}

/**
 * @param {string} dataRoot
 * @param {string[]} args
 * @param {object} [more]
 */
async function run(dataRoot, args, more = {}) {
    /** @type {string[]} */
    const lines = [];
    const code = await main([...args, '--data-root', dataRoot, '--handle', 'u'], { Database, engine: () => engine, probeServer: notRunning, log: l => lines.push(l), warn: l => lines.push(l), ...more });
    return { code, text: lines.join('\n') };
}

const ALICE = 'chats/Alice/Alice - 2024-05-01@10h00m00s.jsonl';
const matching = [
    // As the old chat file's header held it: `integrity`, `main_chat` and `fork_point` aren't values compared.
    [ALICE, JSON.stringify({ note_prompt: 'Be brief.', variables: { hp: 3 }, world_info: 'Lore A', integrity: 'old', main_chat: 'X', fork_point: 3 })],
    ['chats/Alice/Alice - 2024-05-01@10h00m00s - Branch #1.jsonl', JSON.stringify({ variables: { hp: 1 } })],
    ['group chats/Party chat.jsonl', JSON.stringify({ note_prompt: 'Group note.' })],
    ['chats/Bob/Empty.jsonl', '{}'],
    ['chats/Bob/Null.jsonl', null],
];

describe('check-chat-metadata-cache', () => {
    test('usage errors exit 2', async () => {
        const { dataRoot } = await userDir(matching);
        expect((await run(dataRoot, [])).code).toBe(2);
        expect((await run(dataRoot, ['--dry-run', '--apply'])).code).toBe(2);
    });

    test('either run without --server-stopped, or with the server running, is refused and deletes nothing', async () => {
        const { dataRoot, cachePath } = await userDir(matching);
        expect((await run(dataRoot, ['--dry-run'])).code).toBe(1);
        expect((await run(dataRoot, ['--apply'])).code).toBe(1);
        expect((await run(dataRoot, ['--apply', '--server-stopped'], { probeServer: async () => ({ running: true, lines: [] }) })).code).toBe(1);
        expect(fs.existsSync(cachePath)).toBe(true);
    });

    test('every value in the engine: the dry run says safe and keeps the file, the real run deletes it', async () => {
        const { dataRoot, cachePath } = await userDir(matching);
        const dry = await run(dataRoot, ['--dry-run', '--server-stopped']);
        expect(dry.text).toContain('5 cached chat(s): 2 with no metadata, 3 with every value in the engine, 0 not.');
        expect(dry.code).toBe(0);
        expect(fs.existsSync(cachePath)).toBe(true);

        expect((await run(dataRoot, ['--apply', '--server-stopped'])).code).toBe(0);
        expect(fs.existsSync(cachePath)).toBe(false);
    });

    test('a changed or missing chat is listed by kind and hashes, never by name, and nothing is deleted', async () => {
        const { dataRoot, cachePath } = await userDir([
            [ALICE, JSON.stringify({ note_prompt: 'old' })],
            ['chats/Alice/Gone.jsonl', JSON.stringify({ note_prompt: 'n' })],
            ['group chats/nobody.jsonl', JSON.stringify({ scenario: 's' })],
        ]);
        const out = await run(dataRoot, ['--apply', '--server-stopped']);
        expect(out.code).toBe(1);
        expect(out.text).toContain('MISMATCH character');
        expect(out.text).toContain('MISSING character');
        expect(out.text).toContain('MISSING group');
        expect(out.text).toContain('not safe to delete');
        for (const name of ['Alice', 'Gone', 'nobody', 'note_prompt', 'old']) expect(out.text).not.toContain(name);
        expect(fs.existsSync(cachePath)).toBe(true);
    });

    test('no cache file: nothing to do', async () => {
        const { dataRoot, cachePath } = await userDir(matching);
        fs.rmSync(cachePath);
        expect((await run(dataRoot, ['--dry-run', '--server-stopped'])).code).toBe(0);
    });
});
