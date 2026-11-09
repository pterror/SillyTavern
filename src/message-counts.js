import { provisionalNodeId } from '../public/scripts/node-identity.js';

/**
 * @typedef {object} CountSources
 * @property {Record<string, any>[]} [messages]
 * @property {Record<string, any>[]} [alternatives]
 */

/** @typedef {(texts: string[]) => Promise<number[] | null>} CountTexts */

/**
 * @param {unknown} extra
 * @returns {Record<string, any>}
 */
function extraOf(extra) {
    return extra && typeof extra === 'object' && !Array.isArray(extra) ? /** @type {Record<string, any>} */ (extra) : {};
}

/**
 * @param {unknown} extra
 * @param {unknown} mes
 */
export function countedText(extra, mes) {
    const reasoning = extraOf(extra).reasoning;
    return (typeof reasoning === 'string' ? reasoning : '') + (typeof mes === 'string' ? mes : '');
}

/**
 * @param {CountSources} sources
 * @returns {{ holder: Record<string, any>, text: string, key: string | null }[]}
 */
function targetsOf({ messages = [], alternatives = [] }) {
    const targets = [];
    for (const message of messages) {
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
            : provisionalNodeId(alternative.name, alternative.mes);
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

/**
 * @param {CountSources} sources
 * @param {CountTexts} count
 * @returns {Promise<Record<string, number>>}
 */
export async function countInto(sources, count) {
    const targets = targetsOf(sources);
    if (!targets.length) return {};
    let counts;
    try {
        counts = await count(targets.map(target => target.text));
    } catch (error) {
        console.error('Could not count the messages:', error);
        return {};
    }
    if (!counts) return {};
    /** @type {Record<string, number>} */
    const byNode = {};
    targets.forEach((target, i) => {
        const counted = counts[i];
        if (typeof counted !== 'number') return;
        target.holder.extra = { ...extraOf(target.holder.extra), token_count: counted };
        if (target.key !== null) byNode[target.key] = counted;
    });
    return byNode;
}
