import { TYPE } from './library-codes.js';
import { TAG_SORTS, tagDefinition } from './library-engine-tags.js';
import { TAG_COLOR_FIELDS } from './tag-looks.js';

const PAGE = 1000;

/**
 * Writes each tag that still has upstream's colors in fields of their own again, which moves them into its look under
 * what the look sets already (`LibraryEngine.tagRecords`). A tag with neither field is not written, so a second run
 * writes nothing.
 * @param {import('./library-engine.js').LibraryEngine} lib
 * @returns {Promise<{ tags: number, converted: number, refused: number }>} `refused`: colors the look's sanitizer
 * didn't let in, dropped with their fields
 */
export async function convertTagColors(lib) {
    let tags = 0;
    let converted = 0;
    let refused = 0;
    /** @type {Buffer | undefined} */
    let after;
    for (;;) {
        const page = await lib.store.tagPage({ sort: TAG_SORTS.alphabetical, limit: PAGE, cap: Number.MAX_SAFE_INTEGER, ...(after ? { after } : {}) });
        tags += page.ids.length;
        const colored = (await lib.entities(page.ids, { fields: [...TAG_COLOR_FIELDS], lists: [] }))
            .filter(e => e !== null && e.type === TYPE.tag && e.values.length > 0);
        for (const { id, key } of colored) {
            const written = await lib.serialized(TYPE.tag, key, async () => {
                const [entity] = await lib.entities([id]);
                if (!entity) return null;
                const { records, refused: dropped } = await lib.tagRecords(/** @type {any} */ (tagDefinition(entity)));
                if (records.length > 0) await lib.store.commit(records);
                return dropped;
            });
            if (written === null) continue;
            converted++;
            refused += written;
        }
        if (!page.cursor) return { tags, converted, refused };
        after = page.cursor;
    }
}
