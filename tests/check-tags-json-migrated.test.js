import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setConfigFilePath } from '../src/util.js';
import { getBetterSqlite3 } from '../src/endpoints/native-sqlite.js';
import { main } from '../src/migrations/check-tags-json-migrated.js';

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

/**
 * A user dir with the store tables the check reads and a tags.json.migrated.
 * @param {object} file
 */
function userDir(file) {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-tags-json-'));
    dirs.push(dataRoot);
    const root = path.join(dataRoot, 'u');
    fs.mkdirSync(root);
    const db = new Database(path.join(root, 'character-metadata.sqlite'));
    db.exec(`CREATE TABLE tags (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE characters (id TEXT PRIMARY KEY);
        CREATE TABLE groups (id TEXT PRIMARY KEY);
        CREATE TABLE character_tags (character_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (character_id, tag_id));
        CREATE TABLE group_tags (group_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (group_id, tag_id));
        CREATE TABLE tag_deletions (tag_id TEXT PRIMARY KEY, merge_into TEXT);
        INSERT INTO tags (id, data) VALUES ('t1', '{}'), ('t2', '{}'), ('t3', '{}');
        INSERT INTO characters (id) VALUES ('Alice.png');
        INSERT INTO groups (id) VALUES ('g1');
        INSERT INTO character_tags VALUES ('Alice.png', 't1'), ('Alice.png', 't3');
        INSERT INTO group_tags VALUES ('g1', 't2');
        INSERT INTO tag_deletions VALUES ('t2', 't3');`);
    db.close();
    if (file !== undefined) fs.writeFileSync(path.join(root, 'tags.json.migrated'), JSON.stringify(file));
    return dataRoot;
}

/** @param {string} dataRoot @param {string[]} [args] */
async function run(dataRoot, args = []) {
    /** @type {string[]} */
    const lines = [];
    const code = await main([...args, '--data-root', dataRoot, '--handle', 'u'], { Database, log: l => lines.push(l), warn: l => lines.push(l) });
    return { code, text: lines.join('\n') };
}

describe('check-tags-json-migrated', () => {
    test('everything in the store, under a merge target, or dropped with its key: exit 0, nothing written', async () => {
        const dataRoot = userDir({
            tags: [{ id: 't1', name: 'One' }, { id: 't2', name: 'Two' }],
            tag_map: { 'Alice.png': ['t1', 't2', 't1'], 'g1': ['t2'], 'Gone.png': ['t1'], 'ghost': ['t2', 't3'], 'Bob.png': 'nope' },
        });
        const dbPath = path.join(dataRoot, 'u', 'character-metadata.sqlite');
        const before = fs.readFileSync(dbPath);
        const { code, text } = await run(dataRoot);
        expect(code).toBe(0);
        expect(text).toContain('tags: 2, in the store 2, missing 0.');
        expect(text).toContain('tag_map entries: 6, in the store 2, under a merge target 1, dropped with their key (no such character or group, logged) 3 in 2 key(s), missing 0; keys whose value isn\'t a list (held no tags, logged): 1.');
        expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
    });

    test('a tag or an entry in neither is counted and listed by hash, never by name', async () => {
        const dataRoot = userDir({ tags: [{ id: 'tX', name: 'Secret' }], tag_map: { 'Alice.png': ['tY'] } });
        const { code, text } = await run(dataRoot);
        expect(code).toBe(1);
        expect(text).toContain('MISSING tag #');
        expect(text).toContain('MISSING tag_map entry #');
        expect(text).toContain('2 item(s) are in neither.');
        for (const name of ['tX', 'tY', 'Secret', 'Alice']) expect(text).not.toContain(name);
    });

    test('no file: nothing to check; an unknown argument: usage', async () => {
        const dataRoot = userDir(undefined);
        expect((await run(dataRoot)).code).toBe(0);
        expect((await run(dataRoot, ['--apply'])).code).toBe(2);
    });
});
