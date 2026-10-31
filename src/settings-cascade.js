export const LEVELS = Object.freeze(['tab', 'chat', 'character', 'device', 'user', 'default']);

export const ORDER_FIELD = 'levelOrder';

export const KIND_LEVELS = Object.freeze({
    reader: Object.freeze(['tab', 'device', 'user', 'default']),
    background: LEVELS,
    generation: Object.freeze(['tab', 'chat', 'character', 'user', 'default']),
    browser: Object.freeze(['tab', 'chat', 'character', 'device', 'user', 'default']),
});

/**
 * @typedef {object} LevelStatements
 * @property {string} level
 * @property {Record<string, unknown>} [overrides]
 * @property {Record<string, string>} [bundles]
 * @property {string} [profile]
 */

/**
 * @typedef {object} Catalog
 * @property {(field: string) => string | null} groupOf
 * @property {(field: string) => keyof typeof KIND_LEVELS} kindOf
 * @property {(ref: string, group: string) => Record<string, unknown> | undefined} bundle
 * @property {(ref: string) => Record<string, string> | undefined} profile
 */

/**
 * @typedef {object} Resolution
 * @property {unknown} value
 * @property {number} index
 * @property {'override' | 'bundle' | 'none'} from
 * @property {string} [bundle]
 */

/**
 * @param {LevelStatements} level
 * @param {string} group
 * @param {Catalog} catalog
 * @returns {string | undefined}
 */
export function statedBundle(level, group, catalog) {
    const direct = level.bundles?.[group];
    if (direct !== undefined) return direct;
    return level.profile !== undefined ? catalog.profile(level.profile)?.[group] : undefined;
}

/**
 * @param {LevelStatements} level
 * @param {string} field
 * @param {Catalog} catalog
 * @returns {Omit<Resolution, 'index'> | null}
 */
function statedAt(level, field, catalog) {
    if (level.overrides && Object.hasOwn(level.overrides, field)) {
        return { value: level.overrides[field], from: 'override' };
    }
    const group = catalog.groupOf(field);
    if (group === null) return null;
    const ref = statedBundle(level, group, catalog);
    if (ref === undefined) return null;
    const fields = catalog.bundle(ref, group);
    if (!fields || !Object.hasOwn(fields, field)) return null;
    return { value: fields[field], from: 'bundle', bundle: ref };
}

/**
 * @param {LevelStatements[]} levels
 * @param {string} field
 * @param {Catalog} catalog
 * @returns {number[]}
 */
export function levelOrder(levels, field, catalog) {
    const allowed = KIND_LEVELS[catalog.kindOf(field)] ?? LEVELS;
    const stated = [`${ORDER_FIELD}:${field}`, ORDER_FIELD]
        .map(orderField => resolveIn(levels, levels.map((_, i) => i), orderField, catalog))
        .find(r => r.from !== 'none');
    const order = Array.isArray(stated?.value) ? /** @type {string[]} */ (stated.value) : LEVELS;
    const rank = (/** @type {string} */ name) => {
        const at = order.indexOf(name);
        return at === -1 ? order.length + LEVELS.indexOf(name) : at;
    };
    return levels
        .map((level, index) => ({ level, index }))
        .filter(({ level }) => allowed.includes(level.level))
        .sort((a, b) => rank(a.level.level) - rank(b.level.level) || a.index - b.index)
        .map(({ index }) => index);
}

/**
 * @param {LevelStatements[]} levels
 * @param {number[]} order
 * @param {string} field
 * @param {Catalog} catalog
 * @returns {Resolution}
 */
function resolveIn(levels, order, field, catalog) {
    for (const index of order) {
        const stated = statedAt(levels[index], field, catalog);
        if (stated) return { ...stated, index };
    }
    return { value: undefined, index: -1, from: 'none' };
}

/**
 * @param {LevelStatements[]} levels
 * @param {string} field
 * @param {Catalog} catalog
 * @returns {Resolution}
 */
export function resolveField(levels, field, catalog) {
    return resolveIn(levels, levelOrder(levels, field, catalog), field, catalog);
}

/**
 * @param {LevelStatements[]} levels
 * @param {number} index
 * @param {string} field
 * @param {Catalog} catalog
 * @returns {Resolution}
 */
export function resolveWithout(levels, index, field, catalog) {
    const without = levels.map((level, i) => {
        if (i !== index || !level.overrides || !Object.hasOwn(level.overrides, field)) return level;
        const overrides = { ...level.overrides };
        delete overrides[field];
        return { ...level, overrides };
    });
    return resolveField(without, field, catalog);
}

/** @typedef {{ op: 'set', index: number, field: string, value: unknown } | { op: 'delete', index: number, field: string }} OverrideChange */

/**
 * @param {LevelStatements[]} levels
 * @param {string} field
 * @param {unknown} value
 * @param {Catalog} catalog
 * @param {number} [at]
 * @returns {OverrideChange | null}
 */
export function editField(levels, field, value, catalog, at) {
    let index = at;
    if (index === undefined) {
        const supplying = resolveField(levels, field, catalog).index;
        index = supplying === -1 || levels[supplying].level === 'default'
            ? levels.findIndex(level => level.level === 'user')
            : supplying;
    }
    if (index < 0 || levels[index].level === 'default') throw new Error('the default level is not edited');
    const level = levels[index];
    const has = Boolean(level.overrides && Object.hasOwn(level.overrides, field));
    const otherwise = resolveWithout(levels, index, field, catalog);
    if (sameValue(otherwise.value, value)) return has ? { op: 'delete', index, field } : null;
    if (has && sameValue(level.overrides[field], value)) return null;
    return { op: 'set', index, field, value };
}

/**
 * @param {LevelStatements} level
 * @param {string} group
 * @param {Catalog} catalog
 * @returns {{ bundle: string, fields: Record<string, unknown>, drop: string[] } | null}
 */
export function foldIntoBundle(level, group, catalog) {
    const bundle = statedBundle(level, group, catalog);
    if (bundle === undefined) return null;
    const held = catalog.bundle(bundle, group) ?? {};
    /** @type {Record<string, unknown>} */
    const fields = {};
    const drop = [];
    for (const [field, value] of Object.entries(level.overrides ?? {})) {
        if (catalog.groupOf(field) !== group) continue;
        drop.push(field);
        if (!sameValue(held[field], value)) fields[field] = value;
    }
    return { bundle, fields, drop };
}

/**
 * @param {LevelStatements} level
 * @param {string} group
 * @param {Catalog} catalog
 * @returns {string[]}
 */
export function resetGroup(level, group, catalog) {
    return Object.keys(level.overrides ?? {}).filter(field => catalog.groupOf(field) === group);
}

/**
 * @typedef {object} ListStatement
 * @property {string[]} [items]
 * @property {string[]} [minus]
 */

/**
 * @param {ListStatement[]} statements
 * @returns {string[]}
 */
export function combineList(statements) {
    /** @type {string[]} */
    const out = [];
    for (const statement of [...statements].reverse()) {
        for (const item of statement.minus ?? []) {
            const at = out.indexOf(item);
            if (at !== -1) out.splice(at, 1);
        }
        for (const item of statement.items ?? []) {
            if (!out.includes(item)) out.push(item);
        }
    }
    return out;
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function sameValue(a, b) {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    return JSON.stringify(a) === JSON.stringify(b);
}
