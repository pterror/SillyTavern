/**
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
 * @param {number} base
 * @param {number} count
 * @returns {number[]}
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
 * @param {number} base
 * @param {number} count
 * @returns {number[]}
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
 * @returns {number}
 */
export function compareNameKeys(a, b) {
    return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
