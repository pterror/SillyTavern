/**
 * The settings cascade (the settings model §1.1, with docs/design/settings-scopes.md): every setting is stated at a
 * level, and a field resolves from the closest level that states it. Pure: the caller hands in what each level states
 * and what each bundle holds, so nothing here reads storage.
 *
 * Levels, closest first by default: the tab, the chat, the character (in a group: the speaking character, then the
 * group), the device, the user, the app's default. A level states, for a group of fields (a bundle kind: the sampler
 * preset of an API family, a template kind, the theme, the profile), a bundle ("this preset") and overrides of single
 * fields ("temperature 0.8").
 *
 * Resolving one field walks the levels the field may use, in the order that applies to it:
 * - an override of the field at the level wins;
 * - else a bundle the level names (directly, or through a profile it names) that holds the field wins;
 * - else the next level.
 * A bundle stated at a level is a statement about every field it holds, so a character naming preset Q beats the
 * user's override of `temperature`, while a character overriding only `temperature` keeps the user's preset for the
 * rest. Statements made directly at a level beat its profile's.
 *
 * The order of the levels is itself a setting (`ORDER_FIELD`), resolved through the default order (so it doesn't
 * recurse) and stated at any level, for every field or for one.
 */

/** The levels, closest first: the order a field resolves in unless a statement of the order says otherwise. */
export const LEVELS = Object.freeze(['tab', 'chat', 'character', 'device', 'user', 'default']);

/** The field stating the order of the levels; per field as `${ORDER_FIELD}:<field>`. */
export const ORDER_FIELD = 'levelOrder';

/** Which levels a kind of setting may be stated at (settings-scopes.md, "Which levels a setting may use"). */
export const KIND_LEVELS = Object.freeze({
    // Theme fields, font size, chat width, motion and blur, mobile view, input area, layouts, language.
    reader: Object.freeze(['tab', 'device', 'user', 'default']),
    // Every level.
    background: LEVELS,
    // Presets, templates, connection, persona, Author's Note, CFG.
    generation: Object.freeze(['tab', 'chat', 'character', 'user', 'default']),
    // Capabilities that run in the browser: a TTS voice, speech recognition, WebLLM.
    browser: Object.freeze(['tab', 'chat', 'character', 'device', 'user', 'default']),
});

/**
 * @typedef {object} LevelStatements What one level states.
 * @property {string} level One of LEVELS. In a group, two levels are `character` (the speaker's, then the group's).
 * @property {Record<string, unknown>} [overrides] Single fields' values, by field.
 * @property {Record<string, string>} [bundles] The bundle stated for a group of fields, by group (a ref).
 * @property {string} [profile] A connection profile stated at the level (a ref): a bundle of bundle statements.
 */

/**
 * @typedef {object} Catalog What the cascade reads besides the levels.
 * @property {(field: string) => string | null} groupOf The group (bundle kind) a field belongs to; null for a field
 *   no bundle holds.
 * @property {(field: string) => keyof typeof KIND_LEVELS} kindOf The field's kind, for the levels it may use.
 * @property {(ref: string) => Record<string, unknown> | undefined} bundle A bundle's fields, by ref; undefined when
 *   there's no such bundle.
 * @property {(ref: string) => Record<string, string> | undefined} profile A profile's bundle statements by group.
 */

/**
 * @typedef {object} Resolution
 * @property {unknown} value
 * @property {number} index Which of the levels (their index in the list given) supplied it; -1 for none.
 * @property {'override' | 'bundle' | 'none'} from
 * @property {string} [bundle] The bundle that supplied it.
 */

/**
 * The bundle a level states for a group: directly, else through its profile.
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
 * What one level says of a field, if anything.
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
    const fields = catalog.bundle(ref);
    if (!fields || !Object.hasOwn(fields, field)) return null;
    return { value: fields[field], from: 'bundle', bundle: ref };
}

/**
 * The levels a field resolves through, in order: the order stated for it (or for every field) through the default
 * order, then only the levels its kind may use.
 * @param {LevelStatements[]} levels The context's levels, in the default order.
 * @param {string} field
 * @param {Catalog} catalog
 * @returns {number[]} Indices into `levels`.
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
    // Stable: the levels of one name (a group's speaker, then the group) keep their order.
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
 * A field's value in a context.
 * @param {LevelStatements[]} levels The context's levels, in the default order (LEVELS; a group's two character
 *   levels speaker first), the default level last.
 * @param {string} field
 * @param {Catalog} catalog
 * @returns {Resolution}
 */
export function resolveField(levels, field, catalog) {
    return resolveIn(levels, levelOrder(levels, field, catalog), field, catalog);
}

/**
 * A field's value in a context as if the level at `index` didn't state it: what removing that level's override would
 * leave.
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

/**
 * @typedef {{ op: 'set', index: number, field: string, value: unknown } | { op: 'delete', index: number, field: string }} OverrideChange
 */

/**
 * What editing a field to `value` writes (§1.1 "Edits"): an override at the working level (by default the one
 * supplying the value now; the default level is never written, so then the user's), or its removal when the value is
 * what the level would resolve without it, so a value never sits in two places.
 * @param {LevelStatements[]} levels
 * @param {string} field
 * @param {unknown} value
 * @param {Catalog} catalog
 * @param {number} [at] The working level's index; left out, the level supplying the value.
 * @returns {OverrideChange | null} null when nothing changes.
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
 * "Save to preset": folds a level's overrides of a bundle's fields into the bundle it states, and drops them.
 * @param {LevelStatements} level
 * @param {string} group
 * @param {Catalog} catalog
 * @returns {{ bundle: string, fields: Record<string, unknown>, drop: string[] } | null} The bundle's changed fields and
 *   the overrides to drop; null when the level states no bundle for the group.
 */
export function foldIntoBundle(level, group, catalog) {
    const bundle = statedBundle(level, group, catalog);
    if (bundle === undefined) return null;
    const held = catalog.bundle(bundle) ?? {};
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
 * "Reset": the overrides of a group's fields a level holds, to drop.
 * @param {LevelStatements} level
 * @param {string} group
 * @param {Catalog} catalog
 * @returns {string[]}
 */
export function resetGroup(level, group, catalog) {
    return Object.keys(level.overrides ?? {}).filter(field => catalog.groupOf(field) === group);
}

/**
 * @typedef {object} ListStatement A level's statement of a combined list: its own items, and inherited ones it removes.
 * @property {string[]} [items]
 * @property {string[]} [minus]
 */

/**
 * A list combined across levels (active lorebooks, visible quick reply sets, data bank files): each level adds its
 * items and may remove inherited ones. Farthest first, so a closer level's minus removes what a farther one added,
 * and an item appears once, where it was first added.
 * @param {ListStatement[]} statements Closest first, as the levels.
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
