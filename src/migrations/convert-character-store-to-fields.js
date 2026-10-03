import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { CARD_COLUMNS, splitCard, canonicalCardHash, cardWithStoredFav } from '../character-card-storage.js';
import { CARD_LAYOUT_META_KEY, assembleCardsSync, cardLayoutOf } from '../character-card-reader.js';
import { BUILT_ON_NEED, FIELDS_CHARACTER_INDEXES, defineCharacterStoreFunctions, isBuiltOnNeedMetaKey } from '../character-store-schema.js';
import { openNativeDatabase } from '../endpoints/sqlite-engine.js';
import { ProgressLog } from '../progress-log.js';
import { delay, setConfigFilePath } from '../util.js';
import { probeConfiguredServer } from './cleanup-zztest-leftovers.js';

/**
 * Converts one user's character store (`character-metadata.sqlite`) from the blob layout (each card one `card_json`
 * blob) to the fields layout the server reads. Run once, by hand, with the server stopped:
 *
 *   node src/migrations/convert-character-store-to-fields.js --server-stopped [--data-root ./data] [--handle default-user] [--config ./config.yaml]
 *
 * 1. checks there is room on disk for the new file (about the old file's size);
 * 2. builds `character-metadata.next.sqlite` with every table, index and trigger of the current code's schema
 *    (an empty store its own opener makes, never the old file's schema): every other table's rows copied, except
 *    the derived tables built on need (BUILT_ON_NEED; `random_ranks` keeps only the whole-list and fav spaces);
 *    every card split (splitCard()) into its `characters` row and the card tables; the indexes and then the
 *    triggers created once the rows are in, so no trigger fires on a copied row. An old table or column the current
 *    schema has no place for, and that holds a value, is left out with a warning listing it;
 * 3. verifies: every copied table has the rows the old one has, and every card assembles to the canonical hash of
 *    cardWithStoredFav(card_json, fav) with its other row values unchanged. Any difference stops it, lists what
 *    differed, and deletes the new file;
 * 4. swaps the files: the old one becomes `character-metadata.pre-fields.sqlite`, kept for the user to delete once
 *    the server has started cleanly on the new one.
 *
 * The new file is written with the journal off; a run that stops partway leaves a file the next run deletes and
 * builds again. The old file is never written to (only its WAL is folded into it first).
 */

/** The new file, next to the live one. */
export const NEXT_SUFFIX = '.next.sqlite';
/** The old file, after the swap. */
export const PRE_FIELDS_SUFFIX = '.pre-fields.sqlite';
/** meta key in the new file: set once it is verified, so an interrupted swap can tell a finished file from a partial one. */
export const CONVERSION_VERIFIED_META_KEY = 'fields_conversion_verified';

/**
 * @typedef {object} ConversionProgress
 * @property {'copying' | 'checking'} phase
 * @property {number} done Cards copied (or checked) so far.
 * @property {number} total Cards in the old file.
 */

/**
 * @typedef {{ ok: true, cards: number, tables: Record<string, number>, leftOut: string[] }
 *   | { ok: false, reason: string, ids?: string[] }} ConversionResult
 */

/**
 * @param {string} livePath
 */
export function nextPathOf(livePath) {
    return livePath.replace(/\.sqlite$/, '') + NEXT_SUFFIX;
}

/**
 * @param {string} livePath
 */
export function preFieldsPathOf(livePath) {
    return livePath.replace(/\.sqlite$/, '') + PRE_FIELDS_SUFFIX;
}

/** @param {string} file */
function removeDatabaseFiles(file) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(file + suffix, { force: true });
}

/** @param {string} name */
function quoteIdent(name) {
    return `"${String(name).replace(/"/g, '""')}"`;
}

/** @param {number} bytes */
function gigabytes(bytes) {
    return `${(bytes / 1e9).toFixed(1)} GB`;
}

/**
 * A table of the current schema and how its rows come over from the old file.
 * @typedef {object} CopiedTable
 * @property {string} name
 * @property {string[]} columns The columns both files have, which are copied.
 * @property {boolean} withoutRowid
 * @property {string[]} keyColumns The keyset the copy pages by: the primary key of a WITHOUT ROWID table, else rowid.
 * @property {boolean} rowidAlias The table's INTEGER PRIMARY KEY is its rowid, so copying that column keeps the rowid.
 * @property {string} where A filter on the rows copied ('' for every row).
 * @property {(row: Record<string, unknown>) => boolean} keep A filter on the rows copied, in JS.
 */

