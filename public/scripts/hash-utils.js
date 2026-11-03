/**
 * @param {string} str
 * @param {number} [seed=0]
 * @returns {number}
 */
export function getStringHash(str, seed = 0) {
    if (typeof str !== 'string') {
        return 0;
    }

    let h1 = 0xdeadbeef ^ seed,
        h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }

    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * @param {object|null|undefined} obj
 * @param {string} dottedPath
 * @returns {*}
 */
export function getAtPath(obj, dottedPath) {
    let current = obj;
    for (const part of dottedPath.split('.')) {
        if (current == null || typeof current !== 'object') return undefined;
        current = current[part];
    }
    return current;
}

/**
 * @param {object} obj
 * @param {string} dottedPath
 * @param {*} value
 */
export function setAtPath(obj, dottedPath, value) {
    const parts = dottedPath.split('.');
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (!(parts[i] in current) || current[parts[i]] == null || typeof current[parts[i]] !== 'object') {
            current[parts[i]] = {};
        }
        current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
}

export const CHAR_LORE_PATH = Object.freeze(['world_info_settings', 'world_info', 'charLore']);

/**
 * @param {string} key
 * @param {*} value
 * @returns {{ value: *, skip: boolean, charLore: * }}
 */
export function settingsWithoutCharLore(key, value) {
    const parts = key === '' ? [] : key.split('.');
    const shared = Math.min(parts.length, CHAR_LORE_PATH.length);
    for (let i = 0; i < shared; i++) {
        if (parts[i] !== CHAR_LORE_PATH[i]) return { value, skip: false, charLore: undefined };
    }
    if (parts.length >= CHAR_LORE_PATH.length) return { value: undefined, skip: true, charLore: parts.length === CHAR_LORE_PATH.length ? value : undefined };
    const rest = CHAR_LORE_PATH.slice(parts.length);
    let holder = value;
    for (const part of rest.slice(0, -1)) {
        if (holder == null || typeof holder !== 'object' || Array.isArray(holder) || !Object.hasOwn(holder, part)) return { value, skip: false, charLore: undefined };
        holder = holder[part];
    }
    const last = rest[rest.length - 1];
    if (holder == null || typeof holder !== 'object' || Array.isArray(holder) || !Object.hasOwn(holder, last)) return { value, skip: false, charLore: undefined };
    const copy = { ...value };
    let at = copy;
    for (const part of rest.slice(0, -1)) {
        at[part] = { ...at[part] };
        at = at[part];
    }
    const charLore = at[last];
    delete at[last];
    return { value: copy, skip: false, charLore };
}

/**
 * @param {Record<string, number>} map
 * @param {*} obj
 * @param {string} [prefix]
 * @param {Set<object>} [ancestors]
 */
export function seedKeyHashes(map, obj, prefix = '', ancestors = new Set()) {
    if (prefix) {
        try {
            map[prefix] = getStringHash(JSON.stringify(obj, null, 4));
        } catch (error) {
            // Unstringifiable (cyclic) at this path - leave it out of the map rather than throwing.
        }
    }
    if (obj != null && typeof obj === 'object' && !Array.isArray(obj)) {
        if (ancestors.has(obj)) {
            return;
        }
        ancestors.add(obj);
        try {
            for (const key of Object.keys(obj)) {
                seedKeyHashes(map, obj[key], prefix ? `${prefix}.${key}` : key, ancestors);
            }
        } finally {
            ancestors.delete(obj);
        }
    }
}

export function hashSettingsKeys(obj, keys) {
    /** @type {Record<string, number>} */
    const result = {};
    for (const key of keys) {
        const value = key.includes('.') ? getAtPath(obj, key) : obj?.[key];
        result[key] = getStringHash(JSON.stringify(value, null, 4));
    }
    return result;
}

/**
 * @param {*} value
 * @returns {string}
 */
