import crypto from 'node:crypto';

/**
 * A character card stored as its own values instead of one JSON blob (storage redesign, step 5).
 *
 * splitCard() turns a card (the parsed V1/V2/V3 object as the store holds it today) into the rows of the field
 * layout; assembleCard() turns those rows back into the same card. The two are exact inverses for any JSON object
 * except for the favourite flag: nothing else a card carries is dropped, and the assembled card has the same canonical
 * hash as cardWithStoredFav() of the original (key order may differ; canonicalCardHash() ignores it).
 *
 * The favourite flag is one fact whose truth is the `characters.fav` column; a card's `data.extensions.fav` is a
 * stale copy of it. So only whether the card has that key is stored, and assembly sets it from the column, which the
 * caller passes as `columns.fav`.
 *
 * Where each value goes:
 * - `columns`: the values the narrow `characters` row holds (the character's name, `data.creator`,
 *   `data.character_version`, `data.extensions.world`, and the top-level `create_date`), each only when it has the
 *   type that column holds (`create_date`: a string or a number); otherwise it goes to `extra` so nothing is coerced.
 *   `fav` is never set by splitCard(); assembleCard() reads it.
 * - The character's name is the one the app shows and sorts by, getCharaCardV2(card).name: `data.name` when the card
 *   has `spec` and a `data` object with a `name` key, the top-level `name` otherwise. `name:data` or `name:top` in
 *   `extra` says which key it came from, so it goes back there. The other key, when the card has it, is `mirror:name`
 *   when equal and is otherwise stored as itself (`data:name` or `top:name`, a string included).
 * - `card`: the known V2/V3 scalar fields of `data` (CARD_COLUMNS), each only when it has its column's type; the
 *   card table holds them as typed columns.
 * - `greetings`: `data.alternate_greetings` and `data.group_only_greetings`, one row per greeting, in order.
 * - `tags`: the card's own tag names (`data.tags`), one row per name, in order. These are the card's embedded names,
 *   not the user's tag assignments (`character_tags`).
 * - `extensions`: every key of `data.extensions` except fav and world, its value as JSON.
 * - `extra`: everything else, by path, as JSON: other `data` keys and known ones of another type (`data:<key>`),
 *   top-level keys other than `data`
 *   (`top:<key>`), the presence of `data.extensions.fav` (`present:fav`), and a top-level key whose value is exactly
 *   the V1 mirror of its `data` counterpart (`mirror:<key>`, value null), so the mirror is one value here and written
 *   to both places on assembly.
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

const COLUMN_KEYS = Object.freeze(['creator', 'character_version']);

/** The known V2/V3 scalar fields of `data` the card table holds as columns, with the type each holds. */
export const CARD_COLUMNS = Object.freeze({
    description: 'string',
    personality: 'string',
    scenario: 'string',
    first_mes: 'string',
    mes_example: 'string',
    creator_notes: 'string',
    system_prompt: 'string',
    post_history_instructions: 'string',
    nickname: 'string',
    creation_date: 'number',
    modification_date: 'number',
});
const GREETING_LISTS = Object.freeze(['alternate_greetings', 'group_only_greetings']);

/**
 * @typedef {object} CardParts
 * @property {{ name?: string, creator?: string, character_version?: string, fav?: boolean, world?: string, create_date?: string | number }} columns
 * @property {Record<string, string | number>} card The CARD_COLUMNS values the card has.
 * @property {{ list: string, position: number, text: string }[]} greetings
 * @property {{ position: number, name: string }[]} tags
 * @property {{ key: string, value: string }[]} extensions JSON text per key.
 * @property {{ path: string, value: string | null }[]} extra JSON text per path; null for a marker.
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
 * The card assembleCard() gives back for `card` once split, when the stored favourite flag is `fav`: its
 * `data.extensions.fav`, and a top-level `fav` that mirrored it, read `fav`.
 * @param {unknown} card A parsed card; not modified.
 * @param {boolean} fav
 * @returns {unknown}
 */
export function cardWithStoredFav(card, fav) {
    if (!isPlainObject(card) || !isPlainObject(card.data) || !isPlainObject(card.data.extensions) || !Object.hasOwn(card.data.extensions, 'fav')) return card;
    const mirrored = Object.hasOwn(card, 'fav') && jsonEqual(card.fav, card.data.extensions.fav);
    return {
        ...card,
        ...(mirrored ? { fav } : {}),
        data: { ...card.data, extensions: { ...card.data.extensions, fav } },
    };
}

/**
 * Which key of `card` holds the name getCharaCardV2() gives it: `data.name` for a card with `spec` and a `data` object
 * with a `name` key (readFromV2() hoists it), the top-level `name` otherwise (readFromV2() leaves it when `data` has
 * none; convertToV2() takes it for a card without `spec`).
 * @param {Record<string, unknown>} card
 * @returns {'data' | 'top'}
 */
export function cardNameSource(card) {
    return Object.hasOwn(card, 'spec') && isPlainObject(card.data) && Object.hasOwn(card.data, 'name') ? 'data' : 'top';
}

/**
 * @param {unknown} card A parsed card.
 * @returns {CardParts}
 */