/**
 * The schema of the current code: an empty store created by the store's own opener in a scratch folder, read back
 * as SQL, then deleted. Every table, index and trigger of the new file comes from it, never from the old file.
 * @param {string} scratchRoot A folder that doesn't exist yet.
 * @returns {Promise<{ tables: { name: string, sql: string }[], indexes: string[], triggers: string[] }>}
 */
async function readCurrentSchema(scratchRoot) {
    const { ensureSchemaMigrated, disposeMetadataStores } = await import('../character-metadata-db.js');
    const { getSqliteEngine } = await import('../endpoints/sqlite-engine.js');
    const engine = await getSqliteEngine();
    if (!engine) throw new Error('no usable SQLite engine');
    try {
        await ensureSchemaMigrated(/** @type {import('../users.js').UserDirectoryList} */ ({ root: scratchRoot, groups: path.join(scratchRoot, 'groups'), characters: path.join(scratchRoot, 'characters') }));
        disposeMetadataStores();
        const template = engine.openDatabase(path.join(scratchRoot, 'character-metadata.sqlite'), { readonly: true });
        defineCharacterStoreFunctions(template);
        try {
            const master = /** @type {{ type: string, name: string, sql: string | null }[]} */ (template.readBounded(
                'SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid', [], 10000));
            return {
                tables: master.filter(e => e.type === 'table' && !e.name.startsWith('sqlite_')).map(e => ({ name: e.name, sql: /** @type {string} */ (e.sql) })),
                indexes: master.filter(e => e.type === 'index').map(e => /** @type {string} */ (e.sql)),
                triggers: master.filter(e => e.type === 'trigger').map(e => /** @type {string} */ (e.sql)),
            };
        } finally {
            template.close();
        }
    } finally {
        fs.rmSync(scratchRoot, { recursive: true, force: true });
    }
}

/**
 * How each table of the current schema is filled from the old file: by the columns both have, except the card
 * tables (filled by the split), `characters` (split), and the tables built on need (left empty).
 * @param {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} old
 * @param {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} next The new file, its tables created.
 * @param {{ name: string }[]} tables
 * @returns {{ copied: CopiedTable[], problems: string[], leftOut: string[] }} problems: what stops the conversion;
 *   leftOut: old tables and columns the current schema has no place for, each with how many rows hold a value.
 */
function planCopies(old, next, tables) {
    const notCopied = new Set(['characters', ...CARD_PART_TABLE_NAMES, ...BUILT_ON_NEED.tables]);
    const oldTables = new Set(/** @type {{ name: string }[]} */ (old.readBounded('SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\'', [], 10000)).map(r => r.name));
    /** @type {CopiedTable[]} */
    const copied = [];
    /** @type {string[]} */
    const problems = [];
    /** @type {string[]} */
    const leftOut = [];
    for (const { name } of tables) {
        if (notCopied.has(name) || !oldTables.has(name)) continue;
        const info = /** @type {{ name: string, type: string, pk: number, notnull: number, dflt_value: unknown, hidden: number }[]} */ (next.readBounded(`PRAGMA table_xinfo(${quoteIdent(name)})`, [], 1000))
            .filter(c => c.hidden === 0);
        const oldColumns = new Set(/** @type {{ name: string }[]} */ (old.readBounded(`PRAGMA table_info(${quoteIdent(name)})`, [], 1000)).map(c => c.name));
        for (const c of info) {
            if (!oldColumns.has(c.name) && c.notnull && c.dflt_value === null && !c.pk) problems.push(`${name}.${c.name} has no value in the old file and can't be empty`);
        }
        for (const column of oldColumns) {
            if (info.some(c => c.name === column)) continue;
            const held = Number(/** @type {{ n: number }} */ (old.get(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)} WHERE ${quoteIdent(column)} IS NOT NULL`)).n);
            if (held > 0) leftOut.push(`column ${name}.${column} (${held} row(s) with a value)`);
        }
        const withoutRowid = /WITHOUT\s+ROWID\s*$/i.test(String(/** @type {{ sql: string }} */ (next.get('SELECT sql FROM sqlite_master WHERE name = ?', [name])).sql).trim());
        const pk = info.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk);
        const rowidAlias = !withoutRowid && pk.length === 1 && pk[0].type.toUpperCase() === 'INTEGER';
        /** @type {CopiedTable} */
        const table = {
            name,
            columns: info.map(c => c.name).filter(c => oldColumns.has(c)),
            withoutRowid,
            keyColumns: withoutRowid ? pk.map(c => c.name) : [rowidAlias ? pk[0].name : 'rowid'],
            rowidAlias,
            where: '',
            keep: () => true,
        };
        if (name === 'random_ranks') table.where = `space IN (${BUILT_ON_NEED.randomSpacesKept.map(s => `'${s}'`).join(', ')})`;
        if (name === 'meta') table.keep = row => !isBuiltOnNeedMetaKey(String(row.key)) && row.key !== CONVERSION_VERIFIED_META_KEY && row.key !== CARD_LAYOUT_META_KEY;
        copied.push(table);
    }
    const currentNames = new Set(tables.map(t => t.name));
    for (const name of oldTables) {
        if (currentNames.has(name)) continue;
        const rows = Number(/** @type {{ n: number }} */ (old.get(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`)).n);
        if (rows > 0) leftOut.push(`table ${name} (${rows} row(s))`);
    }
    return { copied, problems, leftOut };
}

