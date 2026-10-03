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
});

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const notRunning = async () => ({ running: false, lines: [] });

/**
 * A user dir with a chat-metadata.sqlite in the shape acd2252fd^'s chat-metadata-db.js made, and a tree.
 * @param {{ cache: [string, string | null][], labels: [string, string, string][], groups?: { id: string, chats: string[] }[] }} spec
 *   cache: [path relative to the user dir, chat_metadata_json]; labels: [owner_id, label, metadata].
 */
function userDir(spec) {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-chat-metadata-'));
    dirs.push(dataRoot);
    const root = path.join(dataRoot, 'u');
    fs.mkdirSync(path.join(root, 'groups'), { recursive: true });
    for (const group of spec.groups ?? []) fs.writeFileSync(path.join(root, 'groups', `${group.id}.json`), JSON.stringify({ name: 'G', members: [], ...group }));
    const cache = new Database(path.join(root, 'chat-metadata.sqlite'));
    cache.exec(`CREATE TABLE chats (file_path TEXT PRIMARY KEY, file_name TEXT NOT NULL, mtime INTEGER NOT NULL, file_size INTEGER NOT NULL,
        message_count INTEGER NOT NULL, last_mes TEXT, preview TEXT, chat_metadata_json TEXT, change_seq INTEGER NOT NULL,
        indexed_message_count INTEGER NOT NULL DEFAULT -1);
        CREATE TABLE changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL, op TEXT NOT NULL);
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);`);
    const insert = cache.prepare('INSERT INTO chats (file_path, file_name, mtime, file_size, message_count, last_mes, preview, chat_metadata_json, change_seq) VALUES (?, ?, 1, 2, 3, \'x\', \'y\', ?, 4)');
    for (const [rel, json] of spec.cache) insert.run(path.join('/old/install/data/u', rel), path.basename(rel), json);
    cache.close();
    const tree = new Database(path.join(root, 'message-tree.sqlite'));
    tree.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, parent_id TEXT, owner_id TEXT NOT NULL, content TEXT NOT NULL, label TEXT, created_at INTEGER NOT NULL, default_child_id TEXT, metadata TEXT, identity_hash TEXT)');
    const label = tree.prepare('INSERT INTO messages (id, parent_id, owner_id, content, label, created_at, metadata) VALUES (?, \'a\', ?, \'{}\', ?, 1, ?)');
    spec.labels.forEach(([owner, name, metadata], i) => label.run(`m${i}`, owner, name, metadata));
    tree.close();
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
    const code = await main([...args, '--data-root', dataRoot, '--handle', 'u'], { Database, probeServer: notRunning, log: l => lines.push(l), warn: l => lines.push(l), ...more });
    return { code, text: lines.join('\n') };
}

const matching = {
    cache: [
        ['chats/Alice/Main.jsonl', JSON.stringify({ note_prompt: 'n', main_chat: 'X', fork_point: 3 })],
        ['group chats/2025-01-01.jsonl', JSON.stringify({ scenario: 's' })],
        ['chats/Bob/Empty.jsonl', '{}'],
        ['chats/Bob/Null.jsonl', null],
    ],
    labels: [
        ['Alice', 'Main', JSON.stringify({ note_prompt: 'n' })],
        ['g1', '2025-01-01', JSON.stringify({ __is_group: true, scenario: 's' })],
    ],
    groups: [{ id: 'g1', chats: ['2025-01-01'] }],
};

describe('check-chat-metadata-cache', () => {
    test('usage errors exit 2', async () => {
        const { dataRoot } = userDir(matching);
        expect((await run(dataRoot, [])).code).toBe(2);
        expect((await run(dataRoot, ['--dry-run', '--apply'])).code).toBe(2);
    });

    test('a real run without --server-stopped, or with the server running, is refused and deletes nothing', async () => {
        const { dataRoot, cachePath } = userDir(matching);
        expect((await run(dataRoot, ['--apply'])).code).toBe(1);
        expect((await run(dataRoot, ['--apply', '--server-stopped'], { probeServer: async () => ({ running: true, lines: [] }) })).code).toBe(1);
        expect(fs.existsSync(cachePath)).toBe(true);
    });

    test('every value in the tree: the dry run says safe and keeps the file, the real run deletes it', async () => {
        const { dataRoot, cachePath } = userDir(matching);
        const dry = await run(dataRoot, ['--dry-run']);
        expect(dry.code).toBe(0);
        expect(dry.text).toContain('4 cached chat(s): 2 with no metadata, 2 matching the tree, 0 not.');
        expect(dry.text).toContain('safe to delete');
        expect(fs.existsSync(cachePath)).toBe(true);

        expect((await run(dataRoot, ['--apply', '--server-stopped'])).code).toBe(0);
        expect(fs.existsSync(cachePath)).toBe(false);
    });

    test('a changed or missing chat is listed by kind and hashes, never by name, and nothing is deleted', async () => {
        const { dataRoot, cachePath } = userDir({
            cache: [
                ['chats/Alice/Main.jsonl', JSON.stringify({ note_prompt: 'old' })],
                ['chats/Alice/Gone.jsonl', JSON.stringify({ note_prompt: 'n' })],
                ['group chats/nobody.jsonl', JSON.stringify({ scenario: 's' })],
            ],
            labels: [['Alice', 'Main', JSON.stringify({ note_prompt: 'new' })]],
        });
        const out = await run(dataRoot, ['--apply', '--server-stopped']);
        expect(out.code).toBe(1);
        expect(out.text).toContain('MISMATCH character');
        expect(out.text).toContain('MISSING character');
        expect(out.text).toContain('MISSING group');
        expect(out.text).toContain('not safe to delete');
        for (const name of ['Alice', 'Main', 'Gone', 'nobody', 'note_prompt', 'old', 'new']) expect(out.text).not.toContain(name);
        expect(fs.existsSync(cachePath)).toBe(true);
    });

    test('no cache file: nothing to do', async () => {
        const { dataRoot, cachePath } = userDir(matching);
        fs.rmSync(cachePath);
        expect((await run(dataRoot, ['--dry-run'])).code).toBe(0);
    });
});
