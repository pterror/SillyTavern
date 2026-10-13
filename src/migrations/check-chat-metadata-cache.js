import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { setConfigFilePath } from '../util.js';
import { USER_DIRECTORY_TEMPLATE } from '../constants.js';
import { normalizeGroupRecord } from '../group-id.js';
import { TYPE } from '../library-codes.js';
import { probeConfiguredServer } from './cleanup-zztest-leftovers.js';

/**
 * Checks that one user's `chat-metadata.sqlite`, a cache of the old `.jsonl` chat files no code reads, holds no
 * value that exists nowhere else, and deletes it only then. A one-off, run after `convert-to-engine.js`: once on the
 * existing data, then deleted.
 *
 * The only value in it someone set is a chat's metadata (`chats.chat_metadata_json`). Each value it holds (each
 * top-level key, and each variable of `variables`) must be in the engine's state at the node of that chat's label,
 * equal as canonical JSON: the label found in the old `message-tree.sqlite` (left in place by the conversion) by
 * owner and chat name from `file_path` (`chats/<owner>/<name>.jsonl`; `group chats/<name>.jsonl`, the owner being the
 * group whose `chats` lists the name), the node as the conversion keyed it (a label on an anchor row: its tree's
 * root). Left out: the cache's `main_chat` and `fork_point` and the chat's `integrity` (derived now), and
 * `__is_group` (the old store's own mark). Metadata that is NULL or holds no key holds no value. Everything else in
 * the file is skipped: counts and previews derived from messages, the old files' mtime and size, and the cache's own
 * bookkeeping.
 *
 * Output names no chat and shows no content: each row whose values aren't all there is listed by owner kind, the
 * sha256 of its file path, its key count, how many of its values differ, and the sha256 of its canonical metadata.
 *
 * It opens the user's engine store, so both runs need the server stopped:
 *   node src/migrations/check-chat-metadata-cache.js --dry-run --server-stopped [--data-root ./data] [--handle default-user] [--config ./config.yaml]
 *   node src/migrations/check-chat-metadata-cache.js --apply --server-stopped [--data-root ./data] [--handle default-user] [--config ./config.yaml]
 * The real run deletes the file only when every row's values are there.
 */

const LOG_PREFIX = '[check-chat-metadata]';
const PAGE_ROWS = 500;
const LEFT_OUT = ['main_chat', 'fork_point', 'integrity', '__is_group'];

/** @param {unknown} value */
function sortKeysDeep(value) {
    if (Array.isArray(value)) return value.map(sortKeysDeep);
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeysDeep(/** @type {Record<string, unknown>} */ (value)[key])]));
    }
    return value;
}

/** @param {string} text */
function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

/** @param {unknown} value */
const canonical = value => JSON.stringify(sortKeysDeep(value));

/**
 * The values a metadata object holds: each top-level key (left-out ones aside), and each variable of an object
 * `variables` on its own, as canonical JSON.
 * @param {unknown} metadata
 * @returns {Map<string, string>} `k\0<key>` and `v\0<name>`.
 */
function valuesOf(metadata) {
    /** @type {Map<string, string>} */
    const out = new Map();
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return out;
    for (const [key, value] of Object.entries(metadata)) {
        if (LEFT_OUT.includes(key)) continue;
        if (key === 'variables' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
            for (const [name, v] of Object.entries(value)) out.set(`v\0${name}`, canonical(v));
        } else {
            out.set(`k\0${key}`, canonical(value));
        }
    }
    return out;
}

/**
 * Chat name -> the ids of the groups whose `chats` list it, from every group file.
 * @param {string} groupsDir
 * @returns {Map<string, string[]>}
 */