const CARD_PART_TABLE_NAMES = Object.freeze(['cards', 'card_greetings', 'card_tags', 'card_extensions', 'card_extra']);

/** The blob layout's `characters` columns the conversion can't do without. */
const REQUIRED_OLD_CHARACTER_COLUMNS = Object.freeze(['id', 'fav', 'date_added', 'date_last_chat', 'chat_size', 'data_size', 'change_seq', 'card_json']);

/** The rest it copies, with the value a row gets when the old file has no such column. */
const OPTIONAL_OLD_CHARACTER_COLUMNS = Object.freeze({
    create_date: null, active_chat: null, allow_global_styles: null, content_hash: null, content_identity_hash: null,
    avatar_identity_hash: null, import_poisoned: 1,
});

/** The `characters` columns copied unchanged; the old `change_seq` becomes `version`. */
const COPIED_CHARACTER_COLUMNS = Object.freeze(['fav', 'date_added', 'create_date', 'date_last_chat', 'chat_size', 'data_size', 'active_chat',
    'allow_global_styles', 'content_hash', 'content_identity_hash', 'avatar_identity_hash', 'import_poisoned']);

const CARD_COLUMN_NAMES = Object.keys(CARD_COLUMNS);
const INSERT_CARD_ROW_SQL = `INSERT INTO cards (character_id, ${CARD_COLUMN_NAMES.join(', ')}) VALUES (?, ${CARD_COLUMN_NAMES.map(() => '?').join(', ')})`;

const INSERT_CHARACTER_SQL = `INSERT INTO characters (id, name, creator, character_version, world, create_date_raw, version, ${COPIED_CHARACTER_COLUMNS.join(', ')})
    VALUES (@id, @name, @creator, @character_version, @world, @create_date_raw, @version, ${COPIED_CHARACTER_COLUMNS.map(c => `@${c}`).join(', ')})`;

/**
 * The select list that reads the old `characters` rows: every required column, and each optional one or its default.
 * @param {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} old
 * @returns {{ select: string, missing: string[] }}
 */
function oldCharacterSelect(old) {
    const have = new Set(/** @type {{ name: string }[]} */ (old.readBounded('PRAGMA table_info(characters)', [], 1000)).map(c => c.name));
    const missing = REQUIRED_OLD_CHARACTER_COLUMNS.filter(c => !have.has(c));
    const optional = Object.entries(OPTIONAL_OLD_CHARACTER_COLUMNS).map(([c, fallback]) => (have.has(c) ? c : `${fallback === null ? 'NULL' : fallback} AS ${c}`));
    return { select: [...REQUIRED_OLD_CHARACTER_COLUMNS, ...optional].join(', '), missing };
}

/**
 * Times a loop of batches: each batch runs until `budgetMs` has passed, then the loop pauses `pauseMs`.
 * @param {number} budgetMs
 * @param {number} pauseMs
 */
function batchClock(budgetMs, pauseMs) {
    let started = performance.now();
    return {
        overBudget: () => performance.now() - started >= budgetMs,
        async pause() {
            await delay(pauseMs);
            started = performance.now();
        },
    };
}

/**
 * Builds and verifies the fields-layout file for the store at `livePath` (see the module comment). The new file is
 * left only when the result is ok; otherwise it is deleted.
 * @param {object} options
 * @param {(file: string, options?: import('../endpoints/sqlite-engine.js').SqliteOpenOptions) => import('../endpoints/sqlite-engine.js').SqliteEngineHandle} options.openDatabase
 * @param {string} options.livePath
 * @param {number} [options.budgetMs] Work per batch before a pause.
 * @param {number} [options.pauseMs]
 * @param {number} [options.batchRows] Rows one read of the old file takes at most.
 * @param {(progress: ConversionProgress) => void} [options.onProgress]
 * @param {() => boolean} [options.isStopping] Checked between batches: true stops the build and deletes the new file.
 * @param {(dir: string) => number} [options.freeBytes] The bytes free on the disk holding `dir`.
 * @returns {Promise<ConversionResult>}
 */
