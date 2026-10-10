// The one writer of the `itemizations` table of message-tree.sqlite (one prompt itemization per message node). The
// itemization store (itemization-store.js) and the message tree (which removes a deleted node's) both write through it.

/** @typedef {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} Db */

/**
 * @param {Db} db
 * @param {string} nodeId
 * @param {Uint8Array} data The compressed itemization.
 * @param {boolean} hasRawPrompt
 */
export function writeItemizationSync(db, nodeId, data, hasRawPrompt) {
    db.run('INSERT OR REPLACE INTO itemizations (node_id, data, has_raw_prompt) VALUES (@nodeId, @data, @hasRawPrompt)',
        { nodeId, data, hasRawPrompt: hasRawPrompt ? 1 : 0 });
}

/**
 * @param {Db} db
 * @param {string[]} nodeIds
 * @returns {number} How many were removed.
 */
export function deleteItemizationsSync(db, nodeIds) {
    if (nodeIds.length === 0) return 0;
    const params = Object.fromEntries(nodeIds.map((id, i) => [`id${i}`, id]));
    return db.run(`DELETE FROM itemizations WHERE node_id IN (${nodeIds.map((_, i) => `@id${i}`).join(', ')})`, params).changes;
}

/**
 * @param {Db} db
 */
export function clearItemizationsSync(db) {
    db.run('DELETE FROM itemizations');
}
