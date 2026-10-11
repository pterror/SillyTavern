import fs from 'node:fs';
import path from 'node:path';

import { cardWithStoredFav } from '../../character-card-storage.js';
import { assembleCardsSync, cardLayoutOf } from '../../character-card-reader.js';
import { defineCharacterStoreFunctions } from '../../character-store-schema.js';
import { openNativeDatabase } from '../../endpoints/sqlite-engine.js';
import { normalizeGroupRecord } from '../../group-id.js';

/**
 * Reads the library as today's server reads it from `character-metadata.sqlite` (the blob layout the user's file is in,
 * or the fields layout today's code writes) and the group files, never writing to either.
 */

/** Characters read per batch. */
export const BATCH = 500;

/**
 * @typedef {object} OldCharacter
 * @property {string} avatar
 * @property {Record<string, any> | null} card As stored with its stored fav (`cardWithStoredFav()`); null when its stored
 * JSON can't be read.
 * @property {boolean} fav
 * @property {number} dateAdded
 * @property {string | null} contentHash
 * @property {string | null} avatarIdentityHash
 * @property {string | null} activeChat
 * @property {string[]} tags Its tag rows' tag ids.
 */

/**
 * Opens an old database read-only. SQLite makes a WAL database's `-wal` and `-shm` files when a reader opens it with
 * none there (a server stopped cleanly removes them); the ones this open made, which a read-only connection leaves
 * empty of frames, are removed when it closes, so the old store's folder is as it was.
 * @param {any} Database better-sqlite3's constructor.
 * @param {string} file
 */
export function openReadOnly(Database, file) {
    const sidecars = ['-wal', '-shm'].map(s => file + s).filter(f => !fs.existsSync(f));
    const db = openNativeDatabase(Database, file, { readonly: true });
    const close = db.close.bind(db);
    db.close = () => {
        close();
        for (const f of sidecars) fs.rmSync(f, { force: true });
    };
    return db;
}

/**
 * @param {any} Database better-sqlite3's constructor.
 * @param {string} file
 */
export function openOld(Database, file) {
    const db = openReadOnly(Database, file);
    defineCharacterStoreFunctions(db);
    return db;
}

/**
 * @param {import('../../endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} table
 */
export function hasTable(db, table) {
    return !!db.get('SELECT 1 AS ok FROM sqlite_master WHERE type = \'table\' AND name = ?', [table]);
}

/**
 * @param {import('../../endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} table
 * @returns {Set<string>}
 */
export function columnsOf(db, table) {
    return new Set(/** @type {{ name: string }[]} */ (db.readBounded(`PRAGMA table_info("${table}")`, [], 1000)).map(c => c.name));
}

/**
 * The fields layout's cards of these characters, assembled; one that can't be assembled (a stored value that isn't
 * JSON) is left out.
 * @param {import('../../endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string[]} ids
 * @returns {Map<string, unknown>}
 */
function assembleEach(db, ids) {
    try {
        return assembleCardsSync(db, ids);
    } catch {
        /** @type {Map<string, unknown>} */
        const out = new Map();
        for (const id of ids) {
            try {
                for (const [k, v] of assembleCardsSync(db, [id])) out.set(k, v);
            } catch {
                // Left out: read as unreadable.
            }
        }
        return out;
    }
}

/**
 * Every character, a batch at a time in id order, with its tag rows.
 * @param {import('../../endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @returns {Generator<OldCharacter[]>}
 */
