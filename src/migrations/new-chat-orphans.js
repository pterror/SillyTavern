import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { setConfigFilePath } from '../util.js';
import { probeConfiguredServer } from './image-entities.js';

/**
 * A one-off for one user's data, run once with the server stopped, then deleted with its test.
 *
 *   node src/migrations/new-chat-orphans.js --dry-run [--data-root ./data] [--handle default-user] [--config ./config.yaml]
 *   node src/migrations/new-chat-orphans.js --apply [the same]
 */

const LOG_PREFIX = '[new-chat-orphans]';
const PAGE = 500;

/**
 * @param {import('../chat-engine.js').ChatEngine} chats
 * @param {bigint} tree
 * @param {bigint} at
 * @returns {Promise<bigint[]>}
 */
async function pathOf(chats, tree, at) {
    return /** @type {bigint[]} */ (await chats.store.chatRead('path', { tree, at }));
}

/**
 * @param {import('../chat-engine.js').ChatEngine} chats
 * @returns {Promise<bigint[]>}
 */
async function allSessions(chats) {
    /** @type {bigint[]} */
    const out = [];
    /** @type {bigint | undefined} */
    let before;
    for (;;) {
        const page = await chats.store.chatRead('recent', { limit: PAGE, ...(before === undefined ? {} : { before }) });
        for (const e of page) out.push(e.session);
        if (page.length < PAGE) return out;
        before = page[page.length - 1].position;
    }
}

/**
 * @param {import('../chat-engine.js').ChatEngine} chats
 * @param {bigint} session
 * @returns {Promise<{ n: number, target: bigint | null, tree: bigint | null, gone: boolean }[]>}
 */
async function historyOf(chats, session) {
    const out = [];
    let from = 1;
    for (;;) {
        const page = await chats.store.chatRead('history', { session, from, limit: PAGE });
        out.push(...page);
        if (page.length < PAGE) return out;
        from = page[page.length - 1].n + 1;
    }
}

/**
 * @param {import('../chat-engine.js').ChatEngine} chats
 * @param {bigint} tree
 * @returns {Promise<bigint[]>}
 */
async function bookmarkPositions(chats, tree) {
    /** @type {bigint[]} */
    const out = [];
    /** @type {bigint | undefined} */
    let after;
    for (;;) {
        const page = await chats.store.chatRead('treeBookmarks', { tree, limit: PAGE, ...(after === undefined ? {} : { after }) });
        for (const b of page) if (b && b.at !== null) out.push(b.at);
        if (page.length < PAGE) return out;
        after = page[page.length - 1].id;
    }
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function timeOf(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value !== '') {
        const t = Date.parse(value);
        if (Number.isFinite(t)) return t;
    }
    return null;
}

/**
 * @param {string} key a v7 session UUID
 * @returns {number | null}
 */
function uuidTime(key) {
    const hex = key.replace(/-/g, '').slice(0, 12);
    return /^[0-9a-f]{12}$/i.test(hex) && key[14] === '7' ? parseInt(hex, 16) : null;
}

/**
 * @param {import('../chat-engine.js').ChatEngine} chats
 * @returns {Promise<Map<bigint, { session: bigint, sessionKey: string, at: bigint, path: bigint[] }[]>>}
 */
