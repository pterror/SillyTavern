/**
 * Names every chat (docs/design/chat-names.md): a chat's name is its id, unique in its scope, and no other form names
 * a chat. A migration (`registry.js`), run by the server before the store is served.
 *
 * - Every bookmark gets a label: one with none is named as a new chat is (`chatNameAt()`, its time); one whose label
 *   another bookmark of its scope (a character's tree; all groups' together) had first, by id, becomes the next free
 *   one (`freeName()`: a name ending in a chat's time a millisecond later, else " (2)", " (3)" …).
 * - Every bookmark's label is written again, so the chat name index holds it.
 * - Old chat ids an extension kept in its settings (`s<UUID>.<tree>`, `b<id>`, as keys or as values) become the chats'
 *   names; a session's conversation named so has its name stored, so it stays.
 *
 * The labels are written in batches, how many recorded after each (`save`), so a run a stop cuts short goes on after
 * the last batch written: the plan is the same again, the bookmarks it labelled keeping their labels. Then everything
 * is read back and checked; a mismatch fails the migration.
 */

import { SPACE, chatNameAt, freeName } from '../chat-engine.js';
import { readUserModel, writeUserModel } from '../settings-model/user-store.js';

const SESSION_ID = /^s([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(0|[1-9][0-9]*)$/i;
const BOOKMARK_ID = /^b(0|[1-9][0-9]*)$/;
const PAGE = 500;
const COMMIT = 1000;

/**
 * Every bookmark of the store, in id order: `{ id, tree, name, time }`.
 * @param {import('../chat-engine.js').ChatEngine} chats
 */
async function allBookmarks(chats) {
    const { position } = await chats.store.chatRead('nextIds', {});
    const out = [];
    for (let from = 0n; from < BigInt(position); from += BigInt(PAGE)) {
        const ids = [];
        for (let id = from; id < from + BigInt(PAGE) && id < BigInt(position); id++) ids.push(id);
        const rows = await chats.store.chatRead('bookmarks', { ids });
        const at = rows.filter(r => r && r.at !== null).map(r => r.at);
        const owners = await chats.stored(at);
        for (const r of rows) {
            if (!r) continue;
            const tree = r.at === null ? r.root : owners.get(r.at)?.owner ?? null;
            if (tree !== null) out.push({ id: r.id, tree, name: typeof r.name === 'string' ? r.name : null, time: typeof r.time === 'number' ? r.time : 0 });
        }
    }
    return out;
}

/**
 * The labels every bookmark should have: `{ id, tree, from, to }` (`from` null for one with none).
 * @param {import('../chat-engine.js').ChatEngine} chats
 * @param {{ id: bigint, tree: bigint, name: string | null, time: number }[]} bookmarks
 */
async function plannedLabels(chats, bookmarks) {
    const owners = await chats.people.owners([...new Set(bookmarks.map(b => b.tree))]);
    /** @type {Map<string, Set<string>>} */
    const scopes = new Map();
    const plan = [];
    for (const b of bookmarks) {
        const owner = owners.get(b.tree);
        // A tree that is no character's or group's any more (its owner deleted, the chats kept) is its own scope.
        const scope = owner?.group ? 'groups' : String(b.tree);
        if (!scopes.has(scope)) scopes.set(scope, new Set());
        const taken = /** @type {Set<string>} */ (scopes.get(scope));
        const base = b.name !== null && b.name.trim() !== '' ? b.name : chatNameAt(owner ?? { group: false, name: '' }, b.time);
        const to = await freeName(base, async n => taken.has(n));
        taken.add(to);
        plan.push({ id: b.id, tree: b.tree, from: b.name, to });
    }
    return plan;
}

/**
 * What an old chat id names now, or null for none: a bookmark's label after the plan, a session's conversation name.
 * @param {import('../chat-engine.js').ChatEngine} chats
 * @param {Map<string, string>} labels By bookmark id.
 * @param {string} old
 * @returns {Promise<{ name: string, session?: { uuid: string, tree: bigint } } | null>}
 */
async function nameOfOldId(chats, labels, old) {
    const b = BOOKMARK_ID.exec(old);
    if (b) {
        const name = labels.get(b[1]);
        return name === undefined ? null : { name };
    }
    const s = SESSION_ID.exec(old);
    if (!s) return null;
    const tree = BigInt(s[2]);
    if (!(await chats.people.owners([tree])).has(tree)) return null;
    return { name: await chats.conversationName(s[1], s[1], tree), session: { uuid: s[1], tree } };
}

/**
 * An extension's settings with old chat ids (keys, or whole string values) as the chats' names, and each move.
 * @param {unknown} value
 * @param {(old: string) => Promise<{ name: string } | null>} rename
 * @param {string[]} at
 * @param {{ path: string, from: string, to: string }[]} moves
 * @returns {Promise<unknown>}
 */
async function renamedIn(value, rename, at, moves) {
    if (typeof value === 'string') {
        const found = BOOKMARK_ID.test(value) || SESSION_ID.test(value) ? await rename(value) : null;
        if (found === null) return value;
        moves.push({ path: at.join('.'), from: value, to: found.name });
        return found.name;
    }
    if (Array.isArray(value)) {
        const out = [];
        for (const [i, v] of value.entries()) out.push(await renamedIn(v, rename, [...at, String(i)], moves));
        return out;
    }
    if (value === null || typeof value !== 'object') return value;
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        const found = BOOKMARK_ID.test(k) || SESSION_ID.test(k) ? await rename(k) : null;
        const key = found === null ? k : found.name;
        if (found !== null) {
            if (Object.hasOwn(value, key)) {
                moves.push({ path: [...at, k].join('.'), from: k, to: `${key} (taken: kept as it was)` });
                out[k] = await renamedIn(v, rename, [...at, k], moves);
                continue;
            }
            moves.push({ path: [...at, k].join('.'), from: k, to: key });
        }
        out[key] = await renamedIn(v, rename, [...at, key], moves);
    }
    return out;
}

/**
 * @param {import('./registry.js').MigrationContext} context
 */
export async function run({ store, handle, saved, save, progress, log }) {
    const { chats } = store;
    const plan = await plannedLabels(chats, await allBookmarks(chats));
    const changed = plan.filter(p => p.from !== p.to);
    log(`${plan.length} bookmark(s), ${changed.length} relabelled`);
    const labels = new Map(plan.map(p => [String(p.id), p.to]));

    const model = await readUserModel(store.lib, handle);
    /** @type {{ path: string, from: string, to: string }[]} */
    const moves = [];
    /** @type {Map<string, { uuid: string, tree: bigint }>} */
    const sessions = new Map();
    const rename = async (/** @type {string} */ old) => {
        const found = await nameOfOldId(chats, labels, old);
        if (found?.session) sessions.set(old, found.session);
        return found;
    };
    const ext = model ? /** @type {Record<string, unknown>} */ (await renamedIn(model.ext, rename, ['ext'], moves)) : null;
    for (const m of moves) log(`extension setting ${m.path}: ${m.from} -> ${m.to}`);

    /** @type {object[]} */
    const records = plan.map(p => ({ kind: 'positionName', id: p.id, name: p.to }));
    const [user] = await chats.store.chatRead('ids', { space: SPACE.user, keys: [handle] });
    for (const { uuid, tree } of sessions.values()) {
        const [sid] = await chats.store.chatRead('ids', { space: SPACE.session, keys: [uuid] });
        if (sid === null || user === null || await chats.store.chatRead('conversationName', { session: sid, tree }) !== null) continue;
        records.push({ kind: 'conversationName', session: sid, user, tree, name: await chats.conversationName(uuid, uuid, tree) });
    }
    // Where a run cut short got to: the batches before it are written.
    const from = typeof saved === 'object' && saved !== null && typeof (/** @type {any} */ (saved).written) === 'number' ? /** @type {any} */ (saved).written : 0;
    if (from > 0) log(`going on after ${from} written`);
    for (let i = from; i < records.length; i += COMMIT) {
        const batch = records.slice(i, i + COMMIT);
        await chats.store.commit(batch);
        await save({ written: i + batch.length });
        progress(i + batch.length, records.length);
    }
    if (model && moves.length) await writeUserModel(store.lib, handle, { ...model, ext: /** @type {any} */ (ext) }, { previous: model });

    // Read back: every bookmark labelled as planned, each name once in its scope, no old id left.
    const back = await allBookmarks(chats);
    const wrong = back.filter(b => b.name !== labels.get(String(b.id)));
    const repeated = [];
    for (const b of back) {
        if (b.name !== null && (await chats.people.owners([b.tree])).has(b.tree) && await chats.nameTaken(b.tree, b.name, { bookmark: b.id })) repeated.push(b);
    }
    const left = [];
    if (model) await renamedIn((await readUserModel(store.lib, handle))?.ext, async old => (left.push(old), null), ['ext'], []);
    if (wrong.length || repeated.length || left.length) {
        throw new Error(`read back otherwise: ${wrong.length} label(s) not as written (bookmarks ${wrong.map(b => b.id).join(', ')}), `
            + `${repeated.length} not unique in their scope (bookmarks ${repeated.map(b => b.id).join(', ')}), ${left.length} old chat id(s) left in extension settings`);
    }
}
