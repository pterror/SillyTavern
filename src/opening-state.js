import { cardToGreetingsModel } from './greeting-list.js';

/**
 * @param {import('./user-stores.js').UserStore} store
 * @param {string} avatar
 * @returns {Promise<{ greetings: Record<string, any>[], texts: string[], defaultIndex: number|null, defaultText: string|null, name: string } | null>}
 */
export async function readCardGreetings(store, avatar) {
    try {
        const [character] = /** @type {any[]} */ (await store.lib.cards([avatar]));
        if (!character) return null;
        const { greetings, defaultIndex } = cardToGreetingsModel(character);
        const speaker = character?.name ?? character?.data?.name ?? '';
        const sendDate = Date.now();
        return {
            greetings: greetings
                .filter(text => typeof text === 'string' && text.length > 0)
                .map(text => ({ name: speaker, is_user: false, is_system: false, send_date: sendDate, mes: text, extra: {} })),
            texts: greetings,
            defaultIndex,
            defaultText: defaultIndex === null ? null : greetings[defaultIndex] ?? null,
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
 * @returns {Promise<{ greetings: Record<string, any>[], texts: string[], defaultText: string|null }>}
 */
export async function cardGreetingsOf(store, avatar) {
    return (await readCardGreetings(store, avatar)) ?? { greetings: [], texts: [], defaultText: null };
}

/**
 * @param {{ store: import('./user-stores.js').UserStore, tree: bigint, actor: import('./chat-engine.js').Actor, avatar: string }} p
 */
export async function openingState({ store, tree, actor, avatar }) {
    const card = await cardGreetingsOf(store, avatar);
    const read = (/** @type {{ offset?: number, limit?: number }} */ range) => store.chats.openingAlternatives({ tree, actor, range, cardGreetings: card.greetings, cardDefault: card.defaultText });
    const openings = await read({});
    const cardOnly = openings.total - openings.stored;
    const cardOpenings = cardOnly > 0 ? await read({ offset: openings.stored, limit: cardOnly }) : null;
    return { openings, card_openings: cardOpenings };
}

