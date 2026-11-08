import { FIELD, TYPE } from './library-codes.js';
import { storedValues } from './entity-values.js';
import { greetingModelOf } from './greeting-items.js';

/**
 * @typedef {import('./chat-engine.js').CardGreetings & { texts: string[], defaultIndex: number | null, name: string }} CardGreetingsRead
 */

/**
 * @param {import('./user-stores.js').UserStore} store
 * @param {string} avatar
 * @returns {Promise<CardGreetingsRead | null>}
 */
export async function readCardGreetings(store, avatar) {
    try {
        const entity = await store.lib.entity(TYPE.character, avatar);
        if (!entity) return null;
        const model = greetingModelOf(entity);
        const speaker = storedValues(entity).values.get(FIELD.name)?.text ?? '';
        const sendDate = Date.now();
        const shown = model.greetings.filter(g => g.text.length > 0);
        const defaultIndex = model.greetings.findIndex(g => g.id === model.defaultId);
        return {
            greetings: shown.map(g => ({ name: speaker, is_user: false, is_system: false, send_date: sendDate, mes: g.text, extra: {} })),
            ids: shown.map(g => g.id),
            defaultId: model.defaultId,
            defaultEpoch: model.defaultEpoch ?? 0,
            texts: model.greetings.map(g => g.text),
            defaultIndex: defaultIndex < 0 ? null : defaultIndex,
            name: speaker,
        };
    } catch (error) {
        console.error(`Error reading card greetings for "${avatar}":`, error);
        return null;
    }
}

/**
 * @param {import('./user-stores.js').UserStore} store
 * @param {string} avatar
 * @returns {Promise<CardGreetingsRead>}
 */
export async function cardGreetingsOf(store, avatar) {
    return (await readCardGreetings(store, avatar)) ?? { greetings: [], ids: [], defaultId: null, defaultEpoch: 0, texts: [], defaultIndex: null, name: '' };
}

/**
 * @param {{ store: import('./user-stores.js').UserStore, tree: bigint, actor: import('./chat-engine.js').Actor, avatar: string }} p
 */
export async function openingState({ store, tree, actor, avatar }) {
    const card = await cardGreetingsOf(store, avatar);
    const read = (/** @type {{ offset?: number, limit?: number, unstored?: boolean }} */ range) => store.chats.openingAlternatives({ tree, actor, range, card });
    const openings = await read({});
    const cardOpenings = openings.total > openings.stored ? await read({ unstored: true }) : null;
    return { openings, card_openings: cardOpenings };
}