export async function buildFieldsStore({
    openDatabase,
    livePath,
    budgetMs = 50,
    pauseMs = 10,
    batchRows = 200,
    onProgress = () => {},
    isStopping = () => false,
    freeBytes = dir => { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); },
}) {
    const nextPath = nextPathOf(livePath);
    removeDatabaseFiles(nextPath);

    const needed = fs.statSync(livePath).size;
    const free = freeBytes(path.dirname(livePath));
    if (free < needed) {
        return {
            ok: false,
            reason: `There isn't enough free disk space to update the character database: it needs about ${gigabytes(needed)} free next to ${livePath}, and ${gigabytes(free)} is free.`,
        };
    }

    const schema = await readCurrentSchema(path.join(path.dirname(livePath), `.fields-schema-${process.pid}`));

    // Folds any WAL content into the old file, so it is whole by itself before it is read or, later, renamed.
    const checkpointer = openDatabase(livePath);
    checkpointer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    checkpointer.close();

    const old = openDatabase(livePath, { readonly: true });
    const next = openDatabase(nextPath);
    let keep = false;
    try {
        const { select: oldSelect, missing } = oldCharacterSelect(old);
        if (missing.length > 0) {
            return { ok: false, reason: `The character database's characters table is missing columns the update reads: ${missing.join(', ')}.` };
        }
        next.exec('PRAGMA journal_mode = OFF');
        next.exec('PRAGMA synchronous = OFF');
        next.exec('PRAGMA cache_size = -65536');
        defineCharacterStoreFunctions(next);

        for (const table of schema.tables) next.exec(table.sql);
        const { copied, problems, leftOut } = planCopies(old, next, schema.tables);
        if (problems.length > 0) return { ok: false, reason: `The old character database can't be read into the current one: ${problems.join('; ')}.` };

        const total = Number(/** @type {{ n: number }} */ (old.get('SELECT COUNT(*) AS n FROM characters')).n);
        const clock = batchClock(budgetMs, pauseMs);
        const stopped = () => isStopping();

        for (const table of copied) {
            if (!(await copyTable(old, next, table, batchRows, clock, stopped))) return { ok: false, reason: 'stopped' };
        }
        next.run('INSERT INTO meta (key, value) VALUES (@key, \'fields\')', { key: CARD_LAYOUT_META_KEY });
        copySequences(old, next, new Set(copied.map(t => t.name)));

        /** @type {string[]} */
        const unreadable = [];
        if (!(await splitCharacters(old, next, oldSelect, batchRows, clock, stopped, unreadable, done => onProgress({ phase: 'copying', done, total })))) return { ok: false, reason: 'stopped' };
        if (unreadable.length > 0) {
            return { ok: false, reason: `${unreadable.length} card(s) couldn't be read, so the character database wasn't updated.`, ids: unreadable };
        }

        // The sort indexes the default views read at once, then the rest of the schema; the triggers last, so none
        // fired on the rows copied.
        for (const sql of [...FIELDS_CHARACTER_INDEXES.map(index => index.sql), ...schema.indexes, ...schema.triggers]) {
            if (stopped()) return { ok: false, reason: 'stopped' };
            next.exec(sql.replace(/^CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/i, 'CREATE $1INDEX IF NOT EXISTS ').replace(/^CREATE TRIGGER (?!IF NOT EXISTS)/i, 'CREATE TRIGGER IF NOT EXISTS '));
            await clock.pause();
        }

        const tables = /** @type {Record<string, number>} */ ({});
        const countMismatches = verifyCounts(old, next, copied, tables);
        if (countMismatches.length > 0) {
            return { ok: false, reason: `Some tables came out with a different number of rows: ${countMismatches.join('; ')}.` };
        }
        /** @type {string[]} */
        const mismatched = [];
        if (!(await verifyCards(old, next, oldSelect, batchRows, clock, stopped, mismatched, done => onProgress({ phase: 'checking', done, total })))) return { ok: false, reason: 'stopped' };
        if (mismatched.length > 0) {
            return { ok: false, reason: `${mismatched.length} card(s) didn't come out the same, so the character database wasn't updated.`, ids: mismatched };
        }
        tables.characters = total;

        next.run('INSERT INTO meta (key, value) VALUES (@key, @value)', { key: CONVERSION_VERIFIED_META_KEY, value: String(Date.now()) });
        next.exec('PRAGMA journal_mode = WAL');
        keep = true;
        return { ok: true, cards: total, tables, leftOut };
    } finally {
        old.close();
        next.close();
        if (!keep) removeDatabaseFiles(nextPath);
    }
}

