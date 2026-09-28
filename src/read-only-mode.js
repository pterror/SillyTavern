/**
 * Read-only mode: the list query (`POST /api/characters/query`) runs against a library without writing to it.
 * It covers the character metadata db and the two search indexes (characters and groups), and nothing else.
 *
 * The metadata db opens read-only (better-sqlite3 `readonly`, `fileMustExist`) with none of its open-time schema
 * changes, on both of its connections (getEntry()'s and trySetMetaValues()'s), so a write to it fails in SQLite
 * (SQLITE_READONLY). The search indexes open for reading only, and no search index worker starts. No metadata
 * migration worker starts either, so none of its one-time passes (metadata-migration-coordinator.js) run. Anything else,
 * such as the chats db (message-tree-db.js), opens as it always does.
 *
 * It is turned on only from code: the search bench (scripts/bench-search.mjs) calls enableReadOnlyMode() before
 * anything opens. No config key or environment variable turns it on.
 */

let readOnly = false;

/** Turns read-only mode on for the rest of the process. Call it before anything opens. */
export function enableReadOnlyMode() {
    readOnly = true;
}

/** @returns {boolean} */
export function isReadOnlyMode() {
    return readOnly;
}