export function* characterBatches(db) {
    const layout = cardLayoutOf(db);
    const have = columnsOf(db, 'characters');
    const opt = (/** @type {string} */ c) => (have.has(c) ? c : `NULL AS ${c}`);
    const select = ['id', 'fav', 'date_added', opt('content_hash'), opt('avatar_identity_hash'), opt('active_chat'), ...(layout === 'blob' ? ['card_json'] : [])].join(', ');
    const tagsTable = hasTable(db, 'character_tags');
    let after = null;
    for (;;) {
        const rows = /** @type {Record<string, any>[]} */ (db.readBounded(
            `SELECT ${select} FROM characters ${after === null ? '' : 'WHERE id > ?'} ORDER BY id LIMIT ?`,
            after === null ? [BATCH] : [after, BATCH], BATCH));
        if (rows.length === 0) return;
        const ids = rows.map(r => r.id);
        const assembled = layout === 'fields' ? assembleEach(db, ids) : null;
        /** @type {Map<string, string[]>} */
        const tags = new Map();
        if (tagsTable) {
            for (const t of /** @type {Iterable<{ character_id: string, tag_id: string }>} */ (db.iterate(
                'SELECT character_id, tag_id FROM character_tags WHERE character_id IN (SELECT value FROM json_each(?)) ORDER BY character_id, tag_id', [JSON.stringify(ids)]))) {
                if (!tags.has(t.character_id)) tags.set(t.character_id, []);
                /** @type {string[]} */ (tags.get(t.character_id)).push(t.tag_id);
            }
        }
        yield rows.map(r => {
            let card = null;
            if (assembled) card = /** @type {any} */ (assembled.get(r.id) ?? null);
            else {
                try {
                    card = /** @type {any} */ (cardWithStoredFav(JSON.parse(r.card_json), !!r.fav));
                } catch {
                    card = null;
                }
            }
            return {
                avatar: r.id,
                card,
                fav: !!r.fav,
                dateAdded: Number(r.date_added),
                contentHash: r.content_hash ?? null,
                avatarIdentityHash: r.avatar_identity_hash ?? null,
                activeChat: r.active_chat ?? null,
                tags: tags.get(r.id) ?? [],
            };
        });
        after = rows[rows.length - 1].id;
        if (rows.length < BATCH) return;
    }
}

/**
 * Tag rows whose entity isn't a character today: the `character_tags` rows of no character.
 * @param {import('../../endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @returns {Generator<{ entity: string, tag: string }>}
 */
export function* strayCharacterTagRows(db) {
    if (!hasTable(db, 'character_tags')) return;
    yield* /** @type {Iterable<{ entity: string, tag: string }>} */ (db.iterate(
        'SELECT t.character_id AS entity, t.tag_id AS tag FROM character_tags t WHERE NOT EXISTS (SELECT 1 FROM characters c WHERE c.id = t.character_id) ORDER BY 1, 2'));
}

/**
 * @typedef {object} OldTags
 * @property {Map<string, Record<string, unknown>>} definitions Each tag row's definition (its `data`, id as the key).
 * @property {string[]} unreadable Tag rows whose `data` isn't a JSON object.
 * @property {Map<string, string | null>} deletions A deleted tag and the tag its rows read as (null: none).
 * @property {Map<string, string[]>} groupTags Each group's tag rows.
 * @property {{ entity: string, tag: string }[]} strayGroupTags `group_tags` rows read as no group's: a `.png` id (a
 * character's id, which the tag filter keeps out) or no group's file.
 * @property {{ key: string, value: string }[]} meta The meta rows the engine keeps: the settings import mark and the
 * seed-pending mark.
 * @property {{ id: number, mode: string } | null} pass The reorder pass recorded, if any.
 * @property {{ seq: number, tag: string, side: string | null, anchor: string | null, value: string | null }[]} queue
 * Moves queued under that pass.
 * @property {{ applied: number, warnings: string[] }} passLess Moves queued with no pass recorded, applied as the
 * fields converter applied them.
 */

/**
 * The tags as today's server reads them, with the moves queued with no reorder pass applied (as the fields converter
 * did, `applyPassLessTagMoves()`): on an in-memory copy of the tag tables, so the old file isn't written.
 * @param {any} Database
 * @param {import('../../endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {Set<string>} groupIds The groups today's server reads (each has a file).
 * @returns {Promise<OldTags>}
 */
