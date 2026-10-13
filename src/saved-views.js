import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';

import { getBetterSqlite3 } from './endpoints/native-sqlite.js';
import { foldName } from './fold-name.js';
import { userStore } from './user-stores.js';

/**
 * A user's saved views of the character list, in `<user>/character-metadata.sqlite` (the one thing the server still
 * keeps there until storage stage 6 moves it into the store): a name and the view object the page lists by
 * (public/scripts/character-view.js), in the user's own order. `views_version` in `meta` goes up on every write, so
 * a page can ask whether anything changed.
 */

/** Emits `changed` (the user's root) when a user's saved views changed. */
export const savedViewsEvents = new EventEmitter();
savedViewsEvents.setMaxListeners(0);

/** Longest view name and view object a saved view keeps. */
export const SAVED_VIEW_NAME_MAX = 200;
export const SAVED_VIEW_JSON_MAX = 64 * 1024;
/** Most views one list read answers. */
export const SAVED_VIEWS_PAGE_MAX = 200;
/** The most views a respace renumbers in one move; a user's own saved views stay well under it. */
const SAVED_VIEWS_RESPACE_MAX = 100000;

const FILE = 'character-metadata.sqlite';

const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS saved_views (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        name_fold  TEXT NOT NULL,
        view_json  TEXT NOT NULL,
        position   REAL NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_saved_views_position ON saved_views(position, id);
`;

/**
 * @typedef {{ id: string, name: string, view: object, position: number, updatedAt: number }} SavedView
 */

/** @type {Map<string, Promise<any>>} By the user's root directory. */
const open = new Map();

/**
 * The user's views database, opened once. The user's store is opened first, so a new user's file never makes the
 * directory read as data from before the engine (user-stores.js).
 * @param {{ root: string }} directories
 */
function database(directories) {
    const key = path.resolve(directories.root);
    let found = open.get(key);
    if (!found) {
        found = (async () => {
            await userStore(directories);
            const Database = await getBetterSqlite3();
            const db = new Database(path.join(key, FILE));
            db.pragma('journal_mode = WAL');
            db.exec(SCHEMA_SQL);
            return db;
        })();
        open.set(key, found);
        found.catch(() => open.delete(key));
    }
    return found;
}

/** Closes every views database. */
export async function closeSavedViews() {
    const all = [...open.values()];
    open.clear();
    for (const p of all) {
        try {
            (await p).close();
        } catch {
            // One that failed to open has nothing to close.
        }
    }
}

/** @param {{ id: string, name: string, view_json: string, position: number, updated_at: number }} row @returns {SavedView} */
function savedViewFromRow(row) {
    return { id: row.id, name: row.name, view: JSON.parse(row.view_json), position: row.position, updatedAt: row.updated_at };
}

/** @param {any} db */
function readVersion(db) {
    const row = db.prepare('SELECT value FROM meta WHERE key = \'views_version\'').get();
    return Number(row?.value ?? 0);
}

/**
 * Marks a write to the saved views, in the caller's transaction.
 * @param {any} db
 */
function bumpVersion(db) {
    db.prepare('INSERT INTO meta (key, value) VALUES (\'views_version\', \'1\') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1').run();
}

/**
 * The rows a bounded statement reads, at most `bound`.
 * @param {any} statement
 * @param {Record<string, unknown>} params
 * @param {number} bound
 */
function readBounded(statement, params, bound) {
    const rows = [];
    for (const row of statement.iterate(params)) {
        rows.push(row);
        if (rows.length >= bound) break;
    }
    return rows;
}

/**
 * One page of the user's saved views in their order, those whose names hold `contains` when it is given.
 * @param {{ root: string }} directories
 * @param {{ contains?: string, after?: { position: number, id: string } | null, limit?: number }} [options]
 * @returns {Promise<{ version: number, views: SavedView[], more: boolean }>}
 */
export async function listSavedViews(directories, { contains = '', after = null, limit = SAVED_VIEWS_PAGE_MAX } = {}) {
    const db = await database(directories);
    const take = Math.max(1, Math.min(Math.trunc(limit) || SAVED_VIEWS_PAGE_MAX, SAVED_VIEWS_PAGE_MAX));
    const needle = foldName(String(contains).trim());
    const clauses = [];
    /** @type {Record<string, unknown>} */
    const params = { limit: take + 1 };
    if (after) {
        clauses.push('(position > @afterPosition OR (position = @afterPosition AND id > @afterId))');
        params.afterPosition = after.position;
        params.afterId = after.id;
    }
    if (needle) {
        clauses.push('instr(name_fold, @needle) > 0');
        params.needle = needle;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const version = readVersion(db);
    const rows = readBounded(db.prepare(`SELECT id, name, view_json, position, updated_at FROM saved_views ${where} ORDER BY position, id LIMIT @limit`), params, take + 1);
    return { version, views: rows.slice(0, take).map(savedViewFromRow), more: rows.length > take };
}

/**
 * One saved view, or null when no view has the id.
 * @param {{ root: string }} directories
 * @param {string} id
 * @returns {Promise<SavedView | null>}
 */
export async function getSavedView(directories, id) {
    const db = await database(directories);
    const row = db.prepare('SELECT id, name, view_json, position, updated_at FROM saved_views WHERE id = @id').get({ id });
    return row ? savedViewFromRow(row) : null;
}

/**
 * Saves a new view after the user's others.
 * @param {{ root: string }} directories
 * @param {{ name: string, view: object }} params
 * @returns {Promise<SavedView>}
 */
export async function createSavedView(directories, { name, view }) {
    const db = await database(directories);
    const id = crypto.randomUUID();
    const now = Date.now();
    const position = db.transaction(() => {
        const last = db.prepare('SELECT position FROM saved_views ORDER BY position DESC, id DESC LIMIT 1').get();
        const at = last ? Math.floor(last.position) + 1 : 1;
        db.prepare('INSERT INTO saved_views (id, name, name_fold, view_json, position, updated_at) VALUES (@id, @name, @fold, @json, @position, @now)')
            .run({ id, name, fold: foldName(name), json: JSON.stringify(view), position: at, now });
        bumpVersion(db);
        return at;
    })();
    savedViewsEvents.emit('changed', directories.root);
    return { id, name, view, position, updatedAt: now };
}

/**
 * Changes one view's name or view object. Writes nothing when neither differs.
 * @param {{ root: string }} directories
 * @param {string} id
 * @param {{ name?: string, view?: object }} change
 * @returns {Promise<SavedView | null>} null when no view has the id.
 */
export async function changeSavedView(directories, id, { name, view }) {
    const db = await database(directories);
    const done = db.transaction(() => {
        const row = db.prepare('SELECT id, name, view_json, position, updated_at FROM saved_views WHERE id = @id').get({ id });
        if (!row) return { result: null, wrote: false };
        const nextName = name ?? row.name;
        const nextJson = view !== undefined ? JSON.stringify(view) : row.view_json;
        if (nextName === row.name && nextJson === row.view_json) return { result: savedViewFromRow(row), wrote: false };
        const now = Date.now();
        db.prepare('UPDATE saved_views SET name = @name, name_fold = @fold, view_json = @json, updated_at = @now WHERE id = @id')
            .run({ id, name: nextName, fold: foldName(nextName), json: nextJson, now });
        bumpVersion(db);
        return { result: { id, name: nextName, view: JSON.parse(nextJson), position: row.position, updatedAt: now }, wrote: true };
    })();
    if (done.wrote) savedViewsEvents.emit('changed', directories.root);
    return done.result;
}

/**
 * Deletes one view.
 * @param {{ root: string }} directories
 * @param {string} id
 * @returns {Promise<boolean>} false when no view had the id.
 */
export async function deleteSavedView(directories, id) {
    const db = await database(directories);
    const deleted = db.transaction(() => {
        const gone = db.prepare('DELETE FROM saved_views WHERE id = @id').run({ id }).changes > 0;
        if (gone) bumpVersion(db);
        return gone;
    })();
    if (deleted) savedViewsEvents.emit('changed', directories.root);
    return deleted;
}

/**
 * Moves one view to just before or just after another. Its position goes halfway between its new neighbours; when
 * they are too close for that, the views from the anchor on are numbered apart again.
 * @param {{ root: string }} directories
 * @param {string} id
 * @param {{ anchor: string, side: 'before' | 'after' }} where
 * @returns {Promise<'moved' | 'unchanged' | 'missing'>} 'missing' when either view doesn't exist.
 */
export async function moveSavedView(directories, id, { anchor, side }) {
    const db = await database(directories);
    const positionOf = db.prepare('SELECT position FROM saved_views WHERE id = @id');
    const setPosition = db.prepare('UPDATE saved_views SET position = @position WHERE id = @id AND position <> @position');
    /** @type {'moved' | 'unchanged' | 'missing'} */
    const outcome = db.transaction(() => {
        if (id === anchor) return 'unchanged';
        const moving = positionOf.get({ id });
        const at = positionOf.get({ id: anchor });
        if (!moving || !at) return 'missing';
        const beside = side === 'before'
            ? db.prepare('SELECT id FROM saved_views WHERE position < @p OR (position = @p AND id < @anchor) ORDER BY position DESC, id DESC LIMIT 1').get({ p: at.position, anchor })
            : db.prepare('SELECT id FROM saved_views WHERE position > @p OR (position = @p AND id > @anchor) ORDER BY position, id LIMIT 1').get({ p: at.position, anchor });
        if (beside?.id === id) return 'unchanged';
        const neighbour = side === 'before'
            ? db.prepare('SELECT id, position FROM saved_views WHERE (position < @p OR (position = @p AND id < @anchor)) AND id <> @id ORDER BY position DESC, id DESC LIMIT 1').get({ p: at.position, anchor, id })
            : db.prepare('SELECT id, position FROM saved_views WHERE (position > @p OR (position = @p AND id > @anchor)) AND id <> @id ORDER BY position, id LIMIT 1').get({ p: at.position, anchor, id });
        const low = side === 'before' ? (neighbour ? neighbour.position : at.position - 2) : at.position;
        const high = side === 'before' ? at.position : (neighbour ? neighbour.position : at.position + 2);
        let position = (low + high) / 2;
        if (!(position > low && position < high)) {
            // Too close to split: space out every view from `low` on by whole numbers, then split the new gap.
            let next = Math.floor(low) + 2;
            const rows = readBounded(db.prepare('SELECT id FROM saved_views WHERE position >= @low AND id <> @id ORDER BY position, id LIMIT @cap'), { low, id, cap: SAVED_VIEWS_RESPACE_MAX }, SAVED_VIEWS_RESPACE_MAX);
            for (const row of rows) {
                setPosition.run({ id: row.id, position: next });
                next += 2;
            }
            const anchorNow = positionOf.get({ id: anchor });
            position = side === 'before' ? anchorNow.position - 1 : anchorNow.position + 1;
        }
        setPosition.run({ id, position });
        bumpVersion(db);
        return 'moved';
    })();
    if (outcome === 'moved') savedViewsEvents.emit('changed', directories.root);
    return outcome;
}
