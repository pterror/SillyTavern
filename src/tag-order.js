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

/**
 * `count` distinct finite values after `base`, rising in steps of 1, or of the smallest power of two that still
 * moves `base` once 1 doesn't.
 * @param {number} base
 * @param {number} count
 * @returns {number[]} Shorter than `count` where the values would stop being finite; empty for a non-finite `base`,
 *   which no step moves.
 */
export function valuesAfter(base, count) {
    if (!Number.isFinite(base)) return [];
    let step = 1;
    while (base + step === base) step *= 2;
    /** @type {number[]} */
    const values = [];
    for (let i = 1; i <= count; i++) {
        const value = base + step * i;
        if (!Number.isFinite(value)) break;
        values.push(value);
    }
    return values;
}

/**
 * valuesAfter()'s mirror: `count` distinct finite values before `base`, ascending.
 * @param {number} base
 * @param {number} count
 * @returns {number[]} Shorter than `count` where the values would stop being finite, dropping the farthest from
 *   `base`; empty for a non-finite `base`.
 */
export function valuesBefore(base, count) {
    if (!Number.isFinite(base)) return [];
    let step = 1;
    while (base - step === base) step *= 2;
    /** @type {number[]} */
    const values = [];
    for (let i = 1; i <= count; i++) {
        const value = base - step * i;
        if (!Number.isFinite(value)) break;
        values.push(value);
    }
    return values.reverse();
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number} SQLite's BINARY order on the UTF-8 bytes.
 */
export function compareNameKeys(a, b) {
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
