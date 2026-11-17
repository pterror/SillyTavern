import { bookmarkLookDeletes } from './bookmark-looks.js';

// Match the complete legacy chat filename, including the optional branch suffix.
// Custom labels and checkpoint names are deliberately outside this rule.
export function isGeneratedBookmarkName(name) {
    return typeof name === 'string' && /^.+ - \d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s\d{3}ms(?: - Branch #[1-9]\d*)?$/.test(name);
}

/** Remove only bookmark positions; message nodes and session positions are retained. */
export async function cleanupGeneratedBookmarks(store, { apply = false } = {}) {
    let before;
    let matched = 0;
    const trees = new Set();
    for (;;) {
        const page = await store.chatRead('conversations', { ...(before === undefined ? {} : { before }), limit: 500 });
        if (!page.length) break;
        before = page.at(-1).position;
        for (const row of page) trees.add(row.tree);
    }
    for (const tree of trees) {
        let after;
        for (;;) {
            const bookmarks = await store.chatRead('treeBookmarks', { tree, ...(after === undefined ? {} : { after }), limit: 500 });
            if (!bookmarks.length) break;
            after = bookmarks.at(-1).id;
            const remove = bookmarks.filter(row => isGeneratedBookmarkName(row.name)).map(row => row.id);
            matched += remove.length;
            if (apply && remove.length) {
                await store.commit([
                    ...remove.map(id => ({ kind: 'positionDelete', id })),
                    ...await bookmarkLookDeletes(store, remove),
                ]);
            }
        }
    }
    return matched;
}
