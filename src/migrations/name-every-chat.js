import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { setConfigFilePath } from '../util.js';
import { USER_DIRECTORY_TEMPLATE } from '../constants.js';
import { loadOneOffEngine, parseOneOffArgs, probeConfiguredServer } from './one-off.js';

/**
 * Names every chat (docs/design/chat-names.md): a chat's name is its id, unique in its scope, and no other form names
 * a chat. A one-off: run once with the server stopped, then deleted with its test.
 *
 * - Every bookmark gets a label: one with none is named as a new chat is (`chatNameAt()`, its time); one whose label
 *   another bookmark of its scope (a character's tree; all groups' together) had first, by id, becomes the next free
 *   one (`freeName()`: a name ending in a chat's time a millisecond later, else " (2)", " (3)" …).
 * - Every bookmark's label is written again, so the chat name index (new) holds it.
 * - Old chat ids an extension kept in its settings (`s<UUID>.<tree>`, `b<id>`, as keys or as values) become the chats'
 *   names; a session's conversation named so has its name stored, so it stays.
 *
 * The dry run lists every change and writes nothing. --apply writes them, reads everything back and checks it, and then
 * marks the store's chats named (`CHAT_NAMES_META`): until then the server refuses that user's chat routes.
 *
 *   node src/migrations/name-every-chat.js --dry-run [--data-root ./data] [--handle default-user] [--config ./config.yaml]
 *   node src/migrations/name-every-chat.js --apply [the same]
 */