export function splitCard(card) {
    /** @type {CardParts} */
    const parts = { columns: {}, card: {}, greetings: [], tags: [], extensions: [], extra: [] };
    if (!isPlainObject(card)) {
        parts.extra.push({ path: 'whole', value: JSON.stringify(card) ?? 'null' });
        return parts;
    }

    const hasData = Object.hasOwn(card, 'data');
    const data = hasData ? card.data : undefined;
    if (hasData && !isPlainObject(data)) {
        parts.extra.push({ path: 'top:data', value: JSON.stringify(data) ?? 'null' });
    }

    const nameFrom = cardNameSource(card);
    const nameAt = { data: isPlainObject(data) ? readPath(data, ['name']) : { found: false }, top: readPath(card, ['name']) };
    const name = nameAt[nameFrom];
    const otherName = nameAt[nameFrom === 'data' ? 'top' : 'data'];
    if (name.found) {
        parts.extra.push({ path: `name:${nameFrom}`, value: null });
        if (typeof name.value === 'string') parts.columns.name = name.value;
        else parts.extra.push({ path: `${nameFrom}:name`, value: JSON.stringify(name.value) ?? 'null' });
    }
    if (otherName.found) {
        if (name.found && jsonEqual(name.value, otherName.value)) parts.extra.push({ path: 'mirror:name', value: null });
        else parts.extra.push({ path: `${nameFrom === 'data' ? 'top' : 'data'}:name`, value: JSON.stringify(otherName.value) ?? 'null' });
    }

    if (isPlainObject(data)) {
        // An empty `data` or `data.extensions` splits to no rows, so their presence is a marker of its own.
        parts.extra.push({ path: 'present:data', value: null });
        for (const [key, value] of Object.entries(data)) {
            if (key === 'name') continue;
            if (key === 'extensions' && isPlainObject(value)) {
                parts.extra.push({ path: 'present:extensions', value: null });
                for (const [extKey, extValue] of Object.entries(value)) {
                    if (extKey === 'fav') parts.extra.push({ path: 'present:fav', value: null });
                    else if (extKey === 'world' && typeof extValue === 'string') parts.columns.world = extValue;
                    else parts.extensions.push({ key: extKey, value: JSON.stringify(extValue) ?? 'null' });
                }
                continue;
            }
            if (GREETING_LISTS.includes(key) && Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string')) {
                value.forEach((text, position) => parts.greetings.push({ list: key, position, text }));
                continue;
            }
            if (key === 'tags' && Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string')) {
                value.forEach((name, position) => parts.tags.push({ position, name }));
                continue;
            }
            if (typeof value === 'string' && COLUMN_KEYS.includes(key)) {
                parts.columns[/** @type {'creator'|'character_version'} */ (key)] = value;
                continue;
            }
            if (Object.hasOwn(CARD_COLUMNS, key) && typeof value === CARD_COLUMNS[/** @type {keyof typeof CARD_COLUMNS} */ (key)]) {
                parts.card[key] = /** @type {string | number} */ (value);
                continue;
            }
            parts.extra.push({ path: `data:${key}`, value: JSON.stringify(value) ?? 'null' });
        }
    }

    for (const [key, value] of Object.entries(card)) {
        if (key === 'data' || key === 'name') continue;
        if (key === 'create_date' && (typeof value === 'string' || typeof value === 'number')) {
            parts.columns.create_date = value;
            continue;
        }
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
        const value = columns[/** @type {'creator'|'character_version'} */ (key)];
        if (value !== undefined) ensureData()[key] = value;
    }
    for (const [field, value] of Object.entries(parts.card)) ensureData()[field] = value;
    for (const list of GREETING_LISTS) {
        const rows = parts.greetings.filter(row => row.list === list).sort((a, b) => a.position - b.position);
        if (rows.length > 0) ensureData()[list] = rows.map(row => row.text);
    }
    const tagRows = [...parts.tags].sort((a, b) => a.position - b.position);
    if (tagRows.length > 0) ensureData().tags = tagRows.map(row => row.name);

    const hasExtensions = parts.extra.some(row => row.path === 'present:extensions');
    if (hasExtensions) {
        /** @type {Record<string, unknown>} */
        const extensions = {};
        if (parts.extra.some(row => row.path === 'present:fav')) {
            if (typeof columns.fav !== 'boolean') throw new TypeError('assembleCard(): the card has a favourite flag, so columns.fav must be the stored boolean');
            extensions.fav = columns.fav;
        }
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
    if (columns.create_date !== undefined) card.create_date = columns.create_date;
    const nameFrom = parts.extra.some(row => row.path === 'name:data') ? 'data' : parts.extra.some(row => row.path === 'name:top') ? 'top' : null;
    if (columns.name !== undefined) {
        if (nameFrom === null) throw new TypeError('assembleCard(): columns.name is set but no name:data or name:top says which key it belongs to');
        if (nameFrom === 'data') ensureData().name = columns.name;
        else card.name = columns.name;
    }
    if (data !== undefined) card.data = data;
    for (const { path } of parts.extra) {
        if (!path.startsWith('mirror:')) continue;
        const key = path.slice(7);
        if (key === 'name' && nameFrom === 'top') {
            ensureData().name = card.name;
            continue;
        }
        const counterpart = readPath(/** @type {Record<string, unknown>} */ (data ?? {}), V1_MIRRORS[/** @type {keyof typeof V1_MIRRORS} */ (key)]);
        card[key] = counterpart.value;
    }
    return card;
}
