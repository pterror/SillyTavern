import path from 'node:path';

// Test-only reads of a user's tag store, for asserting what is stored. No request path reads tags this way.

/**
 * Every stored tag definition not marked deleted, in creation order.
 * @param {typeof import('../src/character-metadata-db.js')} metadataDb
 * @param {import('../src/users.js').UserDirectoryList} directories
 * @returns {Promise<any[]>}
 */
export async function storedTagDefinitions(metadataDb, directories) {
    const batches = await metadataDb.streamTagDefinitionBatches(directories);
    if (batches === null) throw new Error('the metadata store is unavailable');
    /** @type {any[]} */
    const tags = [];
    for await (const batch of batches) tags.push(...batch);
    return tags;
}

/**
 * How many characters and groups carry each of `ids`, as /api/tags/query's `counts: true` answers it. Only ids with a
 * stored, unmarked definition are counted.
 * @param {typeof import('../src/character-metadata-db.js')} metadataDb
 * @param {import('../src/users.js').UserDirectoryList} directories
 * @param {string[]} ids
 * @returns {Promise<{ counts: Record<string, number>, approximate: string[] }>}
 */
export async function tagCounts(metadataDb, directories, ids) {
    const result = await metadataDb.queryTags(directories, { sort: 'manual', ids, counts: true, pageSize: Math.max(ids.length, 1), after: null });
    if (result === null || typeof result === 'string') throw new Error(`the tag query answered ${result}`);
    return { counts: result.counts ?? {}, approximate: result.approximate ?? [] };
}

/**
 * The raw tag_usage table, `{ tagId: count }`, every row, marked tags and zero counts included.
 * @param {import('../src/users.js').UserDirectoryList} directories
 * @returns {Promise<Record<string, number>>}
 */
export async function storedTagUsageRows(directories) {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(path.join(directories.root, 'character-metadata.sqlite'), { readonly: true });
    try {
        const rows = /** @type {{ tag_id: string, count: number }[]} */ (db.prepare('SELECT tag_id, count FROM tag_usage').all());
        return Object.fromEntries(rows.map(row => [row.tag_id, Number(row.count)]));
    } finally {
        db.close();
    }
}

/**
 * Applies every queued tag move, one per transaction, as the character store conversion applies those queued with no
 * reorder pass (applyFirstPendingTagMoveSync()), on a connection of its own through the store's engine.
 * @param {typeof import('../src/character-metadata-db.js')} metadataDb
 * @param {import('../src/users.js').UserDirectoryList} directories
 * @returns {Promise<import('../src/character-metadata-db.js').PendingTagMoveOutcome[]>} One per entry, in order.
 */
export async function applyQueuedTagMoves(metadataDb, directories) {
    const engine = await (await import('../src/endpoints/sqlite-engine.js')).getSqliteEngine();
    const handle = engine.openDatabase(path.join(directories.root, 'character-metadata.sqlite'));
    try {
        const outcomes = [];
        for (;;) {
            /** @type {import('../src/character-metadata-db.js').PendingTagMoveOutcome | null} */
            let outcome = null;
            handle.transaction(() => {
                outcome = metadataDb.applyFirstPendingTagMoveSync(handle);
            });
            if (outcome === null) return outcomes;
            outcomes.push(outcome);
        }
    } finally {
        handle.close();
    }
}
