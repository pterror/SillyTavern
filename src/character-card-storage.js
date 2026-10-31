import crypto from 'node:crypto';

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
 * @property {Record<string, string | number>} card
 * @property {{ list: string, position: number, text: string }[]} greetings
 * @property {{ position: number, name: string }[]} tags
 * @property {{ key: string, value: string }[]} extensions
 * @property {{ path: string, value: string | null }[]} extra
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
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function jsonEqual(a, b) {
    return canonicalJson(a) === canonicalJson(b);
}

/**
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
 * @param {unknown} card
 * @returns {string}
 */
export function canonicalCardHash(card) {
    return crypto.createHash('sha256').update(canonicalJson(card)).digest('hex');
}

/**
 * @param {unknown} card
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
 * @param {Record<string, unknown>} card
 * @returns {'data' | 'top'}
 */
export function cardNameSource(card) {
    return Object.hasOwn(card, 'spec') && isPlainObject(card.data) && Object.hasOwn(card.data, 'name') ? 'data' : 'top';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function nameText(value) {
    if (typeof value === 'string') return value;
    return value ? String(value) : '';
}

/**
 * @param {unknown} card
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
        parts.columns.name = nameText(name.value);
        if (typeof name.value !== 'string') parts.extra.push({ path: `${nameFrom}:name`, value: JSON.stringify(name.value) ?? 'null' });
    }
    if (otherName.found) {
        if (name.found && jsonEqual(name.value, otherName.value)) parts.extra.push({ path: 'mirror:name', value: null });
        else parts.extra.push({ path: `${nameFrom === 'data' ? 'top' : 'data'}:name`, value: JSON.stringify(otherName.value) ?? 'null' });
    }

    if (isPlainObject(data)) {
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
 * @returns {unknown}
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
        const asItself = parts.extra.some(row => row.path === `${nameFrom}:name`);
        if (!asItself && nameFrom === 'data') ensureData().name = columns.name;
        else if (!asItself) card.name = columns.name;
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
