/**
 * @typedef {object} OpeningAlternative
 * @property {string} mes
 * @property {string} [name]
 * @property {boolean} [is_user]
 * @property {boolean} [is_system]
 * @property {string|number} [send_date]
 * @property {Record<string, unknown>} [extra]
 * @property {string|null} [node_id]
 */

/**
 * @typedef {object} OpeningsWindow
 * @property {number} [total]
 * @property {number} [stored]
 * @property {number} [offset]
 * @property {number} [default_index]
 * @property {OpeningAlternative[]} [alternatives]
 */

/**
 * @typedef {object} OpeningState
 * @property {OpeningsWindow|null} openings the tree's openings around the one the session shows
 * @property {OpeningsWindow|null} [card_openings] the card's greetings that no stored opening holds
 */

/**
 * @typedef {object} ShownFirst
 * @property {Record<string, any>|undefined} first the page's first message
 * @property {number} count how many messages the page shows
 * @property {string} speaker the character's name
 * @property {string|number} sendDate
 * @property {(speaker: string|undefined, mes: string|undefined) => string} provisionalId
 * @property {(nodeId: unknown) => boolean} isStored
 * @property {(nodeId: unknown) => boolean} isProvisional
 */

/**
 * @typedef {{ kind: 'keep' }
 *   | { kind: 'clear' }
 *   | { kind: 'show', message: Record<string, any> }
 *   | { kind: 'update', updates: Record<string, any>, shownChanged: boolean }} OpeningView
 */

/**
 * @param {OpeningState} state
 * @param {ShownFirst} page
 * @returns {OpeningView}
 */
export function openingView(state, page) {
    const head = state.openings;
    if (!head) return { kind: 'keep' };
    const total = head.total ?? 0;
    const { first } = page;

    /** @type {(string|null)[]} */
    const swipes = new Array(total).fill(null);
    /** @type {(Record<string, any>|null)[]} */
    const info = new Array(total).fill(null);
    /**
     * @param {OpeningsWindow|null|undefined} window
     * @param {number} start
     */
    const place = (window, start) => (window?.alternatives ?? []).forEach((alt, k) => {
        const at = start + k;
        if (at < 0 || at >= total) return;
        const name = alt.name ?? page.speaker;
        swipes[at] = alt.mes;
        info[at] = {
            send_date: alt.send_date ?? page.sendDate,
            extra: alt.extra ?? {},
            name,
            is_user: !!alt.is_user,
            is_system: !!alt.is_system,
            node_id: page.isStored(alt.node_id) ? alt.node_id : page.provisionalId(name, alt.mes),
        };
    });
    place(head, head.offset ?? 0);
    place(state.card_openings, state.card_openings?.offset ?? head.stored ?? 0);

    /** @param {number} at */
    const messageAt = (at) => {
        const shown = info[at];
        if (!shown || typeof swipes[at] !== 'string') return null;
        return {
            name: shown.name,
            is_user: shown.is_user,
            is_system: shown.is_system,
            send_date: shown.send_date,
            mes: swipes[at],
            extra: shown.extra,
            node_id: shown.node_id,
            swipes,
            swipe_info: info,
            swipe_id: at,
        };
    };

    if (first === undefined) {
        if (total === 0) return { kind: 'keep' };
        const message = messageAt(head.default_index ?? 0);
        return message ? { kind: 'show', message } : { kind: 'keep' };
    }

    const sameSwipes = () => Array.isArray(first.swipes)
        && first.swipes.length === total
        && swipes.every((text, k) => text === first.swipes[k])
        && info.every((entry, k) => (entry?.node_id ?? null) === (first.swipe_info?.[k]?.node_id ?? null));

    if (page.isStored(first.node_id) || (page.isProvisional(first.node_id) && page.count > 1)) {
        const at = info.findIndex(entry => entry?.node_id === first.node_id);
        if (at < 0) return { kind: 'keep' };
        if (sameSwipes() && first.swipe_id === at) return { kind: 'keep' };
        return { kind: 'update', updates: { swipes, swipe_info: info, swipe_id: at }, shownChanged: false };
    }
    if (!page.isProvisional(first.node_id)) return { kind: 'keep' };

    if (total === 0) return { kind: 'clear' };
    const message = messageAt(head.default_index ?? 0);
    if (!message) return { kind: 'keep' };
    const shownChanged = message.node_id !== first.node_id || message.mes !== first.mes;
    if (!shownChanged && sameSwipes() && first.swipe_id === message.swipe_id) return { kind: 'keep' };
    return { kind: 'update', updates: message, shownChanged };
}
