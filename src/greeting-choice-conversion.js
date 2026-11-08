import { SPACE } from './actor-ids.js';
import { TYPE } from './library-codes.js';
import { greetingModelOf } from './greeting-items.js';

const PAGE = 500;

/**
 * A choice is read as the place among the card's greetings that have text, clamped to the last, as code before
 * greeting ids stored it.
 * @param {import('./library-engine.js').LibraryEngine} lib
 * @param {string} handle
 * @returns {Promise<number>} how many choices were rewritten
 */
export async function convertGreetingChoices(lib, handle) {
    const [user] = await lib.store.chatRead('ids', { space: SPACE.user, keys: [handle] });
    if (user === null || user === undefined) return 0;
    /** @type {Map<bigint, number[] | null>} */
    const greetingsOf = new Map();
    const idsOf = async (/** @type {bigint} */ tree) => {
        if (!greetingsOf.has(tree)) {
            const [key] = await lib.store.libraryKeys([tree]);
            const entity = key && key.type === TYPE.character ? (await lib.entities([tree]))[0] : null;
            greetingsOf.set(tree, entity ? greetingModelOf(entity).greetings.filter(g => g.text !== '').map(g => g.id) : null);
        }
        return greetingsOf.get(tree) ?? null;
    };
    const found = [];
    /** @type {bigint | undefined} */
    let before;
    for (;;) {
        const page = /** @type {{ position: bigint, session: bigint | null, tree: bigint }[]} */ (await lib.store.chatRead('conversations', { ...(before === undefined ? {} : { before }), limit: PAGE }));
        if (page.length === 0) break;
        for (const { session, tree } of page) {
            if (session === null) continue;
            const place = await lib.store.chatRead('openingChoice', { session, tree });
            if (place === null || place === undefined) continue;
            const ids = await idsOf(tree);
            if (ids === null) continue;
            const id = ids.length === 0 ? null : ids[Math.min(Number(place), ids.length - 1)];
            found.push({ kind: 'openingChoice', session, user, tree, index: id === null ? 0 : id + 1 });
        }
        before = page[page.length - 1].position;
    }
    found.reverse();
    let rewritten = 0;
    for (let i = 0; i < found.length; i += PAGE) {
        const records = found.slice(i, i + PAGE);
        await lib.store.commit(records);
        rewritten += records.length;
    }
    return rewritten;
}
