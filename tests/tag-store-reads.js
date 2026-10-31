/**
 * @param {import('../src/library-engine.js').LibraryEngine} lib
 * @returns {Promise<any[]>}
 */
export async function storedTagDefinitions(lib) {
    /** @type {any[]} */
    const tags = [];
    /** @type {string | null} */
    let cursor = null;
    for (;;) {
        const page = await lib.tags.query({ sort: 'manual', pageSize: 500, cursor });
        if (page === 'invalid-cursor') throw new Error('the tag query answered invalid-cursor');
        tags.push(...page.rows);
        if (!page.more || !page.cursor) return tags;
        cursor = page.cursor;
    }
}

/**
 * @param {import('../src/library-engine.js').LibraryEngine} lib
 * @param {string[]} ids
 * @returns {Promise<{ counts: Record<string, number>, approximate: string[] }>}
 */
export async function tagCounts(lib, ids) {
    const result = await lib.tags.query({ sort: 'manual', ids, counts: true, pageSize: Math.max(ids.length, 1), cursor: null });
    if (typeof result === 'string') throw new Error(`the tag query answered ${result}`);
    return { counts: result.counts ?? {}, approximate: result.approximate ?? [] };
}

/**
 * @param {import('../src/library-engine.js').LibraryEngine} lib
 * @returns {Promise<Record<string, number>>}
 */
export async function storedTagUsageRows(lib) {
    const ids = (await storedTagDefinitions(lib)).map(tag => tag.id);
    if (ids.length === 0) return {};
    return (await tagCounts(lib, ids)).counts;
}
