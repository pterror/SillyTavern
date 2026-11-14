import { TYPE } from './library-codes.js';

export const GREETING_SHOWN = 'greeting shown:';

/**
 * The greeting a tab's character info shows for a character, as kept: its id, and the order of the move that showed it
 * @typedef {{ id: number, order: number }} Shown
 */

/**
 * @param {string | undefined} json
 * @returns {Shown | null}
 */
function shownOf(json) {
    const value = json === undefined ? null : JSON.parse(json);
    return value && Number.isInteger(value.id) && Number.isSafeInteger(value.order) ? { id: value.id, order: value.order } : null;
}

/**
 * @param {import('./library-engine.js').LibraryEngine} lib
 * @param {string} session
 * @param {string} avatar
 * @returns {Promise<number | null>} the id of the greeting the tab's character info shows for the character
 */
export async function shownGreeting(lib, session, avatar) {
    const view = await lib.entity(TYPE.tabView, session);
    return shownOf(view?.values.find(v => v.field === GREETING_SHOWN + avatar)?.json)?.id ?? null;
}

/**
 * Keeps the greeting a tab's character info shows, unless a later move of the tab's is kept already: the tab's moves
 * may reach the server in any order, and the last made is the one shown
 * @param {import('./library-engine.js').LibraryEngine} lib
 * @param {string} session
 * @param {string} avatar
 * @param {number} greetingId
 * @param {number} order the move's place among the tab's moves, increasing
 * @returns {Promise<boolean>} whether it is kept: false when a later move is
 */
export function showGreeting(lib, session, avatar, greetingId, order) {
    return lib.serialized(TYPE.tabView, session, async () => {
        const view = await lib.entity(TYPE.tabView, session);
        const field = GREETING_SHOWN + avatar;
        const kept = shownOf(view?.values.find(v => v.field === field)?.json);
        if (kept && kept.order >= order) return kept.order === order && kept.id === greetingId;
        const records = [];
        const id = view ? view.id : lib.nextId++;
        if (!view) records.push({ kind: 'entityCreate', entity: id, type: TYPE.tabView, key: session, added: Date.now() });
        records.push({ kind: 'jsonValue', entity: id, field, json: JSON.stringify({ id: greetingId, order }) });
        await lib.store.commit(records);
        return true;
    });
}
