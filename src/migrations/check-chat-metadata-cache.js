import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { setConfigFilePath } from '../util.js';
import { USER_DIRECTORY_TEMPLATE } from '../constants.js';
import { normalizeGroupRecord } from '../group-id.js';
import { probeConfiguredServer } from './cleanup-zztest-leftovers.js';

/**
 * Checks that one user's `chat-metadata.sqlite`, a cache of the old `.jsonl` chat files no code reads, holds no
 * value that exists nowhere else, and deletes it only then. A one-off: run once on the existing data, then deleted.
 *
 * The only value in it someone set is a chat's metadata (`chats.chat_metadata_json`). Each row's must equal, as
 * canonical JSON, the metadata of the same chat in message-tree.sqlite: the chat's label row, found by owner and
 * chat name from `file_path` (`chats/<owner>/<name>.jsonl`; `group chats/<name>.jsonl`, the owner being the group
 * whose `chats` lists the name). Compared as the tree stores it: the cache's `main_chat` and `fork_point` are left
 * out (the tree derives them from the messages) and the tree's `__is_group` is left out (the store's own mark).
 * Metadata that is NULL or holds no key holds no value. Everything else in the file is skipped: counts and previews
 * derived from messages, the old files' mtime and size, and the cache's own bookkeeping.
 *
 * Output names no chat and shows no content: each row that doesn't match is listed by owner kind, the sha256 of its
 * file path, its key count and the sha256 of both canonical metadata values.
 *
 * Dry run (read-only opens, writes nothing, may run while the server is running):
 *   node src/migrations/check-chat-metadata-cache.js --dry-run [--data-root ./data] [--handle default-user] [--config ./config.yaml]
 * Real run (the server must be stopped; deletes the file only when every row matches):
 *   node src/migrations/check-chat-metadata-cache.js --apply --server-stopped [--data-root ./data] [--handle default-user] [--config ./config.yaml]
 */

const LOG_PREFIX = '[check-chat-metadata]';
const PAGE_ROWS = 500;

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

/**
 * @param {string | null} json
 * @param {string[]} leftOut Top-level keys not compared.
 * @returns {{ canonical: string, keys: number } | { unparseable: true }}
 */
