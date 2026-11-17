/**
 * Refresh stored openings after a card edit, including the card's group conversations.
 * @param {import('./user-stores.js').UserStore} store
 * @param {bigint} card
 * @param {{ id: number, text: string }[]} greetings
 */
export async function relinkCardOpenings(store, card, greetings) {
    let changed = 0;
    for (const greeting of greetings) changed += (await store.chats.linkGreetingMatches(card, greeting, { user: store.handle })).length;
    return changed;
}
