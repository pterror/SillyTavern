const PROVISIONAL_NODE_PREFIX = 'card:';

/**
 * A card greeting by its character and its id (`docs/design/greeting-ids.md`), as the server names one
 * @typedef {{ greeting: number, avatar: string }} CardGreetingRef
 */

/**
 * The card greeting a message is from: its `extra.greeting_id`, of the character who says it (`original_avatar`, a
 * group member) or else the chat's own character
 * @param {{ original_avatar?: unknown, extra?: unknown } | null | undefined} message
 * @param {string | null | undefined} avatar the chat's character; null for a group
 * @returns {CardGreetingRef | null} null for a message from no greeting
 */
export function cardGreetingOf(message, avatar) {
    const greeting = /** @type {{ greeting_id?: unknown } | null | undefined} */ (message?.extra)?.greeting_id;
    const own = message?.original_avatar;
    const card = typeof own === 'string' && own !== '' ? own : avatar;
    if (!Number.isInteger(greeting) || typeof card !== 'string' || card === '') return null;
    return { greeting: /** @type {number} */ (greeting), avatar: card };
}

/**
 * The node id of a card greeting not stored yet, the same for every alternative that is that greeting
 * @param {{ original_avatar?: unknown, extra?: unknown } | null | undefined} message an unstored opening
 * @param {string | null | undefined} avatar the chat's character; null for a group
 * @returns {string | null} null when it is no card greeting (`cardGreetingOf`)
 */
export function unstoredGreetingNodeId(message, avatar) {
    const ref = cardGreetingOf(message, avatar);
    return ref === null ? null : `${PROVISIONAL_NODE_PREFIX}${ref.greeting}:${ref.avatar}`;
}

/**
 * The node id of an opening written on the page, not stored yet and from no card greeting: each call a new one
 * @returns {string}
 */
export function composedOpeningNodeId() {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return `${PROVISIONAL_NODE_PREFIX}new:${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * @param {unknown} nodeId
 * @returns {nodeId is string}
 */
export function isStoredNodeId(nodeId) {
    return typeof nodeId === 'string' && nodeId.length > 0 && !nodeId.startsWith(PROVISIONAL_NODE_PREFIX);
}

/**
 * @param {unknown} nodeId
 * @returns {nodeId is string}
 */
export function isProvisionalNodeId(nodeId) {
    return typeof nodeId === 'string' && nodeId.startsWith(PROVISIONAL_NODE_PREFIX);
}
