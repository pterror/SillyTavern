import { describe, test, expect, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import NodeSqlite3Wasm from 'node-sqlite3-wasm';
import { openWasmDatabase } from '../src/endpoints/sqlite-engine.js';

const { Database: WasmDatabase } = NodeSqlite3Wasm;

// This exercises the wasm engine adapter specifically (not the native better-sqlite3 one) because it needs no
// native compile step and so is always available to run in CI, regardless of platform - unlike better-sqlite3,
// which is exactly the thing that can be missing on a given install (see sqlite-engine.js's header).
//
// The case this guards against is real, not hypothetical: better-sqlite3 strips the `@`/`:`/`$` prefix when
// matching a named bind parameter against an object key (`@avatar` binds from `{ avatar: ... }`), but
// node-sqlite3-wasm requires the prefix to be part of the key itself (`{ '@avatar': ... }`) - confirmed by
// direct testing, not assumed from either library's docs. openWasmDatabase()'s insertMany() re-prefixes row
// object keys specifically to paper over this difference; these tests confirm that adapter, not a hand-rolled
// duplicate of its logic.

const tmpPaths = [];

afterEach(() => {
    for (const dbPath of tmpPaths.splice(0)) {
        for (const suffix of ['', '-wal', '-shm']) {
            try { fs.unlinkSync(dbPath + suffix); } catch { /* already gone */ }
        }
    }
});

function tmpDbPath() {
    const dbPath = path.join(os.tmpdir(), `sqlite-engine-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    tmpPaths.push(dbPath);
    return dbPath;
}

describe('openWasmDatabase()', () => {
    test('insertMany() binds plain (unprefixed) row-object keys against @-prefixed SQL placeholders', () => {
        const db = openWasmDatabase(WasmDatabase, tmpDbPath());
        db.exec('CREATE VIRTUAL TABLE cards USING fts5(avatar UNINDEXED, name, tags);');

        db.insertMany(
            'INSERT INTO cards (avatar, name, tags) VALUES (@avatar, @name, @tags)',
            [
                { avatar: 'a.png', name: 'Vampire Lord', tags: 'gothic romance' },
                { avatar: 'b.png', name: 'Sunny Bard', tags: 'cheerful' },
            ],
        );

        const rows = db.query('SELECT avatar, name FROM cards WHERE cards MATCH ? ORDER BY avatar', 'name:"vamp"*');
        expect(rows).toEqual([{ avatar: 'a.png', name: 'Vampire Lord' }]);
        db.close();
    });

    test('the FTS5 index and bm25()/column-group filter syntax this project relies on actually work over wasm', () => {
        const db = openWasmDatabase(WasmDatabase, tmpDbPath());
        db.exec('CREATE VIRTUAL TABLE cards USING fts5(avatar UNINDEXED, name, resolved_tags, tags);');
        db.insertMany(
            'INSERT INTO cards (avatar, name, resolved_tags, tags) VALUES (@avatar, @name, @resolved_tags, @tags)',
            [
                { avatar: 'a.png', name: 'Vampire Lord', resolved_tags: 'romance', tags: '' },
                { avatar: 'b.png', name: 'Sunny Bard', resolved_tags: '', tags: 'romance' },
                { avatar: 'c.png', name: 'Random Rogue', resolved_tags: '', tags: '' },
            ],
        );

        // bm25() must be callable at all (it's how results get ranked)
        const ranked = db.query('SELECT avatar, bm25(cards) as score FROM cards WHERE cards MATCH ? ORDER BY score', '"vampire"*');
        expect(ranked.map(r => r.avatar)).toEqual(['a.png']);

        // {col1 col2}: column-group filter syntax (used for the tag: label - see characters-search-index.js)
        // must match a term in EITHER underlying column.
        const grouped = db.query('SELECT avatar FROM cards WHERE cards MATCH ? ORDER BY avatar', '{resolved_tags tags}:"romance"*');
        expect(grouped.map(r => r.avatar)).toEqual(['a.png', 'b.png']);
    });

    test('data persists across close() and reopen (this is a durable on-disk index, not memory-only)', () => {
        const dbPath = tmpDbPath();
        const db = openWasmDatabase(WasmDatabase, dbPath);
        db.exec('CREATE VIRTUAL TABLE cards USING fts5(name);');
        db.insertMany('INSERT INTO cards (name) VALUES (@name)', [{ name: 'Persisted Card' }]);
        db.close();

        const reopened = openWasmDatabase(WasmDatabase, dbPath);
        const rows = reopened.query('SELECT name FROM cards WHERE cards MATCH ?', '"persisted"*');
        expect(rows).toEqual([{ name: 'Persisted Card' }]);
        reopened.close();
    });

    test('insertMany() rolls back and rethrows if any row fails to insert, instead of leaving a half-written index', () => {
        const db = openWasmDatabase(WasmDatabase, tmpDbPath());
        db.exec('CREATE VIRTUAL TABLE cards USING fts5(name);');

        expect(() => db.insertMany(
            'INSERT INTO cards (name) VALUES (@name)',
            [{ name: 'Good Row' }, { missingTheNameKey: 'Bad Row' }],
        )).toThrow();

        const rows = db.query('SELECT name FROM cards WHERE cards MATCH ?', '"good"*');
        expect(rows).toEqual([]);
        db.close();
    });
});
