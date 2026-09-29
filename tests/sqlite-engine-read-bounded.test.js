import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import NodeSqlite3Wasm from 'node-sqlite3-wasm';

import { openNativeDatabase, openWasmDatabase } from '../src/endpoints/sqlite-engine.js';

const { Database: WasmDatabase } = NodeSqlite3Wasm;

describe.each([
    ['native', (dbPath) => openNativeDatabase(Database, dbPath)],
    ['wasm', (dbPath) => openWasmDatabase(WasmDatabase, dbPath)],
])('%s engine readBounded()', (_name, open) => {
    let tmpDir;
    let handle;
    let rowsProduced;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-sqlite-read-bounded-'));
        handle = open(path.join(tmpDir, 'db.sqlite'));
        handle.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
        handle.insertMany('INSERT INTO t (id, v) VALUES (@id, @v)', [1, 2, 3, 4, 5].map(id => ({ id, v: `v${id}` })));
        rowsProduced = 0;
        handle.defineFunction('counted', (id) => { rowsProduced++; return id; });
    });

    afterEach(() => {
        handle.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('returns every row when there are fewer than max, binding unprefixed named params', () => {
        expect(handle.readBounded('SELECT id, v FROM t WHERE id > @min ORDER BY id', { min: 2 }, 10))
            .toEqual([{ id: 3, v: 'v3' }, { id: 4, v: 'v4' }, { id: 5, v: 'v5' }]);
    });

    test('returns every row when there are exactly max, binding positional params', () => {
        expect(handle.readBounded('SELECT id FROM t WHERE id <= ? ORDER BY id', [3], 3).map(r => r.id)).toEqual([1, 2, 3]);
    });

    test('takes no params', () => {
        expect(handle.readBounded('SELECT id FROM t ORDER BY id', undefined, 5).map(r => r.id)).toEqual([1, 2, 3, 4, 5]);
    });

    test('max 0 returns an empty array for no rows and throws for one', () => {
        expect(handle.readBounded('SELECT id FROM t WHERE id > 99', undefined, 0)).toEqual([]);
        expect(() => handle.readBounded('SELECT id FROM t', undefined, 0)).toThrow('more than 0 rows');
    });

    test('throws when more than max rows come back, after reading only max + 1', () => {
        expect(() => handle.readBounded('SELECT counted(id) AS n FROM t', undefined, 2))
            .toThrow('readBounded(): more than 2 rows for: SELECT counted(id) AS n FROM t');
        expect(rowsProduced).toBe(3);
    });

    test('leaves no read open after it throws, so writes go through', () => {
        expect(() => handle.readBounded('SELECT id FROM t', undefined, 1)).toThrow('more than 1 rows');
        expect(() => handle.run('DELETE FROM t WHERE id = 1')).not.toThrow();
        expect(() => handle.transaction(() => { handle.run('DELETE FROM t WHERE id = 2'); })).not.toThrow();
        expect(handle.get('SELECT COUNT(*) AS n FROM t').n).toBe(3);
    });

    test('leaves no read open after it returns, so writes go through', () => {
        handle.readBounded('SELECT id FROM t', undefined, 5);
        expect(() => handle.run('DELETE FROM t WHERE id = 1')).not.toThrow();
        expect(handle.get('SELECT COUNT(*) AS n FROM t').n).toBe(4);
    });

    test.each([
        ['missing', undefined],
        ['negative', -1],
        ['fractional', 1.5],
        ['a string', '3'],
        ['NaN', NaN],
        ['Infinity', Infinity],
    ])('throws a TypeError without reading when max is %s', (_label, max) => {
        expect(() => handle.readBounded('SELECT counted(id) AS n FROM t', undefined, max)).toThrow(TypeError);
        expect(rowsProduced).toBe(0);
    });

    test('throws after close()', () => {
        const closedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-sqlite-read-bounded-closed-'));
        const closed = open(path.join(closedDir, 'db.sqlite'));
        closed.close();
        try {
            expect(() => closed.readBounded('SELECT 1', undefined, 1)).toThrow('database handle is closed');
        } finally {
            fs.rmSync(closedDir, { recursive: true, force: true });
        }
    });
});