function groupChatOwners(groupsDir) {
    /** @type {Map<string, string[]>} */
    const owners = new Map();
    if (!fs.existsSync(groupsDir)) return owners;
    for (const file of fs.readdirSync(groupsDir)) {
        if (!file.endsWith('.json')) continue;
        let group;
        try {
            group = normalizeGroupRecord(JSON.parse(fs.readFileSync(path.join(groupsDir, file), 'utf8')));
        } catch {
            continue;
        }
        if (typeof group?.id !== 'string' || !Array.isArray(group.chats)) continue;
        for (const chat of new Set(group.chats.map(String))) {
            const list = owners.get(chat) ?? [];
            list.push(group.id);
            owners.set(chat, list);
        }
    }
    return owners;
}

/**
 * @typedef {object} RowProblem
 * @property {'missing' | 'mismatch' | 'unparseable'} kind
 * @property {'character' | 'group' | 'unknown'} ownerKind
 * @property {string} pathHash sha256 of the row's file_path.
 * @property {number} keys Values in the cache's metadata.
 * @property {number} differing Of them, those not in the engine's state (all of them when the chat isn't there).
 * @property {string} cacheHash sha256 of the cache's canonical metadata.
 */

/**
 * The engine's state where a chat's label is, as `chat_metadata` reads it; null when the label or its node isn't
 * found once.
 * @param {object} options
 * @param {any} options.tree better-sqlite3 connection to message-tree.sqlite.
 * @param {import('../user-stores.js').UserStore} options.store
 * @param {'character' | 'group'} kind
 * @param {string[]} ownerIds Old owner ids.
 * @param {string} chatName
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function engineState({ tree, store }, kind, ownerIds, chatName) {
    const found = ownerIds.flatMap(ownerId => [...tree.prepare('SELECT id, parent_id, owner_id FROM messages WHERE owner_id = ? AND label = ? LIMIT 2').iterate(ownerId, chatName)]);
    if (found.length !== 1) return null;
    const [row] = found;
    const [owned] = kind === 'character'
        ? await store.lib.ids(TYPE.character, [`${row.owner_id}.png`])
        : await store.lib.ids(TYPE.group, [row.owner_id]);
    const [treeId] = owned !== null ? [owned] : await store.lib.ids(TYPE.tree, [row.owner_id]);
    if (treeId === null) return null;
    const answer = await store.chats.stateAt({ tree: treeId, at: row.parent_id === null ? null : row.id });
    return answer && 'state' in answer ? answer.state : null;
}

/**
 * Compares every cache row with the engine.
 * @param {object} options
 * @param {any} options.cache better-sqlite3 connection to chat-metadata.sqlite.
 * @param {any} options.tree better-sqlite3 connection to message-tree.sqlite.
 * @param {import('../user-stores.js').UserStore} options.store The user's engine store.
 * @param {{ chats: string, groupChats: string, groups: string }} options.dirs
 * @returns {Promise<{ rows: number, empty: number, matched: number, problems: RowProblem[] }>}
 */
export async function checkCache({ cache, tree, store, dirs }) {
    const groupOwners = groupChatOwners(dirs.groups);
    const page = cache.prepare('SELECT rowid AS r, file_path, chat_metadata_json FROM chats WHERE rowid > ? ORDER BY rowid LIMIT ?');
    const result = { rows: 0, empty: 0, matched: 0, problems: /** @type {RowProblem[]} */ ([]) };
    let after = 0;
    for (;;) {
        const rows = [...page.iterate(after, PAGE_ROWS)];
        if (rows.length === 0) break;
        for (const row of rows) {
            result.rows++;
            const filePath = String(row.file_path);
            const base = { pathHash: sha256(filePath) };
            let metadata;
            try {
                metadata = row.chat_metadata_json === null ? {} : JSON.parse(row.chat_metadata_json);
            } catch {
                result.problems.push({ kind: 'unparseable', ownerKind: 'unknown', ...base, keys: 0, differing: 0, cacheHash: sha256(String(row.chat_metadata_json)) });
                continue;
            }
            const values = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
                ? valuesOf(metadata)
                : new Map([['whole', canonical(metadata)]]);
            if (values.size === 0) {
                result.empty++;
                continue;
            }
            const chatName = path.basename(filePath).replace(/\.jsonl$/, '');
            const parent = path.dirname(filePath);
            /** @type {'character' | 'group' | 'unknown'} */
            let ownerKind = 'unknown';
            /** @type {string[]} */
            let ownerIds = [];
            if (path.basename(parent) === path.basename(dirs.groupChats)) {
                ownerKind = 'group';
                ownerIds = groupOwners.get(chatName) ?? [];
            } else if (path.basename(path.dirname(parent)) === path.basename(dirs.chats)) {
                ownerKind = 'character';
                ownerIds = [path.basename(parent)];
            }
            const problem = { ownerKind, ...base, keys: values.size, cacheHash: sha256(canonical(metadata)) };
            const state = ownerKind === 'unknown' ? null : await engineState({ tree, store }, ownerKind, ownerIds, chatName);
            if (state === null) {
                result.problems.push({ kind: 'missing', ...problem, differing: values.size });
                continue;
            }
            const there = valuesOf(state);
            const differing = [...values].filter(([k, v]) => there.get(k) !== v).length;
            if (differing === 0) result.matched++;
            else result.problems.push({ kind: 'mismatch', ...problem, differing });
        }
        after = rows[rows.length - 1].r;
        if (rows.length < PAGE_ROWS) break;
    }
    return result;
}

