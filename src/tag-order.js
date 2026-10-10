/**
 * What a tag's stored definition gives the stores that order tags: its manual sort order as upstream coerces it,
 * and its folder type.
 */

/**
 * The columns derived from a tag's data (a value as JSON.parse returns it), with upstream's coercion wherever
 * upstream defines it. sort_order: upstream orders by `a.sort_order - b.sort_order` among tags whose sort_order
 * isn't undefined, so null, booleans and numeric strings coerce as that subtraction does; a value it can't order
 * (NaN, a non-numeric string, an object) has no order. folder_type/is_folder follow isBogusFolder() (tags.js):
 * a folder is any present folder_type other than the string 'NONE'.
 * @param {unknown} tag
 * @returns {{ sortOrder: number | null, folderType: string, isFolder: 0 | 1 }}
 */
export function tagDerivedColumns(tag) {
    const fields = tag !== null && typeof tag === 'object' ? /** @type {Record<string, unknown>} */ (tag) : {};
    const rawOrder = fields.sort_order;
    /** @type {number | null} */
    let sortOrder = null;
    if (rawOrder === null) {
        sortOrder = 0;
    } else if (typeof rawOrder === 'number' || typeof rawOrder === 'boolean' || typeof rawOrder === 'string') {
        const n = Number(rawOrder);
        sortOrder = Number.isNaN(n) ? null : n;
    }
    const rawFolder = fields.folder_type;
    const folderType = rawFolder === undefined ? 'NONE' : typeof rawFolder === 'string' ? rawFolder : String(JSON.stringify(rawFolder));
    return { sortOrder, folderType, isFolder: folderType === 'NONE' ? 0 : 1 };
}
