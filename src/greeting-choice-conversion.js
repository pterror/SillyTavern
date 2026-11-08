import { SPACE } from './actor-ids.js';
import { TYPE } from './library-codes.js';
import { greetingModelOf } from './greeting-items.js';
import { greetingChoice } from './chat-engine.js';

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
    /** @type {Map<bigint, { ids: number[], epoch: number } | null>} */
    const greetingsOf = new Map();
    const idsOf = async (/** @type {bigint} */ tree) => {
        if (!greetingsOf.has(tree)) {
            const [key] = await lib.store.libraryKeys([tree]);
            const entity = key && key.type === TYPE.character ? (await lib.entities([tree]))[0] : null;
            const model = entity ? greetingModelOf(entity) : null;
            greetingsOf.set(tree, model ? { ids: model.greetings.filter(g => g.text !== '').map(g => g.id), epoch: model.defaultEpoch ?? 0 } : null);
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
            const card = await idsOf(tree);
            if (card === null) continue;
            const id = card.ids.length === 0 ? null : card.ids[Math.min(Number(place), card.ids.length - 1)];
            found.push({ kind: 'openingChoice', session, user, tree, index: greetingChoice(id, card.epoch) });
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

/**
 * Writes every stored first message again by the rule a first message is written by: one with a card greeting's text
 * is linked to that greeting.
 * @param {import('./library-engine.js').LibraryEngine} lib
 * @param {import('./chat-engine.js').ChatEngine} chats
 * @param {string} handle
 * @returns {Promise<number>} how many first messages changed
 */
export async function convertOpeningLinks(lib, chats, handle) {
    let changed = 0;
    /** @type {string | undefined} */
    let cursor;
    for (;;) {
        const page = await lib.query({ sortField: 'name', limit: PAGE, cursor, wantRows: false, wantTotal: false, wantHashes: true, includeGroups: false });
        const avatars = /** @type {{ id: string }[]} */ (page.hashRows).map(r => r.id);
        for (const avatar of avatars) {
            const entity = await lib.entity(TYPE.character, avatar);
            if (!entity) continue;
            const greetings = greetingModelOf(entity).greetings.filter(g => g.text !== '');
            changed += await chats.relinkStarts({ tree: entity.id, greetings, actor: { user: handle } });
        }
        if (typeof page.cursor !== 'string' || avatars.length === 0) return changed;
        cursor = page.cursor;
    }
}