/**
 * @param {object} options
 * @param {string} options.dataRoot
 * @param {string} options.handle
 * @param {boolean} options.apply
 * @param {boolean} options.serverStopped
 * @param {any} options.Database better-sqlite3 constructor, or null when the native binding isn't usable.
 * @param {() => any} options.engine The engine's binding.
 * @param {() => Promise<{ running: boolean, lines: string[] }>} [options.probeServer]
 * @param {(line: string) => void} [options.log]
 * @param {(line: string) => void} [options.warn]
 * @returns {Promise<number>} Process exit code: 0 safe (and, on a real run, deleted), 1 refused or not safe.
 */
export async function runCheck(options) {
    const { dataRoot, handle, apply, serverStopped, Database } = options;
    const log = options.log ?? console.log;
    const warn = options.warn ?? console.warn;
    const probeServer = options.probeServer ?? probeConfiguredServer;
    const root = path.join(dataRoot, handle);
    const cachePath = path.join(root, 'chat-metadata.sqlite');
    const treePath = path.join(root, 'message-tree.sqlite');
    const dirs = {
        chats: path.join(root, USER_DIRECTORY_TEMPLATE.chats),
        groupChats: path.join(root, USER_DIRECTORY_TEMPLATE.groupChats),
        groups: path.join(root, USER_DIRECTORY_TEMPLATE.groups),
    };

    log(`${LOG_PREFIX} ${apply ? 'real run' : 'dry run'} for ${cachePath}`);
    if (!Database) {
        warn(`${LOG_PREFIX} REFUSED: native better-sqlite3 is not available; this script never opens these databases with the wasm engine`);
        return 1;
    }
    if (!serverStopped) {
        warn(`${LOG_PREFIX} REFUSED: this opens the user's store, so it needs --server-stopped (stop the server first; a --port override is not visible to the port probe)`);
        return 1;
    }
    const probe = await probeServer();
    probe.lines.forEach(line => log(`${LOG_PREFIX} ${line}`));
    if (probe.running) {
        warn(`${LOG_PREFIX} REFUSED: the server appears to be running (or the port could not be checked); stop it and rerun`);
        return 1;
    }
    if (!fs.existsSync(cachePath)) {
        log(`${LOG_PREFIX} ${cachePath} does not exist; nothing to do.`);
        return 0;
    }
    if (!fs.existsSync(treePath)) {
        warn(`${LOG_PREFIX} REFUSED: ${treePath} does not exist`);
        return 1;
    }
    const stores = await import('../user-stores.js');
    if (!fs.existsSync(path.join(root, stores.STORE_DIR))) {
        warn(`${LOG_PREFIX} REFUSED: ${path.join(root, stores.STORE_DIR)} does not exist; run src/migrations/convert-to-engine.js first`);
        return 1;
    }

    stores.setStoreEngine(options.engine);
    const store = await stores.userStore({ root }, handle);
    const cache = new Database(cachePath, { readonly: true, fileMustExist: true });
    const tree = new Database(treePath, { readonly: true, fileMustExist: true });
    let result;
    try {
        result = await checkCache({ cache, tree, store, dirs });
    } finally {
        cache.close();
        tree.close();
        await stores.closeUserStores();
    }

    log(`${LOG_PREFIX} ${result.rows} cached chat(s): ${result.empty} with no metadata, ${result.matched} with every value in the engine, ${result.problems.length} not.`);
    for (const p of result.problems) {
        warn(`${LOG_PREFIX}   ${p.kind.toUpperCase()} ${p.ownerKind} chat path#${p.pathHash.slice(0, 16)}: ${p.keys} value(s), ${p.differing} not there, cache#${p.cacheHash.slice(0, 16)}`);
    }
    if (result.problems.length > 0) {
        const byKind = Object.entries(Object.groupBy(result.problems, p => `${p.kind} ${p.ownerKind}`)).map(([key, list]) => `${key}: ${list?.length}`).join(', ');
        warn(`${LOG_PREFIX} not safe to delete (${byKind}); nothing was deleted.`);
        return 1;
    }
    if (!apply) {
        log(`${LOG_PREFIX} safe to delete. dry run: nothing was deleted.`);
        return 0;
    }
    for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(cachePath + suffix, { force: true });
    log(`${LOG_PREFIX} deleted ${cachePath}.`);
    return 0;
}