export async function readTags(Database, db, groupIds) {
    const store = await import('../../character-metadata-db.js');
    /** @type {OldTags} */
    const out = { definitions: new Map(), unreadable: [], deletions: new Map(), groupTags: new Map(), strayGroupTags: [], meta: [], pass: null, queue: [], passLess: { applied: 0, warnings: [] } };
    if (!hasTable(db, 'tags')) return out;

    const copy = openNativeDatabase(Database, ':memory:');
    try {
        const tables = ['tags', 'tag_pending_moves', 'tag_pending_places', 'tag_deletions', 'tag_usage', 'tag_changes', 'tag_name_changes', 'meta'].filter(t => hasTable(db, t));
        const schema = /** @type {{ type: string, sql: string, tbl_name: string }[]} */ (db.readBounded(
            'SELECT type, sql, tbl_name FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid', [], 100000));
        for (const e of schema) if (e.type === 'table' && tables.includes(e.tbl_name)) copy.exec(e.sql);
        for (const table of tables) {
            const cols = [...columnsOf(db, table)];
            const insert = `INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
            copy.transaction(() => {
                for (const row of /** @type {Iterable<Record<string, unknown>>} */ (db.iterate(`SELECT ${cols.map(c => `"${c}"`).join(', ')} FROM "${table}"`))) {
                    copy.run(insert, cols.map(c => row[c]));
                }
            });
        }
        for (const e of schema) if (e.type !== 'table' && tables.includes(e.tbl_name)) copy.exec(e.sql);

        const pass = hasTable(copy, 'meta') ? store.tagReorderPassSync(copy) : null;
        if (pass === null && hasTable(copy, 'tag_pending_moves')) {
            for (;;) {
                /** @type {import('../../character-metadata-db.js').PendingTagMoveOutcome | null} */
                let outcome = null;
                copy.transaction(() => {
                    outcome = store.applyFirstPendingTagMoveSync(copy);
                });
                if (outcome === null) break;
                const { logs, failures } = /** @type {import('../../character-metadata-db.js').PendingTagMoveOutcome} */ (outcome);
                out.passLess.applied++;
                out.passLess.warnings.push(...store.tagTailNumberingWarnings(logs), ...failures.map(store.tagMoveFailedText));
            }
        }
        out.pass = pass === null ? null : { id: Number(pass.id), mode: String(pass.mode) };
        if (pass !== null && hasTable(copy, 'tag_pending_moves')) {
            out.queue = /** @type {any[]} */ (copy.readBounded('SELECT seq, tag_id AS tag, side, anchor_id AS anchor, value FROM tag_pending_moves ORDER BY seq', [], 10_000_000));
        }
        for (const row of /** @type {Iterable<{ id: string, data: string }>} */ (copy.iterate('SELECT id, data FROM tags ORDER BY rowid'))) {
            let data;
            try {
                data = JSON.parse(row.data);
            } catch {
                data = null;
            }
            if (data && typeof data === 'object' && !Array.isArray(data)) out.definitions.set(row.id, { ...data, id: row.id });
            else out.unreadable.push(row.id);
        }
        if (hasTable(copy, 'tag_deletions')) {
            for (const row of /** @type {Iterable<{ tag_id: string, merge_into: string | null }>} */ (copy.iterate('SELECT tag_id, merge_into FROM tag_deletions ORDER BY tag_id'))) {
                out.deletions.set(row.tag_id, row.merge_into ?? null);
            }
        }
        if (hasTable(copy, 'meta')) {
            for (const key of ['settings_tags_migrated', 'tags_seed_pending']) {
                const row = /** @type {{ value: string } | undefined} */ (copy.get('SELECT value FROM meta WHERE key = ?', [key]));
                if (row) out.meta.push({ key, value: row.value });
            }
        }
    } finally {
        copy.close();
    }
    if (hasTable(db, 'group_tags')) {
        for (const row of /** @type {Iterable<{ group_id: string, tag_id: string }>} */ (db.iterate('SELECT group_id, tag_id FROM group_tags ORDER BY group_id, tag_id'))) {
            if (row.group_id.endsWith('.png') || !groupIds.has(row.group_id)) {
                out.strayGroupTags.push({ entity: row.group_id, tag: row.tag_id });
                continue;
            }
            if (!out.groupTags.has(row.group_id)) out.groupTags.set(row.group_id, []);
            /** @type {string[]} */ (out.groupTags.get(row.group_id)).push(row.tag_id);
        }
    }
    return out;
}

/**
 * The tag a tag row reads as today: a deleted tag's rows read as the tag it merged into, or as none.
 * @param {OldTags} tags
 * @param {string} tag
 * @returns {string | null}
 */
export function readsAs(tags, tag) {
    return tags.deletions.has(tag) ? /** @type {string | null} */ (tags.deletions.get(tag)) : tag;
}

/**
 * @typedef {object} OldGroup
 * @property {Record<string, any> & { id: string }} group Its file, as today's server reads it.
 * @property {number} dateAdded The row's, else the file's birth time (`/api/groups/all`'s).
 * @property {string} file
 */

/**
 * The groups today's server reads: each `<id>.json` file in the groups folder whose JSON is an object with a string
 * id, its fav as the file holds it; its date added the row's.
 * @param {import('../../endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} groupsDir
 * @returns {{ groups: OldGroup[], unread: { file: string, reason: string }[], rowsWithoutFile: string[] }}
 */
export function readGroups(db, groupsDir) {
    /** @type {OldGroup[]} */
    const groups = [];
    /** @type {{ file: string, reason: string }[]} */
    const unread = [];
    /** @type {Map<string, number>} */
    const rows = new Map();
    if (hasTable(db, 'groups')) {
        for (const r of /** @type {Iterable<{ id: string, date_added: number }>} */ (db.iterate('SELECT id, date_added FROM groups'))) rows.set(r.id, Number(r.date_added));
    }
    const files = fs.existsSync(groupsDir) ? fs.readdirSync(groupsDir).filter(f => path.extname(f) === '.json').sort() : [];
    /** @type {Map<string, OldGroup>} */
    const byId = new Map();
    for (const file of files) {
        const full = path.join(groupsDir, file);
        let group;
        try {
            group = normalizeGroupRecord(JSON.parse(fs.readFileSync(full, 'utf8')));
        } catch (err) {
            unread.push({ file, reason: `can't be read: ${/** @type {Error} */ (err).message}` });
            continue;
        }
        if (!group || typeof group !== 'object' || Array.isArray(group) || typeof group.id !== 'string' || group.id === '') {
            unread.push({ file, reason: 'not a group with a string id' });
            continue;
        }
        const other = byId.get(group.id);
        if (other) {
            // `/api/groups/batch` reads `<id>.json`; another file with the same id is left out.
            const own = `${group.id}.json`;
            if (other.file === own || file !== own) {
                unread.push({ file, reason: `another file (${other.file}) holds group ${group.id}` });
                continue;
            }
            unread.push({ file: other.file, reason: `another file (${file}) holds group ${group.id}` });
        }
        const birth = Math.round(fs.statSync(full).birthtimeMs);
        byId.set(group.id, { group, dateAdded: rows.get(group.id) ?? birth, file });
    }
    for (const g of byId.values()) groups.push(g);
    const rowsWithoutFile = [...rows.keys()].filter(id => !byId.has(id)).sort();
    return { groups, unread, rowsWithoutFile };
}

/**
 * The cards of these characters as stored, with their stored fav (null for one whose JSON can't be read).
 * @param {import('../../endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string[]} avatars
 * @returns {Map<string, Record<string, any> | null>}
 */
export function cardsOf(db, avatars) {
    /** @type {Map<string, Record<string, any> | null>} */
    const out = new Map();
    const layout = cardLayoutOf(db);
    for (let i = 0; i < avatars.length; i += BATCH) {
        const ids = avatars.slice(i, i + BATCH);
        if (layout === 'fields') {
            const assembled = assembleEach(db, ids);
            for (const id of ids) out.set(id, /** @type {any} */ (assembled.get(id) ?? null));
            continue;
        }
        for (const r of /** @type {Iterable<{ id: string, fav: number, card_json: string }>} */ (db.iterate(
            'SELECT id, fav, card_json FROM characters WHERE id IN (SELECT value FROM json_each(?))', [JSON.stringify(ids)]))) {
            try {
                out.set(r.id, /** @type {any} */ (cardWithStoredFav(JSON.parse(r.card_json), !!r.fav)));
            } catch {
                out.set(r.id, null);
            }
        }
    }
    return out;
}
