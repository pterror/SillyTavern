import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import NodeSqlite3Wasm from 'node-sqlite3-wasm';

import { openNativeDatabase, openNativeReadDatabase, openWasmDatabase, streamWrite } from '../src/endpoints/sqlite-engine.js';

const { Database: WasmDatabase } = NodeSqlite3Wasm;

const WRITE_WHILE_ITERATING = 'write while iterate() is open';

describe.each([
    ['native', (dbPath) => openNativeDatabase(Database, dbPath)],
    ['wasm', (dbPath) => openWasmDatabase(WasmDatabase, dbPath)],
])('%s engine iterate()', (_name, open) => {
    let tmpDir;
    let handle;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-sqlite-iterate-'));
        handle = open(path.join(tmpDir, 'db.sqlite'));
        handle.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
        handle.insertMany('INSERT INTO t (id, v) VALUES (@id, @v)', [1, 2, 3, 4, 5].map(id => ({ id, v: `v${id}` })));
    });

    afterEach(() => {
        handle.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('streams every matching row, binding unprefixed named params', () => {
        const ids = [];
        for (const row of handle.iterate('SELECT id FROM t WHERE id > @min ORDER BY id', { min: 2 })) {
            ids.push(row.id);
        }
        expect(ids).toEqual([3, 4, 5]);
    });

    test('binds positional params', () => {
        expect(Array.from(handle.iterate('SELECT id FROM t WHERE id <= ? ORDER BY id', [2])).map(r => r.id)).toEqual([1, 2]);
    });

    test('an iterator that is never started blocks nothing', () => {
        handle.iterate('SELECT id FROM t');
        expect(() => handle.run('DELETE FROM t WHERE id = 1')).not.toThrow();
    });

    test.each([
        ['run', (h) => h.run('DELETE FROM t WHERE id = 1')],
        ['exec', (h) => h.exec('SELECT 1')],
        ['insertMany', (h) => h.insertMany('INSERT INTO t (id, v) VALUES (@id, @v)', [{ id: 9, v: 'v9' }])],
        ['transaction', (h) => h.transaction(() => {})],
        ['checkpoint', (h) => h.checkpoint()],
    ])('%s throws while an iterate() is open, and writes nothing', (_method, write) => {
        const rows = handle.iterate('SELECT id FROM t');
        rows.next();
        expect(() => write(handle)).toThrow(WRITE_WHILE_ITERATING);
        rows.return();
        expect(handle.get('SELECT COUNT(*) AS n FROM t').n).toBe(5);
    });

    test('the write guard also holds inside a nested iterate() and lifts only when the outer one ends', () => {
        const outer = handle.iterate('SELECT id FROM t ORDER BY id');
        outer.next();
        const inner = handle.iterate('SELECT id FROM t');
        inner.next();
        inner.return();
        expect(() => handle.run('DELETE FROM t WHERE id = 1')).toThrow(WRITE_WHILE_ITERATING);
        outer.return();
        expect(() => handle.run('DELETE FROM t WHERE id = 1')).not.toThrow();
    });

    test('get() and a nested iterate() are allowed while an iterate() is open', () => {
        const pairs = [];
        for (const outer of handle.iterate('SELECT id FROM t WHERE id <= 2 ORDER BY id')) {
            const got = handle.get('SELECT v FROM t WHERE id = @id', { id: outer.id });
            for (const inner of handle.iterate('SELECT id FROM t WHERE id <= 2 ORDER BY id')) {
                pairs.push([got.v, inner.id]);
            }
        }
        expect(pairs).toEqual([['v1', 1], ['v1', 2], ['v2', 1], ['v2', 2]]);
    });

    test.each([
        ['break', () => {
            const seen = [];
            for (const row of handle.iterate('SELECT id FROM t ORDER BY id')) {
                seen.push(row.id);
                break;
            }
            return seen;
        }],
        ['return', () => {
            for (const row of handle.iterate('SELECT id FROM t ORDER BY id')) {
                return [row.id];
            }
        }],
        ['throw', () => {
            try {
                for (const row of handle.iterate('SELECT id FROM t ORDER BY id')) {
                    throw row.id;
                }
            } catch (id) {
                return [id];
            }
        }],
        ['exhaustion', () => {
            const seen = [];
            for (const row of handle.iterate('SELECT id FROM t ORDER BY id')) {
                seen.push(row.id);
            }
            return seen.slice(0, 1);
        }],
    ])('ending the loop by %s releases the statement: writes work again', (_how, endLoop) => {
        expect(endLoop()).toEqual([1]);
        handle.run('UPDATE t SET v = ? WHERE id = ?', ['changed', 1]);
        expect(handle.get('SELECT v FROM t WHERE id = 1').v).toBe('changed');
    });

    test('a SQL error on prepare leaves no iterator open', () => {
        expect(() => Array.from(handle.iterate('SELECT nope FROM missing_table'))).toThrow();
        expect(() => handle.run('DELETE FROM t WHERE id = 1')).not.toThrow();
    });
});

