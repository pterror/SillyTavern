import crypto from 'node:crypto';

/**
 * A character card stored as its own values instead of one JSON blob (storage redesign, step 5).
 *
 * splitCard() turns a card (the parsed V1/V2/V3 object as the store holds it today) into the rows of the field
 * layout; assembleCard() turns those rows back into the same card. The two are exact inverses for any JSON object:
 * nothing a card carries is dropped, and the assembled card has the same canonical hash as the original (key order
 * may differ; canonicalCardHash() ignores it).
 *
 * Where each value goes:
 * - `columns`: the values the narrow `characters` row holds (name, creator, character_version, fav, world), each
 *   only when it has the type that column holds; otherwise it goes to `extra` so nothing is coerced.
 * - `fields`: every other string-valued key of `data` (description, personality, scenario, first_mes, mes_example,
 *   creator_notes, system_prompt, post_history_instructions, and any unknown string field).
 * - `greetings`: `data.alternate_greetings` and `data.group_only_greetings`, one row per greeting, in order.
 * - `extensions`: every key of `data.extensions` except fav and world, its value as JSON.
 * - `extra`: everything else, by path: non-string `data` keys (`data:<key>`), top-level keys other than `data`
 *   (`top:<key>`), and a top-level key whose value is exactly the V1 mirror of its `data` counterpart
 *   (`mirror:<key>`, value null), so the mirror is one value here and written to both places on assembly.
 */

/** Top-level V1 keys that mirror a value under `data`, by path. */
const V1_MIRRORS = Object.freeze({
    name: ['name'],
    description: ['description'],
    personality: ['personality'],
    scenario: ['scenario'],
    first_mes: ['first_mes'],
    mes_example: ['mes_example'],
    creatorcomment: ['creator_notes'],
    tags: ['tags'],
    fav: ['extensions', 'fav'],
    talkativeness: ['extensions', 'talkativeness'],
});

const COLUMN_KEYS = Object.freeze(['name', 'creator', 'character_version']);
const GREETING_LISTS = Object.freeze(['alternate_greetings', 'group_only_greetings']);

/**
 * @typedef {object} CardParts
 * @property {{ name?: string, creator?: string, character_version?: string, fav?: boolean, world?: string }} columns
 * @property {{ field: string, value: string }[]} fields
 * @property {{ list: string, position: number, text: string }[]} greetings
 * @property {{ key: string, value: string }[]} extensions JSON text per key.
 * @property {{ path: string, value: string | null }[]} extra JSON text per path; null for a mirror marker.
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} data
 * @param {string[]} path
 * @returns {{ found: boolean, value?: unknown }}
 */
function readPath(data, path) {
    /** @type {unknown} */
    let node = data;
    for (const key of path) {
        if (!isPlainObject(node) || !Object.hasOwn(node, key)) return { found: false };
        node = node[key];
    }
    return { found: true, value: node };
}

/**
 * Deep equality for JSON values.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function jsonEqual(a, b) {
    return canonicalJson(a) === canonicalJson(b);
}

/**
 * JSON text with object keys sorted at every level, so two cards that differ only in key order serialise the same.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (isPlainObject(value)) {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

/**
 * The hash a card is verified by: sha256 of its canonical JSON.
 * @param {unknown} card
 * @returns {string}
 */
export function canonicalCardHash(card) {
    return crypto.createHash('sha256').update(canonicalJson(card)).digest('hex');
}

/**
 * @param {unknown} card A parsed card.
 * @returns {CardParts}
 */
