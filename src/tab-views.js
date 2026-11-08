import { TYPE } from './library-codes.js';

const GREETING_SHOWN = 'greeting shown:';

/**
 * @param {import('./library-engine.js').LibraryEngine} lib
 * @param {string} session
 * @param {string} avatar
 * @returns {Promise<number | null>} the id of the greeting the tab's character info shows for the character
 */
export async function shownGreeting(lib, session, avatar) {
    const view = await lib.entity(TYPE.tabView, session);
    const value = view?.values.find(v => v.field === GREETING_SHOWN + avatar)?.json;
    const id = value === undefined ? null : JSON.parse(value);
    return Number.isInteger(id) ? id : null;
}

/**
 * @param {import('./library-engine.js').LibraryEngine} lib
 * @param {string} session
 * @param {string} avatar
 * @param {number} greetingId
 */
export function showGreeting(lib, session, avatar, greetingId) {
    return lib.serialized(TYPE.tabView, session, async () => {
        const view = await lib.entity(TYPE.tabView, session);
        const field = GREETING_SHOWN + avatar;
        const json = JSON.stringify(greetingId);
        if (view?.values.find(v => v.field === field)?.json === json) return;
        const records = [];
        const id = view ? view.id : lib.nextId++;
        if (!view) records.push({ kind: 'entityCreate', entity: id, type: TYPE.tabView, key: session, added: Date.now() });
        records.push({ kind: 'jsonValue', entity: id, field, json });
        await lib.store.commit(records);
    });
}