/**
 * Copies one table's rows in keyset pages, each page read with one bounded statement and written in one transaction.
 * @param {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} old
 * @param {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} next
 * @param {CopiedTable} table
 * @param {number} batchRows
 * @param {ReturnType<typeof batchClock>} clock
 * @param {() => boolean} stopped
 * @returns {Promise<boolean>} false when stopped.
 */
async function copyTable(old, next, table, batchRows, clock, stopped) {
    const keys = table.keyColumns;
    const selectColumns = [...(table.withoutRowid || table.rowidAlias ? [] : ['rowid AS "__rowid"']), ...table.columns.map(quoteIdent)].join(', ');
    const keyOf = (/** @type {Record<string, unknown>} */ row) => keys.map(k => (k === 'rowid' ? row.__rowid : row[k]));
    const keySql = keys.map(k => (k === 'rowid' ? 'rowid' : quoteIdent(k)));
    const order = keySql.join(', ');
    const after = keys.length === 1 ? `${keySql[0]} > ?` : `(${keySql.join(', ')}) > (${keys.map(() => '?').join(', ')})`;
    const where = (/** @type {boolean} */ paged) => {
        const parts = [table.where, paged ? after : ''].filter(Boolean);
        return parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '';
    };
    const insertColumns = [...(table.withoutRowid || table.rowidAlias ? [] : ['rowid']), ...table.columns];
    const insertSql = `INSERT INTO ${quoteIdent(table.name)} (${insertColumns.map(c => (c === 'rowid' ? 'rowid' : quoteIdent(c))).join(', ')}) VALUES (${insertColumns.map(() => '?').join(', ')})`;

    /** @type {unknown[] | null} */
    let last = null;
    for (;;) {
        if (stopped()) return false;
        const rows = /** @type {Record<string, unknown>[]} */ (old.readBounded(
            `SELECT ${selectColumns} FROM ${quoteIdent(table.name)} ${where(last !== null)} ORDER BY ${order} LIMIT ?`,
            [...(last ?? []), batchRows], batchRows));
        if (rows.length === 0) return true;
        next.transaction(() => {
            for (const row of rows) {
                if (!table.keep(row)) continue;
                next.run(insertSql, insertColumns.map(c => (c === 'rowid' ? row.__rowid : row[c])));
            }
        });
        last = keyOf(rows[rows.length - 1]);
        if (rows.length < batchRows) return true;
        if (clock.overBudget()) await clock.pause();
    }
}

/**
 * Carries over each copied AUTOINCREMENT table's high-water mark, so no seq the old file handed out is handed out again.
 * @param {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} old
 * @param {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} next
 * @param {Set<string>} copied
 */
function copySequences(old, next, copied) {
    if (!old.get('SELECT 1 FROM sqlite_master WHERE name = \'sqlite_sequence\'')) return;
    const rows = /** @type {{ name: string, seq: number }[]} */ (old.readBounded('SELECT name, seq FROM sqlite_sequence', [], 10000));
    next.transaction(() => {
        for (const { name, seq } of rows) {
            if (!copied.has(name)) continue;
            next.run('DELETE FROM sqlite_sequence WHERE name = ?', [name]);
            next.run('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)', [name, seq]);
        }
    });
}

/**
 * Splits every card into the new file, a page of characters at a time in id order.
 * @param {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} old
 * @param {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} next
 * @param {string} oldSelect oldCharacterSelect()'s select list.
 * @param {number} batchRows
 * @param {ReturnType<typeof batchClock>} clock
 * @param {() => boolean} stopped
 * @param {string[]} unreadable Ids whose card_json doesn't parse, filled in.
 * @param {(done: number) => void} onProgress
 * @returns {Promise<boolean>} false when stopped.
 */