export function splitCard(card) {
    /** @type {CardParts} */
    const parts = { columns: {}, fields: [], greetings: [], extensions: [], extra: [] };
    if (!isPlainObject(card)) {
        parts.extra.push({ path: 'whole', value: JSON.stringify(card) ?? 'null' });
        return parts;
    }

    const hasData = Object.hasOwn(card, 'data');
    const data = hasData ? card.data : undefined;
    if (hasData && !isPlainObject(data)) {
        parts.extra.push({ path: 'top:data', value: JSON.stringify(data) ?? 'null' });
    }

    if (isPlainObject(data)) {
        // An empty `data` or `data.extensions` splits to no rows, so their presence is a marker of its own.
        parts.extra.push({ path: 'present:data', value: null });
        for (const [key, value] of Object.entries(data)) {
            if (key === 'extensions' && isPlainObject(value)) {
                parts.extra.push({ path: 'present:extensions', value: null });
                for (const [extKey, extValue] of Object.entries(value)) {
                    if (extKey === 'fav' && typeof extValue === 'boolean') parts.columns.fav = extValue;
                    else if (extKey === 'world' && typeof extValue === 'string') parts.columns.world = extValue;
                    else parts.extensions.push({ key: extKey, value: JSON.stringify(extValue) ?? 'null' });
                }
                continue;
            }
            if (GREETING_LISTS.includes(key) && Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string')) {
                value.forEach((text, position) => parts.greetings.push({ list: key, position, text }));
                continue;
            }
            if (typeof value === 'string') {
                if (COLUMN_KEYS.includes(key)) parts.columns[/** @type {'name'|'creator'|'character_version'} */ (key)] = value;
                else parts.fields.push({ field: key, value });
                continue;
            }
            parts.extra.push({ path: `data:${key}`, value: JSON.stringify(value) ?? 'null' });
        }
    }

    for (const [key, value] of Object.entries(card)) {
        if (key === 'data') continue;
        const mirrorPath = Object.hasOwn(V1_MIRRORS, key) ? V1_MIRRORS[/** @type {keyof typeof V1_MIRRORS} */ (key)] : null;
        if (mirrorPath && isPlainObject(data)) {
            const counterpart = readPath(data, mirrorPath);
            if (counterpart.found && jsonEqual(counterpart.value, value)) {
                parts.extra.push({ path: `mirror:${key}`, value: null });
                continue;
            }
        }
        parts.extra.push({ path: `top:${key}`, value: JSON.stringify(value) ?? 'null' });
    }
    return parts;
}

/**
 * @param {CardParts} parts
 * @returns {unknown} The card splitCard() was given (same canonical hash).
 */
export function assembleCard(parts) {
    const whole = parts.extra.find(row => row.path === 'whole');
    if (whole) return JSON.parse(/** @type {string} */ (whole.value));

    /** @type {Record<string, unknown>} */
    const card = {};
    /** @type {Record<string, unknown> | undefined} */
    let data;
    const ensureData = () => (data ??= {});
    if (parts.extra.some(row => row.path === 'present:data')) ensureData();

    const { columns } = parts;
    for (const key of COLUMN_KEYS) {
        const value = columns[/** @type {'name'|'creator'|'character_version'} */ (key)];
        if (value !== undefined) ensureData()[key] = value;
    }
    for (const { field, value } of parts.fields) ensureData()[field] = value;
    for (const list of GREETING_LISTS) {
        const rows = parts.greetings.filter(row => row.list === list).sort((a, b) => a.position - b.position);
        if (rows.length > 0) ensureData()[list] = rows.map(row => row.text);
    }

    const hasExtensions = parts.extra.some(row => row.path === 'present:extensions');
    if (hasExtensions) {
        /** @type {Record<string, unknown>} */
        const extensions = {};
        if (columns.fav !== undefined) extensions.fav = columns.fav;
        if (columns.world !== undefined) extensions.world = columns.world;
        for (const { key, value } of parts.extensions) extensions[key] = JSON.parse(value);
        ensureData().extensions = extensions;
    }

    for (const { path, value } of parts.extra) {
        if (path.startsWith('data:')) ensureData()[path.slice(5)] = JSON.parse(/** @type {string} */ (value));
    }

    for (const { path, value } of parts.extra) {
        if (path === 'top:data') card.data = JSON.parse(/** @type {string} */ (value));
        else if (path.startsWith('top:')) card[path.slice(4)] = JSON.parse(/** @type {string} */ (value));
    }
    if (data !== undefined) card.data = data;
    for (const { path } of parts.extra) {
        if (!path.startsWith('mirror:')) continue;
        const key = path.slice(7);
        const counterpart = readPath(/** @type {Record<string, unknown>} */ (data ?? {}), V1_MIRRORS[/** @type {keyof typeof V1_MIRRORS} */ (key)]);
        card[key] = counterpart.value;
    }
    return card;
}
