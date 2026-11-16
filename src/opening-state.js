import { FIELD, TYPE } from './library-codes.js';
import { storedValues } from './entity-values.js';
import { greetingModelOf } from './greeting-items.js';

/**
 * A character's card greetings, for the page's list of them, in card order: `ids[k]` is the id of `texts[k]`, an empty
 * greeting's included
 * @typedef {{ ids: number[], texts: string[], defaultIndex: number | null, name: string }} CardGreetingsRead
 */

/**
 * @param {import('./entity-values.js').StoredEntity} entity a character's
 * @returns {CardGreetingsRead}
 */
export function cardGreetingsReadOf(entity) {
    const model = greetingModelOf(entity);
    const defaultIndex = model.greetings.findIndex(g => g.id === model.defaultId);
    return {
        ids: model.greetings.map(g => g.id),
        texts: model.greetings.map(g => g.text),
        defaultIndex: defaultIndex < 0 ? null : defaultIndex,
        name: storedValues(entity).values.get(FIELD.name)?.text ?? '',
    };
}

/**
 * @param {import('./user-stores.js').UserStore} store
 * @param {string} avatar
 * @returns {Promise<CardGreetingsRead | null>}
 */
export async function readCardGreetings(store, avatar) {
    try {
        const entity = await store.lib.entity(TYPE.character, avatar);
        return entity ? cardGreetingsReadOf(entity) : null;
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
    return (await readCardGreetings(store, avatar)) ?? { ids: [], texts: [], defaultIndex: null, name: '' };
}

/**
 * A tree's openings for the page: around the one the session shows, and every card greeting no stored opening holds
 * @param {{ store: import('./user-stores.js').UserStore, tree: bigint, actor: import('./chat-engine.js').Actor }} p
 */
export async function openingState({ store, tree, actor }) {
    const card = await store.chats.cardGreetings(tree);
    const read = (/** @type {{ offset?: number, limit?: number, unstored?: boolean }} */ range) => store.chats.openingAlternatives({ tree, actor, range, card });
    const openings = await read({});
    const cardOpenings = openings.total > openings.stored ? await read({ unstored: true }) : null;
    return { openings, card_openings: cardOpenings };
}