/**
 * @param {string[]} argv
 * @returns {{ dataRoot: string, handle: string, config: string, dryRun: boolean, apply: boolean, serverStopped: boolean, unknown: string[] }}
 */
export function parseArgs(argv) {
    const out = { dataRoot: './data', handle: 'default-user', config: './config.yaml', dryRun: false, apply: false, serverStopped: false, unknown: /** @type {string[]} */ ([]) };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--dry-run') out.dryRun = true;
        else if (arg === '--apply') out.apply = true;
        else if (arg === '--server-stopped') out.serverStopped = true;
        else if ((arg === '--data-root' || arg === '--handle' || arg === '--config') && argv[i + 1] !== undefined) {
            out[{ '--data-root': 'dataRoot', '--handle': 'handle', '--config': 'config' }[arg]] = argv[++i];
        } else out.unknown.push(arg);
    }
    return out;
}

/**
 * @param {string[]} argv
 * @param {object} deps
 * @param {any} deps.Database
 * @param {() => any} deps.engine
 * @param {() => Promise<{ running: boolean, lines: string[] }>} [deps.probeServer]
 * @param {(line: string) => void} [deps.log]
 * @param {(line: string) => void} [deps.warn]
 * @returns {Promise<number>}
 */
export async function main(argv, deps) {
    const args = parseArgs(argv);
    const warn = deps.warn ?? console.warn;
    if (args.unknown.length > 0 || args.dryRun === args.apply) {
        warn(`${LOG_PREFIX} usage: --dry-run | --apply, with --server-stopped  [--data-root ./data] [--handle default-user] [--config ./config.yaml]`);
        if (args.unknown.length > 0) warn(`${LOG_PREFIX} unknown argument(s): ${args.unknown.join(' ')}`);
        return 2;
    }
    return runCheck({ ...deps, dataRoot: args.dataRoot, handle: args.handle, apply: args.apply, serverStopped: args.serverStopped });
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    const args = parseArgs(process.argv.slice(2));
    setConfigFilePath(args.config);
    const { getBetterSqlite3 } = await import('../endpoints/native-sqlite.js');
    const Database = await getBetterSqlite3();
    const { loadEngine } = await import('../../engine/load.js');
    const binding = loadEngine().binding;
    process.exitCode = await main(process.argv.slice(2), { Database, engine: () => binding });
}
