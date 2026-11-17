/**
 * Refresh stored openings after a card edit, including the card's group conversations.
 * @param {import('./user-stores.js').UserStore} store
 * @param {bigint} card
 * @param {{ id: number, text: string }[]} greetings
 */
export async function relinkCardOpenings(store, card, greetings) {
    const trees = new Set([card]);
    /** @type {bigint | undefined} */
    let before;
    for (;;) {
        const page = await store.lib.store.chatRead('conversations', { ...(before === undefined ? {} : { before }), limit: 500 });
        if (!page.length) break;
        for (const row of page) trees.add(row.tree);
        before = page.at(-1).position;
    }
    let changed = 0;
    for (const tree of trees) {
        if (tree !== card && !(await store.chats.cardGreetings(tree)).cards.includes(card)) continue;
        changed += await store.chats.relinkStarts({ tree, card, greetings, actor: { user: store.handle } });
    }
    return changed;
}
