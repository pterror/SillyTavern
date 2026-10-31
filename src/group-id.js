import { normalizeFav } from '../public/scripts/hash-utils.js';

const GROUP_ID_PATTERN = /^\d+$/;

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeGroupId(value) {
    if (typeof value === 'string') {
        return GROUP_ID_PATTERN.test(value) ? value : null;
    }
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
        return String(value);
    }
    return null;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidGroupId(value) {
    return normalizeGroupId(value) !== null;
}

/**
 * @template T
 * @param {T} group
 * @returns {T}
 */
export function normalizeGroupRecord(group) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) return group;
    const record = /** @type {Record<string, any>} */ (group);
    const id = normalizeGroupId(record.id);
    if (id !== null) record.id = id;
    if (typeof record.chat_id === 'number') record.chat_id = String(record.chat_id);
    if (Array.isArray(record.chats) && record.chats.some(chat => typeof chat === 'number')) {
        record.chats = record.chats.map(chat => typeof chat === 'number' ? String(chat) : chat);
    }
    return group;
}

/**
 * @param {unknown} id
 * @returns {'character' | 'group' | null}
 */
export function tagEntityTypeOf(id) {
    if (typeof id !== 'string' || id === '') return null;
    return id.endsWith('.png') ? 'character' : 'group';
}

/**
 * @param {Record<string, any>} group
 */
export function storedGroup(group) {
    normalizeGroupRecord(group);
    const stored = { ...group, fav: normalizeFav(group.fav) };
    delete stored.chat_id;
    delete stored.chats;
    return stored;
}
