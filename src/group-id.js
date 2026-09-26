// A group id is all digits (`String(Date.now())` at /create). Legacy group files store it as a number, which is
// the same id. A valid id passes sanitize-filename unchanged, so `<id>.json` is always the group's own file.
const GROUP_ID_PATTERN = /^\d+$/;

/**
 * The string form of a group id, or null when `value` isn't one.
 * @param {unknown} value A digit string, or a non-negative safe integer (a legacy id stored as a number).
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
 * Brings a group read from its JSON file to the shape every reader expects, in place: a valid `id` in its string
 * form, and numeric `chat_id`/`chats` entries as strings. An invalid `id` is left as is, for the caller to reject.
 * @template T
 * @param {T} group Parsed group file contents.
 * @returns {T} `group` itself.
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
 * Which kind of entity a tag assignment for `id` belongs to: an id ending in `.png` is a character's, any other is a
 * group's (legacy non-digit group ids included). Creating a group with a `.png` id is rejected, so a `.png` group
 * row can only be legacy data, and its tag assignments are never read as a group's.
 * @param {unknown} id
 * @returns {'character' | 'group' | null} null when `id` isn't a non-empty string.
 */
export function tagEntityTypeOf(id) {
    if (typeof id !== 'string' || id === '') return null;
    return id.endsWith('.png') ? 'character' : 'group';
}
