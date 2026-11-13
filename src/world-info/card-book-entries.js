import { newWorldInfoEntryDefinition } from '../../public/scripts/world-info-entry-defaults.js';
import { world_info_position } from './result-bucketing.js';

const fallback = (/** @type {string} */ field) => newWorldInfoEntryDefinition[field].default;

/**
 * A card book entry's own field for each field of a world's entry, in the order upstream reads a card's book into a
 * world's entries, and the value read when the card entry doesn't have it. `disable` is the card's `enabled`, negated.
 * @type {ReadonlyMap<string, { path: string[], fallback: (card: Record<string, any>) => unknown }>}
 */
const CARD_FIELDS = new Map(Object.entries({
    key: { path: ['keys'], fallback: () => [] },
    keysecondary: { path: ['secondary_keys'], fallback: () => [] },
    comment: { path: ['comment'], fallback: () => '' },
    content: { path: ['content'], fallback: () => undefined },
    constant: { path: ['constant'], fallback: () => false },
    selective: { path: ['selective'], fallback: () => false },
    order: { path: ['insertion_order'], fallback: () => undefined },
    position: { path: ['extensions', 'position'], fallback: card => (card.position === 'before_char' ? world_info_position.before : world_info_position.after) },
    excludeRecursion: { path: ['extensions', 'exclude_recursion'], fallback: () => false },
    preventRecursion: { path: ['extensions', 'prevent_recursion'], fallback: () => false },
    delayUntilRecursion: { path: ['extensions', 'delay_until_recursion'], fallback: () => false },
    disable: { path: ['enabled'], fallback: () => false },
    displayIndex: { path: ['extensions', 'display_index'], fallback: () => undefined },
    probability: { path: ['extensions', 'probability'], fallback: () => 100 },
    useProbability: { path: ['extensions', 'useProbability'], fallback: () => true },
    depth: { path: ['extensions', 'depth'], fallback: () => fallback('depth') },
    selectiveLogic: { path: ['extensions', 'selectiveLogic'], fallback: () => fallback('selectiveLogic') },
    outletName: { path: ['extensions', 'outlet_name'], fallback: () => '' },
    group: { path: ['extensions', 'group'], fallback: () => '' },
    groupOverride: { path: ['extensions', 'group_override'], fallback: () => false },
    groupWeight: { path: ['extensions', 'group_weight'], fallback: () => fallback('groupWeight') },
    scanDepth: { path: ['extensions', 'scan_depth'], fallback: () => null },
    caseSensitive: { path: ['extensions', 'case_sensitive'], fallback: () => null },
    matchWholeWords: { path: ['extensions', 'match_whole_words'], fallback: () => null },
    useGroupScoring: { path: ['extensions', 'use_group_scoring'], fallback: () => null },
    automationId: { path: ['extensions', 'automation_id'], fallback: () => '' },
    role: { path: ['extensions', 'role'], fallback: () => fallback('role') },
    vectorized: { path: ['extensions', 'vectorized'], fallback: () => false },
    sticky: { path: ['extensions', 'sticky'], fallback: () => null },
    cooldown: { path: ['extensions', 'cooldown'], fallback: () => null },
    delay: { path: ['extensions', 'delay'], fallback: () => null },
    matchPersonaDescription: { path: ['extensions', 'match_persona_description'], fallback: () => false },
    matchCharacterDescription: { path: ['extensions', 'match_character_description'], fallback: () => false },
    matchCharacterPersonality: { path: ['extensions', 'match_character_personality'], fallback: () => false },
    matchCharacterDepthPrompt: { path: ['extensions', 'match_character_depth_prompt'], fallback: () => false },
    matchScenario: { path: ['extensions', 'match_scenario'], fallback: () => false },
    matchCreatorNotes: { path: ['extensions', 'match_creator_notes'], fallback: () => false },
    triggers: { path: ['extensions', 'triggers'], fallback: () => [] },
    ignoreBudget: { path: ['extensions', 'ignore_budget'], fallback: () => false },
}));

const isPlainObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @param {unknown} one
 * @param {unknown} other
 * @returns {boolean}
 */