describe('native read connection', () => {
    let tmpDir;
    let dbPath;
    let main;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-sqlite-reader-'));
        dbPath = path.join(tmpDir, 'db.sqlite');
        main = openNativeDatabase(Database, dbPath);
        main.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
        main.insertMany('INSERT INTO t (id, v) VALUES (@id, @v)', [1, 2, 3, 4, 5].map(id => ({ id, v: `v${id}` })));
    });

    afterEach(() => {
        main.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('exposes only get, iterate and close', () => {
        const reader = openNativeReadDatabase(Database, dbPath);
        try {
            expect(Object.keys(reader).sort()).toEqual(['close', 'get', 'iterate']);
        } finally {
            reader.close();
        }
    });

    test('the main connection writes in batched transactions while the reader streams, and the reader keeps its snapshot', () => {
        const reader = openNativeReadDatabase(Database, dbPath);
        const seen = [];
        try {
            let batch = [];
            for (const row of reader.iterate('SELECT id, v FROM t ORDER BY id')) {
                seen.push(row.v);
                batch.push(row.id);
                if (batch.length === 2) {
                    const ids = batch;
                    main.transaction(() => {
                        for (const id of ids) {
                            main.run('UPDATE t SET v = @v WHERE id = @id', { id, v: `new${id}` });
                        }
                    });
                    batch = [];
                }
            }
        } finally {
            reader.close();
        }
        expect(seen).toEqual(['v1', 'v2', 'v3', 'v4', 'v5']);
        expect(main.get('SELECT v FROM t WHERE id = 4').v).toBe('new4');
    });

    test('get() reads committed data', () => {
        main.run('UPDATE t SET v = ? WHERE id = ?', ['changed', 1]);
        const reader = openNativeReadDatabase(Database, dbPath);
        try {
            expect(reader.get('SELECT v FROM t WHERE id = @id', { id: 1 }).v).toBe('changed');
        } finally {
            reader.close();
        }
    });

    test('the reader cannot write', () => {
        const reader = openNativeReadDatabase(Database, dbPath);
        try {
            expect(() => Array.from(reader.iterate('DELETE FROM t RETURNING id'))).toThrow(/readonly/);
        } finally {
            reader.close();
        }
        expect(main.get('SELECT COUNT(*) AS n FROM t').n).toBe(5);
    });
});

const KEYED_READ_SQL = 'SELECT id, v FROM t WHERE (@after IS NULL OR id > @after) AND id % @mod = 0 ORDER BY id LIMIT @limit';