async function splitCharacters(old, next, oldSelect, batchRows, clock, stopped, unreadable, onProgress) {
    let after = null;
    let done = 0;
    for (;;) {
        if (stopped()) return false;
        const rows = /** @type {Record<string, any>[]} */ (old.readBounded(
            `SELECT ${oldSelect} FROM characters ${after === null ? '' : 'WHERE id > ?'} ORDER BY id LIMIT ?`,
            after === null ? [batchRows] : [after, batchRows], batchRows));
        if (rows.length === 0) return true;
        next.transaction(() => {
            for (const row of rows) {
                let card;
                try {
                    card = JSON.parse(row.card_json);
                } catch {
                    unreadable.push(row.id);
                    continue;
                }
                writeSplitCard(next, row, splitCard(card));
            }
        });
        after = rows[rows.length - 1].id;
        done += rows.length;
        onProgress(done);
        if (rows.length < batchRows) return true;
        if (clock.overBudget()) await clock.pause();
    }
}

/**
 * @param {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} next
 * @param {Record<string, any>} row The old row.
 * @param {import('../character-card-storage.js').CardParts} parts
 */
function writeSplitCard(next, row, parts) {
    const id = row.id;
    const { columns } = parts;
    /** @type {Record<string, unknown>} */
    const values = {
        id,
        name: columns.name ?? null,
        creator: columns.creator ?? null,
        character_version: columns.character_version ?? null,
        world: columns.world ?? null,
        create_date_raw: columns.create_date ?? null,
        version: row.change_seq,
    };
    for (const column of COPIED_CHARACTER_COLUMNS) values[column] = row[column];
    next.run(INSERT_CHARACTER_SQL, values);
    next.run(INSERT_CARD_ROW_SQL, [id, ...CARD_COLUMN_NAMES.map(column => parts.card[column] ?? null)]);
    for (const g of parts.greetings) next.run('INSERT INTO card_greetings (character_id, list, position, text) VALUES (?, ?, ?, ?)', [id, g.list, g.position, g.text]);
    for (const t of parts.tags) next.run('INSERT INTO card_tags (character_id, position, name) VALUES (?, ?, ?)', [id, t.position, t.name]);
    for (const e of parts.extensions) next.run('INSERT INTO card_extensions (character_id, key, value) VALUES (?, ?, ?)', [id, e.key, e.value]);
    for (const x of parts.extra) next.run('INSERT INTO card_extra (character_id, path, value) VALUES (?, ?, ?)', [id, x.path, x.value]);
}

/**
 * Compares each copied table's row count in both files (the old one counted with the copy's own filter).
 * @param {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} old
 * @param {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} next
 * @param {CopiedTable[]} tables
 * @param {Record<string, number>} counts Filled in with the new file's counts.
 * @returns {string[]} One line per table whose counts differ.
 */
function verifyCounts(old, next, tables, counts) {
    /** @type {string[]} */
    const mismatches = [];
    for (const table of tables) {
        const name = quoteIdent(table.name);
        let expected = Number(/** @type {{ n: number }} */ (old.get(`SELECT COUNT(*) AS n FROM ${name} ${table.where ? `WHERE ${table.where}` : ''}`)).n);
        let got = Number(/** @type {{ n: number }} */ (next.get(`SELECT COUNT(*) AS n FROM ${name}`)).n);
        if (table.name === 'meta') {
            expected -= /** @type {{ key: string }[]} */ (old.readBounded('SELECT key FROM meta', [], 100000)).filter(row => !table.keep(row)).length;
            // The layout row and the verified mark (not written yet) are the new file's own.
            got -= 1;
        }
        counts[table.name] = got;
        if (got !== expected) mismatches.push(`${table.name}: ${got} of ${expected}`);
    }
    const oldCharacters = Number(/** @type {{ n: number }} */ (old.get('SELECT COUNT(*) AS n FROM characters')).n);
    const nextCharacters = Number(/** @type {{ n: number }} */ (next.get('SELECT COUNT(*) AS n FROM characters')).n);
    if (oldCharacters !== nextCharacters) mismatches.push(`characters: ${nextCharacters} of ${oldCharacters}`);
    return mismatches;
}

/**
 * Checks every character in the new file against the old one, a page at a time: the assembled card hashes as
 * cardWithStoredFav(card_json, fav) does, and the row's other values are the old row's.
 * @param {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} old
 * @param {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} next
 * @param {string} oldSelect oldCharacterSelect()'s select list.
 * @param {number} batchRows
 * @param {ReturnType<typeof batchClock>} clock
 * @param {() => boolean} stopped
 * @param {string[]} mismatched Ids that differ, filled in.
 * @param {(done: number) => void} onProgress
 * @returns {Promise<boolean>} false when stopped.
 */
