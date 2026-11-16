import { unstoredGreetingNodeId } from '../public/scripts/node-identity.js';
import { countedText } from '../public/scripts/counted-text.js';

/**
 * @typedef {object} CountSources
 * @property {Record<string, any>[]} [messages]
 * @property {Record<string, any>[]} [alternatives]
 * @property {string | null} [avatar] the chat's character, whose card greetings an alternative naming no
 *   `original_avatar` is; null for a group
 */

/**
 * @param {unknown} extra
 * @returns {Record<string, any>}
 */
export function extraOf(extra) {
    return extra && typeof extra === 'object' && !Array.isArray(extra) ? /** @type {Record<string, any>} */ (extra) : {};
}

/**
 * Newest message first, each before its alternatives; then the alternatives and openings given apart.
 * @param {CountSources} sources
 * @returns {{ holder: Record<string, any>, text: string, key: string | null }[]}
 */
export function targetsOf({ messages = [], alternatives = [], avatar = null }) {
    const targets = [];
    for (const message of [...messages].reverse()) {
        if (!message || typeof message !== 'object') continue;
        targets.push({ holder: message, text: countedText(message.extra, message.mes), key: typeof message.node_id === 'string' ? message.node_id : null });
        if (!Array.isArray(message.swipes) || !Array.isArray(message.swipe_info)) continue;
        message.swipe_info.forEach((/** @type {any} */ info, /** @type {number} */ k) => {
            const text = message.swipes[k];
            if (!info || typeof info !== 'object' || typeof text !== 'string') return;
            targets.push({ holder: info, text: countedText(info.extra, text), key: typeof info.node_id === 'string' ? info.node_id : null });
        });
    }
    for (const alternative of alternatives) {
        if (!alternative || typeof alternative !== 'object') continue;
        const key = typeof alternative.node_id === 'string' && alternative.node_id !== ''
            ? alternative.node_id
            : unstoredGreetingNodeId(alternative, avatar);
        targets.push({ holder: alternative, text: countedText(alternative.extra, alternative.mes), key });
    }
    return targets;
}

/**
 * @param {{ openings?: { alternatives?: any[] } | null, card_openings?: { alternatives?: any[] } | null } | null | undefined} state
 * @returns {Record<string, any>[]}
 */
export function openingAlternatives(state) {
    return [...(state?.openings?.alternatives ?? []), ...(state?.card_openings?.alternatives ?? [])];
}
