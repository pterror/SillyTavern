import { describe, test, expect, jest, beforeAll, afterAll } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

const engine = await import('../src/endpoints/sqlite-engine.js');

/** @type {{ path: string, options: object, busyTimeout: number }[]} */
const opens = [];
/** @type {{ method: string, sql: string, args: any[] }[]} */
const calls = [];

jest.unstable_mockModule('../src/endpoints/sqlite-engine.js', () => ({
    ...engine,
    openNativeDatabase: (DatabaseCtor, dbPath, options) => {
        const handle = engine.openNativeDatabase(DatabaseCtor, dbPath, options);
        opens.push({ path: dbPath, options, busyTimeout: handle.get('PRAGMA busy_timeout').timeout });
        for (const method of ['all', 'get', 'iterate', 'readBounded', 'query']) {
            const real = handle[method];
            handle[method] = (sql, ...args) => {
                calls.push({ method, sql, args });
                return real(sql, ...args);
            };
        }
        return handle;
    },
}));

const CHARACTER_COUNT = 12;
let dataRoot;
let charDbBytes;
let treeDbBytes;
/** @type {string[]} */
let output;

function buildCharacterDb(dbPath) {
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE characters (name_fold TEXT, fav INTEGER, data_size INTEGER, chat_size INTEGER,
            date_added INTEGER, date_last_chat INTEGER);
        CREATE TABLE groups (fav INTEGER, chat_size INTEGER);
        CREATE TABLE tags (id TEXT PRIMARY KEY, data TEXT);
        CREATE TABLE character_tags (tag_id TEXT);
        CREATE TABLE group_tags (tag_id TEXT);
        CREATE TABLE tag_usage (tag_id TEXT, count INTEGER);
    `);
    const insertCharacter = db.prepare('INSERT INTO characters VALUES (?, ?, ?, ?, ?, ?)');
    const insertTag = db.prepare('INSERT INTO tags VALUES (?, ?)');
    const insertUsage = db.prepare('INSERT INTO tag_usage VALUES (?, ?)');
    for (let i = 1; i <= CHARACTER_COUNT; i++) {
        insertCharacter.run(`char${i}`, i % 2, i * 1000, i * 2000, Date.UTC(2026, 0, i), Date.UTC(2026, 1, i));
        insertTag.run(`tag${i}`, JSON.stringify({ name: `Tag ${i}` }));
        insertUsage.run(`tag${i}`, i);
    }
    db.prepare('INSERT INTO groups VALUES (1, 500)').run();
    db.prepare('INSERT INTO character_tags VALUES (\'tag1\')').run();
    db.close();
}

function buildTreeDb(dbPath) {
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE branches (id INTEGER PRIMARY KEY);
        CREATE TABLE messages (id INTEGER PRIMARY KEY);
        INSERT INTO branches (id) VALUES (1), (2);
        INSERT INTO messages (id) VALUES (1), (2), (3);
    `);
    db.close();
}

/** The lines between a heading's underline and the next blank line. */
function section(title) {
    const start = output.indexOf(title);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = output.indexOf('', start);
    return output.slice(start + 2, end === -1 ? undefined : end);
}

beforeAll(async () => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'st-stats-script-'));
    buildCharacterDb(path.join(dataRoot, 'character-metadata.sqlite'));
    buildTreeDb(path.join(dataRoot, 'message-tree.sqlite'));
    charDbBytes = fs.readFileSync(path.join(dataRoot, 'character-metadata.sqlite'));
    treeDbBytes = fs.readFileSync(path.join(dataRoot, 'message-tree.sqlite'));

    output = [];
    const log = jest.spyOn(console, 'log').mockImplementation((...args) => { output.push(args.join(' ')); });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const argv = process.argv;
    process.argv = [argv[0], 'stats.js', '--data-root', dataRoot];
    try {
        await import('../scripts/stats.js');
    } finally {
        process.argv = argv;
        log.mockRestore();
        warn.mockRestore();
    }
});

afterAll(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('scripts/stats.js', () => {
    test('opens both dbs read-only through the engine with a 5 second busy timeout', () => {
        expect(opens.map(o => path.basename(o.path))).toEqual(['character-metadata.sqlite', 'message-tree.sqlite']);
        for (const open of opens) {
            expect(open.options).toEqual({ readonly: true, busyTimeoutMs: 5000 });
            expect(open.busyTimeout).toBe(5000);
        }
    });

    test('the five top-10 reads go through readBounded with max 10 and LIMIT 10; nothing reads with all()', () => {
        const bounded = calls.filter(c => c.method === 'readBounded');
        expect(bounded).toHaveLength(5);
        for (const call of bounded) {
            expect(call.sql).toContain('LIMIT @limit');
            expect(call.args).toEqual([{ limit: 10 }, 10]);
        }
        expect(calls.filter(c => c.method !== 'readBounded' && c.method !== 'get')).toEqual([]);
    });

    test('prints the overview totals', () => {
        expect(output).toEqual(expect.arrayContaining([
            expect.stringMatching(/Total characters:\s+12$/),
            expect.stringMatching(/Total groups:\s+1$/),
            expect.stringMatching(/Total favorites:\s+6 characters, 1 groups$/),
            expect.stringMatching(/Total tags:\s+12$/),
            expect.stringMatching(/Total tag assignments:\s+1$/),
            expect.stringMatching(/Total branches \(chats\):\s+2$/),
            expect.stringMatching(/Total messages:\s+3$/),
        ]));
    });

    test('each top-10 section lists the 10 highest rows in order', () => {
        const top = (from) => Array.from({ length: 10 }, (_, i) => from - i);
        expect(section('Top 10 tags by usage').slice(2).map(l => l.trim().split(/\s{2,}/)))
            .toEqual(top(12).map(i => [`Tag ${i}`, String(i)]));
        for (const title of [
            '10 most recently added characters',
            '10 most recently chatted characters',
            'Top 10 characters by data size',
            'Top 10 characters by chat size',
        ]) {
            expect(section(title).slice(2).map(l => l.trim().split(/\s{2,}/)[0])).toEqual(top(12).map(i => `char${i}`));
        }
    });

    test('leaves both db files byte-for-byte unchanged', () => {
        expect(fs.readFileSync(path.join(dataRoot, 'character-metadata.sqlite')).equals(charDbBytes)).toBe(true);
        expect(fs.readFileSync(path.join(dataRoot, 'message-tree.sqlite')).equals(treeDbBytes)).toBe(true);
    });
});