export async function findOrphans(chats) {
    /** @type {Map<bigint, { session: bigint, at: bigint }[]>} */
    const left = new Map();
    /** @type {Map<bigint, Set<bigint>>} */
    const sessionsIn = new Map();
    /** @type {Map<bigint, string>} */
    const keys = new Map();
    const sessions = await allSessions(chats);
    for (const s of sessions) {
        const [row] = await chats.store.chatRead('sessions', { ids: [s] });
        if (!row) continue;
        keys.set(s, row.key);
        const entries = await historyOf(chats, s);
        const stored = await chats.stored(entries.filter(e => e.target !== null && !e.gone).map(e => /** @type {bigint} */ (e.target)));
        /** @type {Map<bigint, bigint | null>} */
        const last = new Map();
        for (const e of entries) {
            const m = e.target === null || e.gone ? undefined : stored.get(e.target);
            const tree = e.target === null ? e.tree : m?.owner ?? null;
            if (tree === null) continue;
            if (!sessionsIn.has(tree)) sessionsIn.set(tree, new Set());
            sessionsIn.get(tree)?.add(s);
            if (e.target !== null && m === undefined) {
                last.set(tree, null);
                continue;
            }
            const opening = e.target === null || m.parent === null;
            const was = last.get(tree);
            if (opening && was != null && was !== e.target) {
                if (!left.has(tree)) left.set(tree, []);
                left.get(tree)?.push({ session: s, at: was });
            }
            last.set(tree, e.target);
        }
    }

    /** @type {Map<bigint, { session: bigint, sessionKey: string, at: bigint, path: bigint[] }[]>} */
    const out = new Map();
    for (const [tree, positions] of left) {
        const stored = await chats.stored(positions.map(p => p.at));
        const candidates = [];
        for (const p of positions) {
            const m = stored.get(p.at);
            if (!m || m.owner !== tree || m.parent === null) continue;
            if (candidates.some(c => c.at === p.at)) continue;
            candidates.push({ ...p, sessionKey: /** @type {string} */ (keys.get(p.session)), path: await pathOf(chats, tree, p.at) });
        }
        if (candidates.length === 0) continue;
        /** @type {Set<bigint>} */
        const reached = new Set();
        const reach = async (/** @type {bigint} */ at) => { for (const id of await pathOf(chats, tree, at)) reached.add(id); };
        for (const at of await bookmarkPositions(chats, tree)) await reach(at);
        for (const s of sessionsIn.get(tree) ?? []) {
            const spot = await chats.store.chatRead('sessionInTree', { session: s, tree });
            if (spot && spot.at !== null) await reach(spot.at);
        }
        candidates.sort((a, b) => b.path.length - a.path.length);
        const kept = [];
        for (const c of candidates) {
            if (reached.has(c.at)) continue;
            kept.push(c);
            for (const id of c.path) reached.add(id);
        }
        if (kept.length) out.set(tree, kept);
    }
    return out;
}

/**
 * @param {object} options
 * @param {import('../chat-engine.js').ChatEngine} options.chats
 * @param {string} options.user the user's handle
 * @param {boolean} options.apply
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<{ trees: number, bookmarks: number }>}
 */
export async function recoverOrphans({ chats, user, apply, log = console.log }) {
    const { MODE, chatNameAt, freeName } = await import('../chat-engine.js');
    const found = await findOrphans(chats);
    let bookmarks = 0;
    for (const [tree, kept] of found) {
        const owner = await chats.owner(tree);
        const tips = await chats.stored(kept.map(c => c.at));
        const firsts = await chats.stored(kept.map(c => c.path[1] ?? c.at));
        const decoded = new Map();
        for (const [id, m] of [...tips, ...firsts]) if (!decoded.has(id)) decoded.set(id, (await chats.decoded([m]))[0]);
        log(`${LOG_PREFIX} ${owner.group ? 'group' : owner.name} (tree ${tree}): ${kept.length} chat(s) to bring back`);
        /** @type {object[]} */
        const records = [];
        /** @type {Set<string>} */
        const chosen = new Set();
        for (const c of kept) {
            const first = decoded.get(c.path[1] ?? c.at);
            const began = timeOf(first?.send_date) ?? uuidTime(c.sessionKey) ?? owner.created ?? Date.now();
            const name = await freeName(chatNameAt(owner, began), async n => chosen.has(n) || await chats.nameTaken(tree, n));
            chosen.add(name);
            const tip = decoded.get(c.at);
            const start = String(tip?.mes ?? '').replace(/\s+/g, ' ').slice(0, 80);
            log(`${LOG_PREFIX}   "${name}": ${c.path.length} message(s), last: ${start}`);
            bookmarks++;
            if (!apply) continue;
            const { user: u, session } = await chats.actorIds({ user, session: c.sessionKey }, records);
            const b = chats.next.position++;
            records.push({ id: b, mode: MODE.following, session, user: u, kind: 'positionCreate', pointer: c.at });
            records.push({ kind: 'positionName', id: b, name });
        }
        if (apply && records.length) await chats.serialized(tree, () => chats.store.commit(records));
    }
    return { trees: found.size, bookmarks };
}