function sameValue(one, other) {
    if (Array.isArray(one) && Array.isArray(other)) return one.length === other.length && one.every((v, i) => sameValue(v, other[i]));
    if (isPlainObject(one) && isPlainObject(other)) {
        const [a, b] = [(one), /** @type {Record<string, unknown>} */ (other)];
        return [...new Set([...Object.keys(a), ...Object.keys(b)])].every(k => sameValue(a[k], b[k]));
    }
    return Object.is(one, other);
}

/**
 * @param {Record<string, any>} card
 * @param {string[]} path
 */
function at(card, path) {
    return path.reduce((/** @type {any} */ o, k) => (isPlainObject(o) ? o[k] : undefined), card);
}

/**
 * A card book's entry read as a world's entry, as upstream reads a card's book; `index` is its place in the book.
 * @param {Record<string, any>} card
 * @param {number} index
 * @returns {Record<string, any>}
 */
export function cardEntryAsWorld(card, index) {
    const id = card.id !== undefined ? card.id : index;
    /** @type {Record<string, any>} */
    const world = { uid: id };
    for (const [field, { path, fallback: read }] of CARD_FIELDS) {
        if (field === 'triggers') world.extensions = isPlainObject(card.extensions) ? card.extensions : {};
        const value = at(card, path) ?? read(card);
        world[field] = field === 'disable' ? !value : value;
        if (field === 'disable') world.addMemo = !!card.comment;
    }
    world.displayIndex ??= index;
    return world;
}

/**
 * @param {string} field
 */
export const NOT_IN_CARD_BOOKS = field => `A character's own lorebook has no ${field} for its entries.`;

/**
 * The refusal of a change to `fields` of a card book's entries when one of them is a field they don't have, else null.
 * @param {string[]} fields
 * @returns {string | null}
 */
export function cardBookRefusal(fields) {
    const missing = fields.find(field => field !== 'uid' && field !== 'extensions' && !CARD_FIELDS.has(field));
    return missing === undefined ? null : NOT_IN_CARD_BOOKS(missing);
}

/**
 * The card book entry `card` with the changes from `before` to `after`, two readings of it as a world's entry, written
 * to its own fields; refused when a changed field is one a card book's entry doesn't have.
 * @param {Record<string, any>} card
 * @param {Record<string, any>} before
 * @param {Record<string, any>} after
 * @returns {Record<string, any> | { refused: string }}
 */
export function cardEntryWritten(card, before, after) {
    const written = structuredClone(card);
    const extensions = () => {
        if (!isPlainObject(written.extensions)) written.extensions = {};
        return written.extensions;
    };
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(field => !sameValue(before[field], after[field]));
    for (const field of changed) {
        if (field === 'uid') continue;
        if (field === 'extensions') {
            const [was, now] = [isPlainObject(before.extensions) ? before.extensions : {}, isPlainObject(after.extensions) ? after.extensions : {}];
            for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) {
                if (sameValue(was[k], now[k])) continue;
                if (now[k] === undefined) delete extensions()[k];
                else extensions()[k] = structuredClone(now[k]);
            }
            continue;
        }
        const mapped = CARD_FIELDS.get(field);
        if (!mapped) return { refused: NOT_IN_CARD_BOOKS(field) };
        const value = field === 'disable' ? !after[field] : after[field];
        const holder = mapped.path.length === 2 ? extensions() : written;
        const name = mapped.path[mapped.path.length - 1];
        if (value === undefined) delete holder[name];
        else holder[name] = structuredClone(value);
    }
    return written;
}

/**
 * A new card book entry numbered `id` with the fields of the world's entry `entry` that differ from an empty one.
 * @param {number} id
 * @param {Record<string, any>} entry
 * @returns {Record<string, any> | { refused: string }}
 */
export function newCardEntry(id, entry) {
    const empty = { id, keys: [], content: '', enabled: true, insertion_order: 100, extensions: {} };
    const before = cardEntryAsWorld(empty, 0);
    return cardEntryWritten(empty, before, { ...before, ...entry, uid: id });
}