async function verifyCards(old, next, oldSelect, batchRows, clock, stopped, mismatched, onProgress) {
    let after = null;
    let done = 0;
    for (;;) {
        if (stopped()) return false;
        const rows = /** @type {Record<string, any>[]} */ (old.readBounded(
            `SELECT ${oldSelect} FROM characters ${after === null ? '' : 'WHERE id > ?'} ORDER BY id LIMIT ?`,
            after === null ? [batchRows] : [after, batchRows], batchRows));
        if (rows.length === 0) return true;
        mismatched.push(...differingCards(next, rows));
        after = rows[rows.length - 1].id;
        done += rows.length;
        onProgress(done);
        if (rows.length < batchRows) return true;
        if (clock.overBudget()) await clock.pause();
    }
}

/**
 * The ids among `oldRows` whose card or row values differ in `next`.
 * @param {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} next
 * @param {Record<string, any>[]} oldRows Rows of the blob layout, read with oldCharacterSelect()'s select list.
 * @returns {string[]}
 */
export function differingCards(next, oldRows) {
    const ids = oldRows.map(row => row.id);
    const assembled = assembleCardsSync(next, ids);
    /** @type {Map<string, Record<string, unknown>>} */
    const nextRows = new Map();
    for (const row of /** @type {Iterable<Record<string, any>>} */ (next.iterate(
        `SELECT id, version, ${COPIED_CHARACTER_COLUMNS.join(', ')} FROM characters WHERE id IN (SELECT value FROM json_each(?))`, [JSON.stringify(ids)]))) {
        nextRows.set(row.id, row);
    }
    /** @type {string[]} */
    const differing = [];
    for (const row of oldRows) {
        const nextRow = nextRows.get(row.id);
        if (!nextRow || !assembled.has(row.id)) {
            differing.push(row.id);
            continue;
        }
        let expected;
        try {
            expected = canonicalCardHash(cardWithStoredFav(JSON.parse(row.card_json), !!row.fav));
        } catch {
            differing.push(row.id);
            continue;
        }
        const sameValues = nextRow.version === row.change_seq && COPIED_CHARACTER_COLUMNS.every(column => nextRow[column] === row[column]);
        if (!sameValues || canonicalCardHash(assembled.get(row.id)) !== expected) differing.push(row.id);
    }
    return differing;
}

/**
 * Puts a verified new file in place of the live one: the live file becomes `.pre-fields.sqlite`, the new file takes
 * its name. Nothing may have either open.
 * @param {string} livePath
 */
export function swapFieldsStoreIn(livePath) {
    const nextPath = nextPathOf(livePath);
    const prePath = preFieldsPathOf(livePath);
    removeDatabaseFiles(prePath);
    fs.renameSync(livePath, prePath);
    for (const suffix of ['-wal', '-shm']) fs.rmSync(livePath + suffix, { force: true });
    fs.renameSync(nextPath, livePath);
    for (const suffix of ['-wal', '-shm', '-journal']) fs.rmSync(nextPath + suffix, { force: true });
}

const LOG_PREFIX = '[convert-to-fields]';

/** @param {string} file */
function sizeOf(file) {
    return fs.existsSync(file) ? fs.statSync(file).size : 0;
}

/**
 * @param {object} options
 * @param {string} options.dataRoot
 * @param {string} options.handle
 * @param {boolean} options.serverStopped
 * @param {any} options.Database better-sqlite3 constructor, or null when the native binding isn't usable.
 * @param {() => Promise<{ running: boolean, lines: string[] }>} [options.probeServer]
 * @param {(line: string) => void} [options.log]
 * @param {(line: string) => void} [options.warn]
 * @param {number} [options.batchRows]
 * @param {(dir: string) => number} [options.freeBytes]
 * @returns {Promise<number>} Process exit code: 0 converted (or nothing to convert), 1 refused or failed.
 */
