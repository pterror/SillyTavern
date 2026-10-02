/**
 * The only writer of message-tree.sqlite's `meta` table. Several modules keep keys there (the stats counters' version
 * and fill markers, the token stores' row counts, one-time migrations' markers); they all write through these.
 * tests/store-write-owners.test.js fails if anything else writes the table.
 */

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} key
 * @param {string} value
 */
export function setTreeMetaSync(db, key, value) {
    db.run('INSERT INTO meta (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value', { key, value });
}

/**
 * Adds `delta` to an integer value, creating it at `delta`.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} key
 * @param {number} delta
 */
export function addTreeMetaSync(db, key, delta) {
    db.run('INSERT INTO meta (key, value) VALUES (@key, @delta) ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + @delta', { key, delta });
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string[]} keys
 */
export function deleteTreeMetaSync(db, keys) {
    for (const key of keys) db.run('DELETE FROM meta WHERE key = @key', { key });
}