/**
 * @param {object} options
 * @param {string} options.dataRoot
 * @param {string} options.handle
 * @param {boolean} options.apply
 * @param {() => Promise<any>} options.engine
 * @param {() => Promise<{ running: boolean, lines: string[] }>} [options.probeServer]
 * @param {(line: string) => void} [options.log]
 * @param {(line: string) => void} [options.warn]
 * @returns {Promise<number>}
 */
export async function runMigration(options) {
    const log = options.log ?? console.log;
    const warnLine = options.warn ?? console.warn;
    const probeServer = options.probeServer ?? probeConfiguredServer;
    const { STORE_DIR } = await import('../user-stores.js');
    const { LibraryEngine } = await import('../library-engine.js');
    const { libraryPeople } = await import('../chat-people.js');
    const { ChatEngine } = await import('../chat-engine.js');

    const root = path.join(options.dataRoot, options.handle);
    const storeDir = path.join(root, STORE_DIR);
    log(`${LOG_PREFIX} ${options.apply ? 'apply' : 'dry run'} for ${root}`);
    if (!fs.existsSync(storeDir)) {
        warnLine(`${LOG_PREFIX} REFUSED: ${storeDir} doesn't exist`);
        return 1;
    }
    const probe = await probeServer();
    probe.lines.forEach(line => log(`${LOG_PREFIX} ${line}`));
    if (probe.running) {
        warnLine(`${LOG_PREFIX} REFUSED: the server appears to be running (or the port could not be checked); stop it and rerun`);
        return 1;
    }
    const lib = await LibraryEngine.open(await options.engine(), storeDir);
    try {
        await lib.store.ready();
        const chats = await ChatEngine.open(lib.store, libraryPeople(lib), await lib.nextIds());
        const done = await recoverOrphans({ chats, user: options.handle, apply: options.apply, log });
        log(`${LOG_PREFIX} ${options.apply ? 'written' : 'would write (nothing was written)'}: ${done.bookmarks} bookmark(s) in ${done.trees} character(s) or group(s)`);
    } finally {
        await lib.close();
    }
    log(`${LOG_PREFIX} done`);
    return 0;
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
    const out = { dataRoot: './data', handle: 'default-user', config: './config.yaml', dryRun: false, apply: false, unknown: /** @type {string[]} */ ([]) };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--dry-run') out.dryRun = true;
        else if (arg === '--apply') out.apply = true;
        else if ((arg === '--data-root' || arg === '--handle' || arg === '--config') && argv[i + 1] !== undefined) {
            out[/** @type {'dataRoot' | 'handle' | 'config'} */ ({ '--data-root': 'dataRoot', '--handle': 'handle', '--config': 'config' }[arg])] = argv[++i];
        } else out.unknown.push(arg);
    }
    return out;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    const args = parseArgs(process.argv.slice(2));
    if (args.unknown.length > 0 || args.dryRun === args.apply) {
        console.warn(`${LOG_PREFIX} usage: --dry-run | --apply  [--data-root ./data] [--handle default-user] [--config ./config.yaml]`);
        process.exitCode = 2;
    } else {
        setConfigFilePath(args.config);
        await import('../fetch-patch.js');
        process.exitCode = await runMigration({
            ...args,
            engine: async () => {
                const { ensureEngine } = await import('../../engine/fetch.js');
                await ensureEngine();
                const { loadEngine } = await import('../../engine/load.js');
                return loadEngine().binding;
            },
        });
    }
}
