import { SPACE } from './actor-ids.js';
import { TYPE } from './library-codes.js';
import { greetingModelOf } from './greeting-items.js';
import { greetingChoice } from './chat-engine.js';
import { applyGreetingsModelToCard } from './greeting-list.js';
import { GREETING_SHOWN } from './tab-views.js';

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

/**
 * Collapses each card's greetings with the same text to the first copy, and moves what named a removed copy to the
 * kept one: the default, sessions' remembered greetings, tabs' shown greetings and stored openings' links.
 * @param {import('./library-engine.js').LibraryEngine} lib
 * @param {import('./chat-engine.js').ChatEngine} chats
 * @param {string} handle
 * @param {{ root: string }} directories
 * @returns {Promise<number>} how many greetings were removed
 */
export async function convertDuplicateGreetings(lib, chats, handle, directories) {
    /** @type {Map<bigint, { avatar: string, kept: Map<number, number>, epochs: [number, number] }>} */
    const changed = new Map();
    let removed = 0;
    /** @type {string | undefined} */
    let cursor;
    for (;;) {
        const page = await lib.query({ sortField: 'name', limit: PAGE, cursor, wantRows: false, wantTotal: false, wantHashes: true, includeGroups: false });
        const avatars = /** @type {{ id: string }[]} */ (page.hashRows).map(r => r.id);
        for (const avatar of avatars) {
            const entity = await lib.entity(TYPE.character, avatar);
            if (!entity) continue;
            const model = greetingModelOf(entity);
            const first = new Map();
            /** @type {Map<number, number>} */
            const kept = new Map();
            for (const g of model.greetings) {
                if (first.has(g.text)) kept.set(g.id, first.get(g.text));
                else first.set(g.text, g.id);
            }
            if (!kept.size) continue;
            const greetings = model.greetings.filter(g => !kept.has(g.id));
            const defaultId = model.defaultId === null ? null : kept.get(model.defaultId) ?? model.defaultId;
            const [card] = /** @type {any[]} */ (await lib.cards([avatar]));
            applyGreetingsModelToCard(card, { greetings: greetings.map(g => g.text), defaultIndex: defaultId === null ? null : greetings.findIndex(g => g.id === defaultId) });
            await lib.writeCard(directories, avatar, JSON.stringify(card), { greetings: { greetings, defaultId, nextId: model.nextId } });
            const after = await lib.greetingModel(avatar);
            changed.set(entity.id, { avatar, kept, epochs: [model.defaultEpoch ?? 0, after.defaultEpoch ?? 0] });
            removed += kept.size;
            const edits = [];
            for (const { message, stored } of await chats.openings(entity.id)) {
                const from = kept.get(message?.extra?.greeting_id);
                if (from !== undefined) edits.push({ node_id: chats.externalId(stored), patch: { extra: { ...message.extra, greeting_id: from } } });
            }
            if (edits.length) await chats.editMessages({ tree: entity.id, treeSpeaker: null, edits, actor: { user: handle } });
        }
        if (typeof page.cursor !== 'string' || avatars.length === 0) break;
        cursor = page.cursor;
    }
    if (!changed.size) return 0;

    const [user] = await lib.store.chatRead('ids', { space: SPACE.user, keys: [handle] });
    const choices = [];
    /** @type {bigint | undefined} */
    let before;
    for (;;) {
        const page = /** @type {{ position: bigint, session: bigint | null, tree: bigint }[]} */ (await lib.store.chatRead('conversations', { ...(before === undefined ? {} : { before }), limit: PAGE }));
        if (page.length === 0) break;
        for (const { session, tree } of page) {
            const card = changed.get(tree);
            if (session === null || !card || user === null || user === undefined) continue;
            const chosen = await chats.cardChoice(session, tree);
            if (chosen === null || chosen.epoch !== card.epochs[0]) continue;
            const id = card.kept.get(chosen.id) ?? chosen.id;
            if (id === chosen.id && card.epochs[0] === card.epochs[1]) continue;
            choices.push({ kind: 'openingChoice', session, user, tree, index: greetingChoice(id, card.epochs[1]) });
        }
        before = page[page.length - 1].position;
    }
    choices.reverse();
    for (let i = 0; i < choices.length; i += PAGE) await lib.store.commit(choices.slice(i, i + PAGE));

    const byAvatar = new Map([...changed.values()].map(c => [c.avatar, c.kept]));
    /** @type {string | null} */
    let after = null;
    for (;;) {
        const { entities, more } = await lib.store.libraryOfType(TYPE.tabView, after, PAGE);
        const records = [];
        for (const view of await lib.entities(entities.map((/** @type {{ id: bigint }} */ e) => e.id))) {
            for (const v of view?.values ?? []) {
                if (typeof v.field !== 'string' || !v.field.startsWith(GREETING_SHOWN) || v.json === undefined) continue;
                const shown = JSON.parse(v.json);
                const id = byAvatar.get(v.field.slice(GREETING_SHOWN.length))?.get(shown?.id);
                if (id !== undefined) records.push({ kind: 'jsonValue', entity: /** @type {any} */ (view).id, field: v.field, json: JSON.stringify({ ...shown, id }) });
            }
        }
        if (records.length) await lib.store.commit(records);
        if (!more || entities.length === 0) break;
        after = entities[entities.length - 1].key;
    }
    return removed;
}