const LOG_PREFIX = '[name-every-chat]';
const SESSION_ID = /^s([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(0|[1-9][0-9]*)$/i;
const BOOKMARK_ID = /^b(0|[1-9][0-9]*)$/;
const PAGE = 500;
const COMMIT = 1000;

/**
 * A user's directories under a data root.
 * @param {string} dataRoot
 * @param {string} handle
 * @returns {import('../users.js').UserDirectoryList}
 */
export function directoriesFor(dataRoot, handle) {
    /** @type {Record<string, string>} */
    const out = {};
    for (const [key, sub] of Object.entries(USER_DIRECTORY_TEMPLATE)) out[key] = path.join(dataRoot, handle, sub);
    return /** @type {any} */ (out);
}

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
    const { chatNameAt, freeName } = await import('../chat-engine.js');
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
 * @param {object} options
 * @param {string} options.dataRoot
 * @param {string} options.handle
 * @param {boolean} options.apply
 * @param {() => Promise<any>} options.engine Loads the engine binding.
 * @param {() => Promise<{ running: boolean, lines: string[] }>} [options.probeServer]
 * @param {(line: string) => void} [options.log]
 * @param {(line: string) => void} [options.warn]
 * @returns {Promise<number>} The exit code: 0 done, 1 refused or failed.
 */
export async function runNameEveryChat(options) {
    const log = options.log ?? console.log;
    const warnLine = options.warn ?? console.warn;
    const probeServer = options.probeServer ?? probeConfiguredServer;
    // Their imports read config when they load: after the config path is set.
    const { setStoreEngine, userStore, closeUserStores, STORE_DIR } = await import('../user-stores.js');
    const { readUserModel, writeUserModel } = await import('../settings-model/user-store.js');
    const { CHAT_NAMES_META, SPACE } = await import('../chat-engine.js');

    const directories = directoriesFor(options.dataRoot, options.handle);
    log(`${LOG_PREFIX} ${options.apply ? 'apply' : 'dry run'} for ${directories.root}`);
    if (!fs.existsSync(path.join(directories.root, STORE_DIR))) {
        warnLine(`${LOG_PREFIX} REFUSED: ${path.join(directories.root, STORE_DIR)} doesn't exist`);
        return 1;
    }
    const probe = await probeServer();
    probe.lines.forEach(line => log(`${LOG_PREFIX} ${line}`));
    if (probe.running) {
        warnLine(`${LOG_PREFIX} REFUSED: the server appears to be running (or the port could not be checked); stop it and rerun`);
        return 1;
    }

    const binding = await options.engine();
    setStoreEngine(() => binding);
    const store = await userStore({ root: directories.root });
    try {
        const { chats } = store;
        // This is what names them: the guard against serving unnamed chats doesn't apply here.
        chats.namesPendingFor = null;
        const plan = await plannedLabels(chats, await allBookmarks(chats));
        const changed = plan.filter(p => p.from !== p.to);
        for (const p of changed) log(`${LOG_PREFIX} bookmark ${p.id} (tree ${p.tree}): ${p.from === null ? '(no label)' : JSON.stringify(p.from)} -> ${JSON.stringify(p.to)}`);
        log(`${LOG_PREFIX} ${plan.length} bookmark(s), ${changed.length} relabelled`);
        const labels = new Map(plan.map(p => [String(p.id), p.to]));

        const model = await readUserModel(store.lib, options.handle);
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
        for (const m of moves) log(`${LOG_PREFIX} extension setting ${m.path}: ${m.from} -> ${m.to}`);
        log(`${LOG_PREFIX} ${moves.length} old chat id(s) in extension settings`);
        if (!options.apply) return 0;

        const records = plan.map(p => ({ kind: 'positionName', id: p.id, name: p.to }));
        const [user] = await chats.store.chatRead('ids', { space: SPACE.user, keys: [options.handle] });
        for (const { uuid, tree } of sessions.values()) {
            const [sid] = await chats.store.chatRead('ids', { space: SPACE.session, keys: [uuid] });
            if (sid === null || user === null || await chats.store.chatRead('conversationName', { session: sid, tree }) !== null) continue;
            records.push({ kind: 'conversationName', session: sid, user, tree, name: await chats.conversationName(uuid, uuid, tree) });
        }
        for (let i = 0; i < records.length; i += COMMIT) await chats.store.commit(records.slice(i, i + COMMIT));
        if (model && moves.length) await writeUserModel(store.lib, options.handle, { ...model, ext: /** @type {any} */ (ext) }, { previous: model });

        // Read back: every bookmark labelled as planned, each name once in its scope, no old id left.
        const back = await allBookmarks(chats);
        const wrong = back.filter(b => b.name !== labels.get(String(b.id)));
        for (const b of wrong) warnLine(`${LOG_PREFIX} read back otherwise: bookmark ${b.id}: ${JSON.stringify(b.name)}`);
        const repeated = [];
        for (const b of back) {
            if (b.name !== null && (await chats.people.owners([b.tree])).has(b.tree) && await chats.nameTaken(b.tree, b.name, { bookmark: b.id })) repeated.push(b);
        }
        for (const b of repeated) warnLine(`${LOG_PREFIX} not unique in its scope: bookmark ${b.id} ${JSON.stringify(b.name)}`);
        const left = [];
        if (model) await renamedIn((await readUserModel(store.lib, options.handle))?.ext, async old => (left.push(old), null), ['ext'], []);
        for (const old of left) warnLine(`${LOG_PREFIX} an old chat id is left in extension settings: ${old}`);
        if (wrong.length || repeated.length || left.length) {
            warnLine(`${LOG_PREFIX} FAILED: ${wrong.length} label(s) read back otherwise, ${repeated.length} not unique, ${left.length} old id(s) left`);
            return 1;
        }
        await store.lib.store.commit([{ kind: 'metaValue', key: CHAT_NAMES_META, json: 'true' }]);
        log(`${LOG_PREFIX} written and read back: every chat named, each once in its scope; the store is marked so`);
        return 0;
    } finally {
        await closeUserStores();
    }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    const args = parseOneOffArgs(process.argv.slice(2));
    if (args.unknown.length > 0 || args.again || Boolean(args.dryRun) === Boolean(args.apply)) {
        console.warn(`${LOG_PREFIX} usage: --dry-run | --apply  [--data-root ./data] [--handle default-user] [--config ./config.yaml]`);
        process.exitCode = 2;
    } else {
        setConfigFilePath(args.config);
        process.exitCode = await runNameEveryChat({ dataRoot: args.dataRoot, handle: args.handle, apply: Boolean(args.apply), engine: loadOneOffEngine });
    }
}