function canonicalMetadata(json, leftOut) {
    let value;
    try {
        value = json === null ? {} : JSON.parse(json);
    } catch {
        return { unparseable: true };
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { canonical: JSON.stringify(sortKeysDeep(value)), keys: 1 };
    const kept = Object.fromEntries(Object.entries(value).filter(([key]) => !leftOut.includes(key)));
    return { canonical: JSON.stringify(sortKeysDeep(kept)), keys: Object.keys(kept).length };
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
 * @property {number} keys Keys in the cache's metadata.
 * @property {string} cacheHash sha256 of the cache's canonical metadata.
 * @property {string | null} treeHash sha256 of the tree's, null when the chat isn't there.
 */

/**
 * Compares every cache row with the tree.
 * @param {object} options
 * @param {any} options.cache better-sqlite3 connection to chat-metadata.sqlite.
 * @param {any} options.tree better-sqlite3 connection to message-tree.sqlite.
 * @param {{ chats: string, groupChats: string, groups: string }} options.dirs
 * @returns {{ rows: number, empty: number, matched: number, problems: RowProblem[] }}
 */
export function checkCache({ cache, tree, dirs }) {
    const groupOwners = groupChatOwners(dirs.groups);
    const labelRows = tree.prepare('SELECT metadata FROM messages WHERE owner_id = ? AND label = ? LIMIT 2');
    const page = cache.prepare('SELECT rowid AS r, file_path, chat_metadata_json FROM chats WHERE rowid > ? ORDER BY rowid LIMIT ?');
    const result = { rows: 0, empty: 0, matched: 0, problems: /** @type {RowProblem[]} */ ([]) };
    let after = 0;
    for (;;) {
        const rows = [...page.iterate(after, PAGE_ROWS)];
        if (rows.length === 0) break;
        for (const row of rows) {
            result.rows++;
            const filePath = String(row.file_path);
            const cached = canonicalMetadata(row.chat_metadata_json, ['main_chat', 'fork_point']);
            const base = { pathHash: sha256(filePath) };
            if ('unparseable' in cached) {
                result.problems.push({ kind: 'unparseable', ownerKind: 'unknown', ...base, keys: 0, cacheHash: sha256(String(row.chat_metadata_json)), treeHash: null });
                continue;
            }
            if (cached.keys === 0) {
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
            const found = ownerIds.flatMap(ownerId => [...labelRows.iterate(ownerId, chatName)]);
            const problem = { ownerKind, ...base, keys: cached.keys, cacheHash: sha256(cached.canonical) };
            if (found.length !== 1) {
                result.problems.push({ kind: 'missing', ...problem, treeHash: null });
                continue;
            }
            const stored = canonicalMetadata(found[0].metadata ?? null, ['__is_group']);
            const storedCanonical = 'unparseable' in stored ? String(found[0].metadata) : stored.canonical;
            if (storedCanonical === cached.canonical) {
                result.matched++;
            } else {
                result.problems.push({ kind: 'mismatch', ...problem, treeHash: sha256(storedCanonical) });
            }
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
    if (apply) {
        if (!serverStopped) {
            warn(`${LOG_PREFIX} REFUSED: the real run needs --server-stopped (stop the server first; a --port override is not visible to the port probe)`);
            return 1;
        }
        const probe = await probeServer();
        probe.lines.forEach(line => log(`${LOG_PREFIX} ${line}`));
        if (probe.running) {
            warn(`${LOG_PREFIX} REFUSED: the server appears to be running (or the port could not be checked); stop it and rerun`);
            return 1;
        }
    }
    if (!fs.existsSync(cachePath)) {
        log(`${LOG_PREFIX} ${cachePath} does not exist; nothing to do.`);
        return 0;
    }
    if (!fs.existsSync(treePath)) {
        warn(`${LOG_PREFIX} REFUSED: ${treePath} does not exist`);
        return 1;
    }

    const cache = new Database(cachePath, { readonly: true, fileMustExist: true });
    const tree = new Database(treePath, { readonly: true, fileMustExist: true });
    let result;
    try {
        result = checkCache({ cache, tree, dirs });
    } finally {
        cache.close();
        tree.close();
    }

    log(`${LOG_PREFIX} ${result.rows} cached chat(s): ${result.empty} with no metadata, ${result.matched} matching the tree, ${result.problems.length} not.`);
    for (const p of result.problems) {
        warn(`${LOG_PREFIX}   ${p.kind.toUpperCase()} ${p.ownerKind} chat path#${p.pathHash.slice(0, 16)}: ${p.keys} key(s), cache#${p.cacheHash.slice(0, 16)}${p.treeHash ? `, tree#${p.treeHash.slice(0, 16)}` : ''}`);
    }
    if (result.problems.length > 0) {
        const byKind = Object.entries(Object.groupBy(result.problems, p => `${p.kind} ${p.ownerKind}`)).map(([key, list]) => `${key}: ${list?.length}`).join(', ');
        warn(`${LOG_PREFIX} not safe to delete (${byKind}); nothing was deleted.`);
        return 1;
    }
    if (!apply) {
        log(`${LOG_PREFIX} safe to delete. dry run: nothing was written.`);
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
 * @param {() => Promise<{ running: boolean, lines: string[] }>} [deps.probeServer]
 * @param {(line: string) => void} [deps.log]
 * @param {(line: string) => void} [deps.warn]
 * @returns {Promise<number>}
 */
export async function main(argv, deps) {
    const args = parseArgs(argv);
    const warn = deps.warn ?? console.warn;
    if (args.unknown.length > 0 || args.dryRun === args.apply) {
        warn(`${LOG_PREFIX} usage: --dry-run | --apply --server-stopped  [--data-root ./data] [--handle default-user] [--config ./config.yaml]`);
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
    process.exitCode = await main(process.argv.slice(2), { Database });
}