export async function runConversion(options) {
    const { dataRoot, handle, serverStopped, Database } = options;
    const log = options.log ?? console.log;
    const warn = options.warn ?? console.warn;
    const probeServer = options.probeServer ?? probeConfiguredServer;
    const livePath = path.join(dataRoot, handle, 'character-metadata.sqlite');
    const prePath = preFieldsPathOf(livePath);

    log(`${LOG_PREFIX} ${livePath}`);
    if (!Database) {
        warn(`${LOG_PREFIX} REFUSED: native better-sqlite3 is not available; this script never opens these databases with the wasm engine`);
        return 1;
    }
    if (!serverStopped) {
        warn(`${LOG_PREFIX} REFUSED: needs --server-stopped (stop the server first; a --port override is not visible to the port probe)`);
        return 1;
    }
    const probe = await probeServer();
    probe.lines.forEach(line => log(`${LOG_PREFIX} ${line}`));
    if (probe.running) {
        warn(`${LOG_PREFIX} REFUSED: the server appears to be running (or the port could not be checked); stop it and rerun`);
        return 1;
    }
    if (!fs.existsSync(livePath)) {
        warn(`${LOG_PREFIX} REFUSED: ${livePath} does not exist`);
        return 1;
    }
    const peek = openNativeDatabase(Database, livePath, { readonly: true });
    const layout = cardLayoutOf(peek);
    peek.close();
    if (layout === 'fields') {
        log(`${LOG_PREFIX} already in the fields layout; nothing to do.`);
        return 0;
    }
    if (fs.existsSync(prePath)) {
        warn(`${LOG_PREFIX} REFUSED: ${prePath} already exists; move it away first, so the old file can be kept there`);
        return 1;
    }

    const started = Date.now();
    const oldBytes = sizeOf(livePath);
    /** @type {Record<string, ProgressLog>} */
    const progress = {};
    const result = await buildFieldsStore({
        openDatabase: (file, openOptions) => openNativeDatabase(Database, file, openOptions),
        livePath,
        pauseMs: 0,
        batchRows: options.batchRows,
        freeBytes: options.freeBytes,
        onProgress: ({ phase, done, total }) => {
            progress[phase] ??= new ProgressLog({ what: `${LOG_PREFIX} ${phase === 'copying' ? 'splitting cards into fields' : 'checking every card against the old file'}`, total, log });
            progress[phase].add(done - progress[phase].done);
        },
    });
    for (const line of Object.values(progress)) line.finish();
    if (!result.ok) {
        warn(`${LOG_PREFIX} FAILED: ${result.reason}`);
        if (result.ids) warn(`${LOG_PREFIX} ${result.ids.join('\n')}`);
        warn(`${LOG_PREFIX} the old file is untouched and the new one was deleted.`);
        return 1;
    }
    const newBytes = sizeOf(nextPathOf(livePath));
    swapFieldsStoreIn(livePath);
    log(`${LOG_PREFIX} done in ${((Date.now() - started) / 1000).toFixed(1)} s: ${result.cards.toLocaleString('en-US')} cards, every one checked.`);
    if (result.leftOut.length > 0) warn(`${LOG_PREFIX} WARNING: left out, the current schema has no place for them:\n${result.leftOut.map(line => `  ${line}`).join('\n')}`);
    log(`${LOG_PREFIX} rows copied per table: ${Object.entries(result.tables).map(([name, n]) => `${name} ${n.toLocaleString('en-US')}`).join(', ')}`);
    log(`${LOG_PREFIX} sizes: old ${(oldBytes / 1e6).toFixed(1)} MB, new ${(newBytes / 1e6).toFixed(1)} MB.`);
    log(`${LOG_PREFIX} the old file is kept as ${prePath}; delete it once the server has started cleanly.`);
    return 0;
}

/**
 * @param {string[]} argv
 * @returns {{ dataRoot: string, handle: string, config: string, serverStopped: boolean, unknown: string[] }}
 */
export function parseArgs(argv) {
    const out = { dataRoot: './data', handle: 'default-user', config: './config.yaml', serverStopped: false, unknown: /** @type {string[]} */ ([]) };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--server-stopped') out.serverStopped = true;
        else if ((arg === '--data-root' || arg === '--handle' || arg === '--config') && argv[i + 1] !== undefined) {
            out[{ '--data-root': 'dataRoot', '--handle': 'handle', '--config': 'config' }[arg]] = argv[++i];
        } else out.unknown.push(arg);
    }
    return out;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    const args = parseArgs(process.argv.slice(2));
    if (args.unknown.length > 0) {
        console.warn(`${LOG_PREFIX} usage: --server-stopped [--data-root ./data] [--handle default-user] [--config ./config.yaml]`);
        console.warn(`${LOG_PREFIX} unknown argument(s): ${args.unknown.join(' ')}`);
        process.exitCode = 2;
    } else {
        setConfigFilePath(args.config);
        const { getBetterSqlite3 } = await import('../endpoints/native-sqlite.js');
        const Database = await getBetterSqlite3();
        process.exitCode = await runConversion({ dataRoot: args.dataRoot, handle: args.handle, serverStopped: args.serverStopped, Database });
    }
}
