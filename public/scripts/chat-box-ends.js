import { cardGreetingOf, isStoredNodeId } from './node-identity.js';

/**
 * The message a draft responds to, as the server names it (`src/chat-drafts.js`)
 * @typedef {{ message: string } | { greeting: number, avatar: string } | { root: true }} DraftOwner
 */

/**
 * What text written in a chat now responds to: its last stored message; before anything is stored, the last opening
 * shown, a card greeting by its id; with nothing shown, the chat's root
 * @param {readonly { node_id?: unknown, original_avatar?: unknown, extra?: object }[]} messages the chat as shown,
 *   oldest first
 * @param {string | null} avatar the chat's character, whose greetings a 1:1 chat's openings are; null for a group
 * @returns {DraftOwner}
 */
export function endOwnerOf(messages, avatar) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (isStoredNodeId(messages[i].node_id)) return { message: /** @type {string} */ (messages[i].node_id) };
    }
    for (let i = messages.length - 1; i >= 0; i--) {
        const greeting = cardGreetingOf(messages[i], avatar);
        if (greeting !== null) return greeting;
    }
    return { root: true };
}

/**
 * @param {DraftOwner | null | undefined} a
 * @param {DraftOwner | null | undefined} b
 * @returns {boolean} whether both name the same message
 */
export function sameOwner(a, b) {
    if (!a || !b) return false;
    if ('message' in a || 'message' in b) return 'message' in a && 'message' in b && a.message === b.message;
    if ('root' in a || 'root' in b) return 'root' in a && 'root' in b;
    return a.greeting === b.greeting && a.avatar === b.avatar;
}
