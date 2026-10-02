import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Every table of the two sqlite stores has exactly one module that writes it. Anything else that wants to change a
// table calls that module; a stray INSERT/UPDATE/DELETE/REPLACE anywhere else under src/ fails here.

const SRC = path.join(process.cwd(), '..', 'src');

const METADATA_OWNER = 'character-metadata-db.js';
const TREE_OWNER = 'message-tree-db.js';
/** Tree tables written by a module other than message-tree-db.js. */
const TREE_OVERRIDES = {
    meta: 'message-tree-meta.js',
    owner_message_stats: 'message-stats.js',
    token_counts: 'token-count-store.js',
    token_ids: 'token-count-store.js',
};

/** Writes whatever table its caller names; the call names the table, and that is what's checked (writtenTables()). */
const ROW_WRITER = 'row-values.js';

const SQL_KEYWORDS = new Set(['SET', 'OF', 'ON', 'INTO', 'FROM', 'WHERE', 'SELECT', 'VALUES']);

/**
 * The tables a source text writes, by statement keyword or by a `writeRowIfChanged(db, 'table', ...)` call. Comment
 * lines are skipped; upserts' `DO UPDATE` and triggers' `UPDATE OF` aren't statements of their own.
 * @param {string} source
 * @returns {string[]} Table names; a name built at runtime (`${...}`) comes back as '*'.
 */
function writtenTables(source) {
    const code = source.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    const re = /(?<!\bDO\s+)\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+([`"[]?(?:\$\{[^}]+\}|[A-Za-z_][A-Za-z0-9_.]*))/gi;
    /** @type {string[]} */
    const tables = [];
    for (const m of code.matchAll(re)) {
        const name = m[1].replace(/^[`"[]/, '');
        if (name.startsWith('${')) {
            tables.push('*');
            continue;
        }
        if (SQL_KEYWORDS.has(name.toUpperCase())) continue;
        // Only SQL-looking statements: the keyword must be upper case, as every statement in src/ writes it.
        if (!/^(INSERT|REPLACE|UPDATE|DELETE)/.test(m[0])) continue;
        tables.push(name.split('.').pop());
    }
    for (const m of code.matchAll(/\bwriteRowIfChanged\(\s*[^,]+,\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|[^,]+)/g)) {
        tables.push(m[1] ?? '*');
    }
    return tables;
}

/**
 * @param {string} file Path relative to src/.
 * @param {string[]} tables
 * @param {{ metadata: Set<string>, tree: Set<string> }} stores
 * @returns {string[]} The writes that aren't the file's to make.
 */
function strayWrites(file, tables, stores) {
    if (file === ROW_WRITER) return tables.filter(table => table !== '*').map(table => `${file}: writes ${table}`);
    const owns = (/** @type {string} */ table) =>
        (stores.metadata.has(table) && file === METADATA_OWNER)
        || (stores.tree.has(table) && (TREE_OVERRIDES[table] ?? TREE_OWNER) === file);
    const ownerModules = new Set([METADATA_OWNER, TREE_OWNER, ...Object.values(TREE_OVERRIDES)]);
    return tables.filter(table => {
        if (owns(table)) return false;
        // A table created at runtime (or named at runtime) is fine in an owner module: it's that store's own.
        const known = stores.metadata.has(table) || stores.tree.has(table);
        if ((table === '*' || !known) && ownerModules.has(file)) return false;
        return true;
    }).map(table => `${file}: writes ${table}`);
}

/** @param {string} dir @returns {string[]} */
function sourceFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(full);
        return entry.name.endsWith('.js') && !entry.name.endsWith('.test.js') ? [full] : [];
    });
}

/** @type {{ metadata: Set<string>, tree: Set<string> }} */
let stores;
let root = '';

beforeAll(async () => {
    const util = await import('../src/util.js');
    util.setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    const metadataDb = await import('../src/character-metadata-db.js');
    const treeDb = await import('../src/message-tree-db.js');
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-store-write-owners-test-'));
    const directories = /** @type {any} */ ({
        root,
        characters: path.join(root, 'characters'),
        chats: path.join(root, 'chats'),
        groups: path.join(root, 'groups'),
        groupChats: path.join(root, 'groupChats'),
    });
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    await metadataDb.ensureSchemaMigrated(directories);
    await treeDb.getMessageTreeDb(directories);
    metadataDb.disposeMetadataStores();
    treeDb.disposeMessageTreeStores();

    const Database = (await import('better-sqlite3')).default;
    /** @param {string} file */
    const tablesOf = (file) => {
        const db = new Database(path.join(root, file), { readonly: true });
        try {
            return new Set(Array.from(db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\'').iterate(), r => r.name));
        } finally {
            db.close();
        }
    };
    stores = { metadata: tablesOf('character-metadata.sqlite'), tree: tablesOf('message-tree.sqlite') };
});

afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('each store table has one writer', () => {
    test('nothing under src/ writes a store table it doesn\'t own', () => {
        expect(stores.metadata.size).toBeGreaterThan(10);
        expect(stores.tree.has('messages')).toBe(true);
        const stray = sourceFiles(SRC).flatMap(full => {
            const file = path.relative(SRC, full).split(path.sep).join('/');
            return strayWrites(file, writtenTables(fs.readFileSync(full, 'utf8')), stores);
        });
        expect(stray).toEqual([]);
    });

    test('a stray write is caught', () => {
        const source = [
            'export function f(db) {',
            '    db.run(\'UPDATE messages SET label = @l WHERE id = @id\', { l, id });',
            '    db.run(`INSERT INTO meta (key, value) VALUES (@k, @v) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);',
            '    db.run(\'DELETE FROM characters WHERE id = @id\', { id });',
            '}',
        ].join('\n');
        expect(strayWrites('endpoints/whatever.js', writtenTables(source), stores)).toEqual([
            'endpoints/whatever.js: writes messages',
            'endpoints/whatever.js: writes meta',
            'endpoints/whatever.js: writes characters',
        ]);
        // The tree's meta has its own writer; the tree module itself writing it is stray too.
        expect(strayWrites(TREE_OWNER, writtenTables(source), stores)).toEqual([
            `${TREE_OWNER}: writes meta`,
            `${TREE_OWNER}: writes characters`,
        ]);
    });

    test('a write through writeRowIfChanged counts as a write of the table it names', () => {
        const source = [
            'writeRowIfChanged(db, \'messages\', { id }, { label });',
            'writeRowIfChanged(entry.db, \'meta\', { key }, { value }, { insert: true });',
            'writeRowIfChanged(db, table, { id }, { label });',
        ].join('\n');
        expect(writtenTables(source)).toEqual(['messages', 'meta', '*']);
        expect(strayWrites('endpoints/whatever.js', writtenTables(source), stores)).toEqual([
            'endpoints/whatever.js: writes messages',
            'endpoints/whatever.js: writes meta',
            'endpoints/whatever.js: writes *',
        ]);
        expect(strayWrites(TREE_OWNER, writtenTables(source), stores)).toEqual([`${TREE_OWNER}: writes meta`]);
    });

    test('comments and upsert/trigger clauses aren\'t writes', () => {
        const source = [
            '// UPDATE characters SET name = 1',
            ' * DELETE FROM messages',
            'const s = `CREATE TRIGGER t AFTER UPDATE OF fav ON characters BEGIN SELECT 1; END`;',
            'const u = \'INSERT INTO owner_message_stats (a) VALUES (1) ON CONFLICT(a) DO UPDATE SET a = 2\';',
        ].join('\n');
        expect(writtenTables(source)).toEqual(['owner_message_stats']);
    });
});