describe.each([
    ['native', (dbPath) => openNativeDatabase(Database, dbPath), true],
    ['wasm', (dbPath) => openWasmDatabase(WasmDatabase, dbPath), false],
])('%s engine streamWrite()', (_name, open, hasReader) => {
    let tmpDir;
    let handle;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-sqlite-streamwrite-'));
        handle = open(path.join(tmpDir, 'db.sqlite'));
        handle.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
        handle.insertMany('INSERT INTO t (id, v) VALUES (@id, @v)', Array.from({ length: 2500 }, (_, i) => ({ id: i + 1, v: 'old' })));
    });

    afterEach(() => {
        handle.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test(`the handle ${hasReader ? 'has' : 'has no'} openReader()`, () => {
        expect(typeof handle.openReader === 'function').toBe(hasReader);
    });

    test('hands every matching row to onBatch once, in key order, 1000 per batch, with writes applied', () => {
        const batchSizes = [];
        const seen = [];
        streamWrite(handle, {
            readSql: KEYED_READ_SQL,
            params: { mod: 1 },
            keyColumn: 'id',
            onBatch: (rows) => {
                batchSizes.push(rows.length);
                for (const row of rows) {
                    seen.push(row.id);
                    handle.run('UPDATE t SET v = @v WHERE id = @id', { id: row.id, v: `new${row.id}` });
                }
            },
        });
        expect(batchSizes).toEqual([1000, 1000, 500]);
        expect(seen).toEqual(Array.from({ length: 2500 }, (_, i) => i + 1));
        expect(handle.get('SELECT COUNT(*) AS n FROM t WHERE v = \'old\'').n).toBe(0);
        expect(handle.get('SELECT v FROM t WHERE id = 2500').v).toBe('new2500');
    });

    test('passes the caller\'s params through alongside after/limit', () => {
        const seen = [];
        streamWrite(handle, { readSql: KEYED_READ_SQL, params: { mod: 1000 }, keyColumn: 'id', onBatch: (rows) => seen.push(...rows.map(r => r.id)) });
        expect(seen).toEqual([1000, 2000]);
    });

    test('an exact multiple of the batch size produces no empty trailing batch', () => {
        handle.run('DELETE FROM t WHERE id > 2000');
        const batchSizes = [];
        streamWrite(handle, { readSql: KEYED_READ_SQL, params: { mod: 1 }, keyColumn: 'id', onBatch: (rows) => batchSizes.push(rows.length) });
        expect(batchSizes).toEqual([1000, 1000]);
    });

    test('no matching rows means onBatch is never called', () => {
        let calls = 0;
        streamWrite(handle, { readSql: KEYED_READ_SQL, params: { mod: 100000 }, keyColumn: 'id', onBatch: () => { calls++; } });
        expect(calls).toBe(0);
    });

    test('a throwing onBatch rolls back that batch only, propagates, and leaves the handle writable', () => {
        let batch = 0;
        expect(() => streamWrite(handle, {
            readSql: KEYED_READ_SQL,
            params: { mod: 1 },
            keyColumn: 'id',
            onBatch: (rows) => {
                batch++;
                for (const row of rows) {
                    handle.run('UPDATE t SET v = ? WHERE id = ?', ['new', row.id]);
                }
                if (batch === 2) {
                    throw new Error('boom');
                }
            },
        })).toThrow('boom');
        expect(handle.get('SELECT COUNT(*) AS n FROM t WHERE v = \'new\'').n).toBe(1000);
        expect(() => handle.run('UPDATE t SET v = ? WHERE id = ?', ['after', 1])).not.toThrow();
    });
});

describe('native streamWrite() over more than one read chunk', () => {
    let tmpDir;
    let handle;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-sqlite-streamwrite-chunks-'));
        handle = openNativeDatabase(Database, path.join(tmpDir, 'db.sqlite'));
        handle.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
        handle.insertMany('INSERT INTO t (id, v) VALUES (@id, @v)', Array.from({ length: 100001 }, (_, i) => ({ id: i + 1, v: 'old' })));
    });

    afterEach(() => {
        handle.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('reopens the reader per 100000-row chunk and resumes after the last key: every row once, in key order', () => {
        const openReader = handle.openReader;
        let opens = 0;
        handle.openReader = () => {
            opens++;
            return openReader();
        };
        let expectedId = 1;
        let outOfOrder = 0;
        const batchSizes = [];
        streamWrite(handle, {
            readSql: KEYED_READ_SQL,
            params: { mod: 1 },
            keyColumn: 'id',
            onBatch: (rows) => {
                batchSizes.push(rows.length);
                for (const row of rows) {
                    if (row.id !== expectedId) outOfOrder++;
                    expectedId++;
                    handle.run('UPDATE t SET v = ? WHERE id = ?', ['new', row.id]);
                }
            },
        });
        expect(opens).toBe(2);
        expect(outOfOrder).toBe(0);
        expect(expectedId).toBe(100002);
        expect(batchSizes.length).toBe(101);
        expect(batchSizes[100]).toBe(1);
        expect(handle.get('SELECT COUNT(*) AS n FROM t WHERE v = \'old\'').n).toBe(0);
    });
});
