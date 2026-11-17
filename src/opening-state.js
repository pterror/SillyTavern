import { FIELD, TYPE } from './library-codes.js';
import { storedValues } from './entity-values.js';
import { greetingModelOf } from './greeting-items.js';
import { hashGreetingText } from './greeting-ops.js';
import { greetingGroup } from './chat-engine.js';
import { avatarRefString } from './avatar-refs.js';

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
    const segments = await store.chats.openingSegments(tree, card);
    const read = (/** @type {{ offset?: number, limit?: number, unstored?: boolean }} */ range) => store.chats.openingAlternatives({ tree, actor, range, card, segments });
    const openings = await read({});
    const cardOpenings = openings.total > openings.stored ? await read({ unstored: true }) : null;
    const opening_layout = segments.map(seg => ({ group: String(seg.group), count: seg.count, held: seg.held,
        greeting: seg.card === null ? null : { id: card.ids[seg.card], avatar: card.avatars[seg.card], hash: hashGreetingText(card.greetings[seg.card].mes) } }));
    return { openings, card_openings: cardOpenings, opening_layout };
}

/**
 * Only the groups touched by one greeting edit, for a tree already open on a client.
 * @param {import('./user-stores.js').UserStore} store
 * @param {bigint} tree
 * @param {bigint} card
 * @param {string} avatar
 * @param {{ id: number, text: string, hash: number }} edit
 * @param {any[]} moves
 */
export async function greetingOpeningEdit(store, tree, card, avatar, edit, moves) {
    const own = moves.filter(move => move.tree === tree);
    const target = String(greetingGroup(tree, card, edit.id));
    const groups = new Set([target, ...own.flatMap(move => [move.from_group, move.to_group])]);
    const changed = [];
    for (const group of groups) {
        const state = await store.lib.store.chatRead('rootGroup', { tree, group: BigInt(group) });
        let held;
        if (group === target) {
            const [first] = state.first === null ? [] : await store.chats.decoded([(await store.chats.stored([state.first])).get(state.first)]);
            held = first?.extra?.greeting_id === edit.id && first?.mes === edit.text;
        }
        changed.push({ group, count: Number(state.count), ...(held === undefined ? {} : { held }) });
    }
    const [owner] = await store.lib.store.libraryKeys([tree]);
    const speaker = (await store.people.speakers([card])).get(card);
    const drawn = { name: speaker?.name ?? '', ...(tree === card ? {} : { original_avatar: avatar, force_avatar: avatarRefString(TYPE.character, avatar) }) };
    return { avatar, owner: owner?.type === TYPE.group ? { group_id: owner.key } : { avatar_url: owner?.key }, speaker: drawn, ...edit, groups: changed, moves: own.map(({ tree: _tree, id: _id, ...move }) => move) };
}
