import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setConfigFilePath } from '../src/util.js';
import { getBetterSqlite3 } from '../src/endpoints/native-sqlite.js';
import { main, OLD_TRIGGERS } from '../src/migrations/upgrade-message-stats.js';

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
 * A message-tree.sqlite as an older version left it: the four counter triggers, a stats table with a row, the
 * given stats version and a finished fill.
 * @param {string | null} version
 * @returns {{ dataRoot: string, treePath: string }}
 */
function oldStore(version) {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-message-stats-'));
    dirs.push(dataRoot);
    fs.mkdirSync(path.join(dataRoot, 'u'));
    const treePath = path.join(dataRoot, 'u', 'message-tree.sqlite');
    const db = new Database(treePath);
    db.exec(`
        CREATE TABLE messages (id TEXT PRIMARY KEY, parent_id TEXT, owner_id TEXT NOT NULL, content TEXT NOT NULL);
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE owner_message_stats (owner_id TEXT PRIMARY KEY, user_msgs INTEGER NOT NULL DEFAULT 0);
        INSERT INTO owner_message_stats (owner_id, user_msgs) VALUES ('rex', 3);
        INSERT INTO meta (key, value) VALUES ('message_stats_filled', '1');
    `);
    for (const name of OLD_TRIGGERS) db.exec(`CREATE TRIGGER ${name} AFTER INSERT ON messages BEGIN SELECT 1; END`);
    if (version !== null) db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('message_stats_version', version);
    db.close();
    return { dataRoot, treePath };
}

/**
 * @param {string} dataRoot
 * @param {string[]} args
 * @param {object} [more]
 */
async function run(dataRoot, args, more = {}) {
    /** @type {string[]} */
    const lines = [];
    const code = await main([...args, '--data-root', dataRoot, '--handle', 'u'], {
        Database, probeServer: notRunning, log: l => lines.push(l), warn: l => lines.push(l), ...more,
    });
    return { code, lines };
}

/** @param {string} treePath */
function read(treePath) {
    const db = new Database(treePath, { readonly: true });
    try {
        return {
            triggers: db.prepare('SELECT name FROM sqlite_master WHERE type = \'trigger\' ORDER BY name').all().map(r => r.name),
            stats: db.prepare('SELECT * FROM owner_message_stats').all(),
            meta: Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map(r => [r.key, r.value])),
        };
    } finally {
        db.close();
    }
}

describe('upgrade-message-stats', () => {
    test('usage errors exit 2', async () => {
        const { dataRoot } = oldStore('1');
        expect((await run(dataRoot, [])).code).toBe(2);
        expect((await run(dataRoot, ['--dry-run', '--apply'])).code).toBe(2);
        expect((await run(dataRoot, ['--dry-run', '--nope'])).code).toBe(2);
    });

    test('a real run without --server-stopped, or with the server running, is refused and writes nothing', async () => {
        const { dataRoot, treePath } = oldStore('1');
        const before = fs.readFileSync(treePath);
        expect((await run(dataRoot, ['--apply'])).code).toBe(1);
        expect((await run(dataRoot, ['--apply', '--server-stopped'], { probeServer: async () => ({ running: true, lines: [] }) })).code).toBe(1);
        expect(fs.readFileSync(treePath).equals(before)).toBe(true);
    });

    test('a dry run lists what would change and writes nothing', async () => {
        const { dataRoot, treePath } = oldStore('0');
        const before = fs.readFileSync(treePath);
        const { code, lines } = await run(dataRoot, ['--dry-run']);
        expect(code).toBe(0);
        expect(lines.join('\n')).toContain(`would drop ${OLD_TRIGGERS.join(', ')}`);
        expect(lines.join('\n')).toContain('would rebuild the counters table');
        expect(fs.readFileSync(treePath).equals(before)).toBe(true);
    });

    test('at the current version: drops the old triggers and keeps the counters', async () => {
        const { dataRoot, treePath } = oldStore('1');
        expect((await run(dataRoot, ['--apply', '--server-stopped'])).code).toBe(0);
        const after = read(treePath);
        expect(after.triggers).toEqual([]);
        expect(after.stats).toEqual([{ owner_id: 'rex', user_msgs: 3 }]);
        expect(after.meta).toEqual({ message_stats_version: '1', message_stats_filled: '1' });
    });

    test('at another version: also rebuilds the counters table and restarts the fill', async () => {
        const { dataRoot, treePath } = oldStore('0');
        expect((await run(dataRoot, ['--apply', '--server-stopped'])).code).toBe(0);
        const after = read(treePath);
        expect(after.triggers).toEqual([]);
        expect(after.stats).toEqual([]);
        expect(after.meta).toEqual({ message_stats_version: '1' });
    });

    test('a store already upgraded is left alone', async () => {
        const { dataRoot, treePath } = oldStore('1');
        expect((await run(dataRoot, ['--apply', '--server-stopped'])).code).toBe(0);
        const before = fs.readFileSync(treePath);
        const { code, lines } = await run(dataRoot, ['--apply', '--server-stopped']);
        expect(code).toBe(0);
        expect(lines.join('\n')).toContain('nothing to change');
        expect(fs.readFileSync(treePath).equals(before)).toBe(true);
    });
});
