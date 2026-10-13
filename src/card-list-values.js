/**
 * The card values a character list row shows (`library-engine.js` reads them narrow, `listRowValues()`).
 */

/**
 * @param {unknown} value
 * @param {unknown} fallback
 */
function orDefault(value, fallback) {
    return value === undefined ? fallback : value;
}

/**
 * The card values a list row shows, as the blob layout's shallow copy holds them: toShallow() of
 * getCharaCardV2(card), with V1 keys hoisted from `data` for a card with `spec`, and a card without `spec` read from
 * its V1 keys alone (convertToV2(): comma-split string tags, defaults for the rest).
 * @param {unknown} card
 * @param {boolean} includeCreatorNotes `performance.shallowCharactersIncludeCreatorNotes`
 * @returns {{ name: unknown, tags: unknown, create_date: unknown, data: { name: unknown, character_version: unknown, creator: unknown, tags: unknown, creator_notes?: unknown, world: unknown } }}
 */
export function cardListValues(card, includeCreatorNotes) {
    const record = /** @type {Record<string, any>} */ (typeof card === 'object' && card !== null && !Array.isArray(card) ? card : {});
    if (record.spec === undefined) {
        const tags = typeof record.tags === 'string' ? record.tags.split(',').map(x => x.trim()).filter(x => x) : record.tags || [];
        return {
            name: record.name,
            tags,
            create_date: record.create_date,
            data: {
                name: orDefault(record.name, ''),
                character_version: '',
                creator: record.creator || '',
                tags,
                ...(includeCreatorNotes && { creator_notes: record.creatorcomment || '' }),
                world: '',
            },
        };
    }
    const data = record.data;
    const hoisted = (/** @type {string} */ key) => (data === undefined || data?.[key] === undefined ? record[key] : data[key]);
    return {
        name: hoisted('name'),
        tags: hoisted('tags'),
        create_date: record.create_date,
        data: {
            name: orDefault(data?.name, ''),
            character_version: orDefault(data?.character_version, ''),
            creator: orDefault(data?.creator, ''),
            tags: orDefault(data?.tags, []),
            ...(includeCreatorNotes && { creator_notes: orDefault(data?.creator_notes, '') }),
            world: orDefault(data?.extensions?.world, ''),
        },
    };
}

/** The paths of a card cardListValues() reads (as the old fields layout's `card_extra` named them), besides its
 * columns and card tags. */
export const LIST_EXTRA_PATHS = Object.freeze(['whole', 'top:spec', 'present:data', 'top:data', 'name:data', 'name:top', 'data:name', 'top:name',
    'mirror:name', 'data:tags', 'top:tags', 'mirror:tags', 'top:create_date', 'data:creator', 'data:character_version', 'top:creator',
    'present:extensions', 'data:extensions']);
export const LIST_CREATOR_NOTES_PATHS = Object.freeze(['data:creator_notes', 'top:creatorcomment', 'mirror:creatorcomment']);