export function canonicalStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map(canonicalStringify).join(',')}]`;
    }
    if (value !== null && typeof value === 'object') {
        const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
        return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

export const DEFAULT_DIGEST_BUCKET_COUNT = 256;

/**
 * @param {string} id
 * @param {number} [bucketCount]
 * @returns {number}
 */
export function bucketOf(id, bucketCount = DEFAULT_DIGEST_BUCKET_COUNT) {
    return getStringHash(String(id)) % bucketCount;
}

/**
 * @param {object} content
 * @returns {number}
 */
export function contentHashOf(content) {
    return getStringHash(canonicalStringify(content ?? {}));
}

/**
 * @param {*} value
 * @returns {boolean}
 */
export function normalizeFav(value) {
    return value === true || value === 'true' || value === 1;
}

/**
 * @param {*} tagIds
 * @returns {string[]}
 */
export function normalizeTagIds(tagIds) {
    return Array.isArray(tagIds) ? [...tagIds].sort() : [];
}

/**
 * @param {string} name
 * @returns {string}
 */
export function tagNameKey(name) {
    return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export const LIST_CREATOR_NOTES_CHARS = 0;

/**
 * @param {unknown} notes
 * @param {number} [chars]
 * @returns {string}
 */
export function listCreatorNotes(notes, chars = LIST_CREATOR_NOTES_CHARS) {
    if (typeof notes !== 'string' || chars <= 0) return '';
    let end = 0;
    for (let n = 0; n < chars && end < notes.length; n++) {
        end += notes.codePointAt(end) > 0xffff ? 2 : 1;
    }
    return notes.slice(0, end);
}

/**
 * @param {object} character
 * @returns {object}
 */
export function shallowCharacterData(character) {
    const data = character?.data;
    const orDefault = (value, fallback) => (value === undefined ? fallback : value);
    return {
        name: orDefault(data?.name, ''),
        character_version: orDefault(data?.character_version, ''),
        creator: orDefault(data?.creator, ''),
        tags: orDefault(data?.tags, []),
        creator_notes: listCreatorNotes(data?.creator_notes),
        extensions: {
            fav: orDefault(data?.extensions?.fav, false),
            world: orDefault(data?.extensions?.world, ''),
        },
    };
}

/**
 * @param {object} group
 * @returns {object}
 */
export function groupFavFingerprint(group) {
    return { fav: normalizeFav(group?.fav) };
}

/**
 * @param {object} group
 * @returns {object}
 */
export function groupTagIdsFingerprint(group) {
    const tagIds = group?.tag_ids;
    return { tag_ids: Array.isArray(tagIds) && tagIds.length > 0 ? [...tagIds].sort() : null };
}

/**
 * @param {object} group
 * @returns {object}
 */
export function groupContentFingerprint(group) {
    if (!group || typeof group !== 'object') return {};
    const { id, fav, tag_ids, ...content } = group;
    return content;
}

/**
 * @param {object} group
 * @returns {number}
 */
export function groupDigestFavHash(group) {
    return contentHashOf(groupFavFingerprint(group)) % 4294967296;
}

/**
 * @param {object} group
 * @returns {number}
 */
export function groupDigestTagIdsHash(group) {
    return contentHashOf(groupTagIdsFingerprint(group)) % 4294967296;
}

/**
 * @param {object} group
 * @returns {number}
 */
export function groupDigestContentHash(group) {
    return contentHashOf(groupContentFingerprint(group)) % 4294967296;
}

/**
 * @returns {{ hi: number, lo: number }}
 */
export function emptyDigest() {
    return { hi: 0, lo: 0 };
}

/**
 * @param {{ hi: number, lo: number }} digest
 * @param {string} id
 * @param {number} contentHash
 * @returns {{ hi: number, lo: number }}
 */
export function combineDigest(digest, id, contentHash) {
    const h = getStringHash(`${id}:${contentHash}`);
    const lo = h % 4294967296;
    const hi = Math.floor(h / 4294967296);
    return { hi: (digest.hi ^ hi) >>> 0, lo: (digest.lo ^ lo) >>> 0 };
}

/**
 * @param {{ hi: number, lo: number }} a
 * @param {{ hi: number, lo: number }} b
 * @returns {boolean}
 */
export function digestsEqual(a, b) {
    return a.hi === b.hi && a.lo === b.lo;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
export function jsonHash(value) {
    return getStringHash(JSON.stringify(value) ?? 'undefined');
}
