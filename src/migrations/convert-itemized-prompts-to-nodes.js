import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';

import DiffMatchPatch from 'diff-match-patch';
import sanitize from 'sanitize-filename';

import { setConfigFilePath } from '../util.js';
import { probeConfiguredServer } from './cleanup-zztest-leftovers.js';

/**
 * Moves one user's prompt itemizations from the per-chat files (`<user>/itemized prompts/<chat>.json.zst`, each a
 * list of entries keyed by the message's position in the chat) onto the messages they belong to (the `itemizations`
 * table of message-tree.sqlite, one per message). A one-off: run once on the existing data, then deleted.
 *
 * A file names its chat by the chat's name or a node id, as the page's chat id was when it was saved. Each entry goes
 * to the message at its position in that chat as the chat is now (the chat's name or node, down its current path),
 * which is the message the page showed it for. Not converted, and listed: an entry whose position is past the chat's
 * end, a later entry for a position that already had one (the page showed the first), an entry for a message that
 * already has an itemization, and every entry of a file whose chat can't be found or is named by more than one
 * character or group. A converted file, with whatever of it wasn't converted, is moved to
 * `<user>/backups/_convert-itemized-prompts/<timestamp>/`; backups are never deleted. A file that can't be read is
 * listed and left where it is.
 *
 * Dry run (reads only, writes nothing, may run while the server is running):
 *   node src/migrations/convert-itemized-prompts-to-nodes.js --dry-run [--data-root ./data] [--handle default-user] [--config ./config.yaml]
 * Real run (the server must be stopped):
 *   node src/migrations/convert-itemized-prompts-to-nodes.js --apply --server-stopped [--data-root ./data] [--handle default-user] [--config ./config.yaml]
 */

const LOG_PREFIX = '[convert-itemized-prompts]';
const BACKUP_DIR_NAME = '_convert-itemized-prompts';
const OLD_DIR_NAME = 'itemized prompts';
const FILE_SUFFIX = '.json.zst';
const LOG_MAGIC = Buffer.from('IPL1', 'ascii');

/**
 * The value a per-chat file holds: either format the server wrote (a single zstd frame, or the `IPL1` log of a
 * `full` frame and `append` frames, stopping at the first frame that can't be read, as the server read it).
 * @param {Buffer} buffer
 * @returns {unknown}
 */
export function readStoredValue(buffer) {
    if (buffer.length < LOG_MAGIC.length || !buffer.subarray(0, LOG_MAGIC.length).equals(LOG_MAGIC)) {
        return JSON.parse(zlib.zstdDecompressSync(buffer).toString('utf8'));
    }
    /** @type {any} */
    let data;
    let offset = LOG_MAGIC.length;
    while (offset + 4 <= buffer.length) {
        const length = buffer.readUInt32LE(offset);
        offset += 4;
        if (offset + length > buffer.length) break;
        let record;
        try {
            record = JSON.parse(zlib.zstdDecompressSync(buffer.subarray(offset, offset + length)).toString('utf8'));
        } catch {
            break;
        }
        offset += length;
        if (record?.t === 'full') {
            data = record.data;
        } else if (record?.t === 'append' && data && typeof data === 'object' && Array.isArray(data.entries)) {
            data = {
                ...data,
                pool: [...(Array.isArray(data.pool) ? data.pool : []), ...(Array.isArray(record.pool) ? record.pool : [])],
                entries: [...data.entries, ...(Array.isArray(record.entries) ? record.entries : [])],
            };
        } else {
            break;
        }
    }
    return data;
}

/**
 * @param {any} value
 * @param {string[]} pool
 * @returns {any}
 */
function unpoolize(value, pool) {
    if (Array.isArray(value)) return value.map(item => unpoolize(item, pool));
    if (value && typeof value === 'object') {
        const keys = Object.keys(value);
        if (keys.length === 1 && keys[0] === '$r' && typeof value.$r === 'number') return pool[value.$r];
        return Object.fromEntries(keys.map(key => [key, unpoolize(value[key], pool)]));
    }
    return value;
}

/**
 * The entries a stored value holds, in each format the page wrote: a plain list, the pooled form, and the older
 * form with each raw prompt stored as a delta from the one before.
 * @param {unknown} stored
 * @returns {Record<string, any>[] | null} null when the value is in none of them.
 */
export function decodeEntries(stored) {
    if (Array.isArray(stored)) return stored;
    const value = /** @type {any} */ (stored);
    if (!value || typeof value !== 'object' || !Array.isArray(value.entries)) return null;
    if (Array.isArray(value.pool)) return value.entries.map((/** @type {any} */ entry) => unpoolize(entry, value.pool));
    if (Array.isArray(value.rawPromptDelta)) {
        const dmp = new DiffMatchPatch();
        dmp.Diff_Timeout = 2.0;
        /** @type {string|undefined} */
        let previousRawPrompt;
        return value.entries.map((/** @type {any} */ entry, /** @type {number} */ i) => {
            const delta = value.rawPromptDelta[i];
            if (typeof delta === 'string' && typeof previousRawPrompt === 'string') {
                entry.rawPrompt = dmp.diff_text2(dmp.diff_fromDelta(previousRawPrompt, delta));
            }
            if (typeof entry.rawPrompt === 'string') previousRawPrompt = entry.rawPrompt;
            const fields = value.dedup?.[i];
            if (Array.isArray(fields) && typeof entry.rawPrompt === 'string') {
                for (const field of fields) entry[field] = entry.rawPrompt;
            }
            return entry;
        });
    }
    return null;
}

/**
 * @typedef {object} FilePlan
 * @property {string} file
 * @property {{ nodeId: string, mesId: number, entry: Record<string, any> }[]} convert
 * @property {{ mesId: unknown, reason: string }[]} left Entries not converted, and why.
 */

/**
 * @typedef {object} Tree The message-tree-db.js helpers a plan resolves chats with, as `/api/chats/open` does.
 * @property {Function} resolveNodeOrName
 * @property {Function} descendDefaultSync
 * @property {Function} getPathSync
 */

/**
 * The per-chat files of a user, in name order.
 * @param {string} oldDir
 * @returns {string[]}
 */
export function listOldFiles(oldDir) {
    if (!fs.existsSync(oldDir)) return [];
    return fs.readdirSync(oldDir, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith(FILE_SUFFIX))
        .map(entry => entry.name)
        .sort();
}

/**
 * The chats a file can name by a chat name, by the file name the server made of that name (`sanitize(chatId)`).
 * @param {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @returns {Map<string, { ownerId: string, label: string }[]>}
 */
export function chatNamesByFileName(db) {
    /** @type {Map<string, { ownerId: string, label: string }[]>} */
    const out = new Map();
    for (const row of /** @type {Iterable<{ owner_id: string, label: string }>} */ (db.iterate(
        'SELECT DISTINCT owner_id, label FROM messages WHERE label IS NOT NULL'))) {
        const key = sanitize(row.label);
        if (!out.has(key)) out.set(key, []);
        /** @type {{ ownerId: string, label: string }[]} */ (out.get(key)).push({ ownerId: row.owner_id, label: row.label });
    }
    return out;
}

/**
 * Works out what converting one file does.
 * @param {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} oldDir
 * @param {string} file
 * @param {Map<string, { ownerId: string, label: string }[]>} byFileName {@link chatNamesByFileName}
 * @param {Tree} tree
 * @returns {FilePlan | { file: string, unreadable: string }}
 */
export function planFile(db, oldDir, file, byFileName, tree) {
    /** @type {Record<string, any>[] | null} */
    let entries;
    try {
        entries = decodeEntries(readStoredValue(fs.readFileSync(path.join(oldDir, file))));
    } catch (err) {
        return { file, unreadable: /** @type {Error} */ (err).message };
    }
    if (!entries) return { file, unreadable: 'it holds no list of entries' };

    /** @type {FilePlan} */
    const plan = { file, convert: [], left: [] };
    const leaveAll = (/** @type {string} */ reason) => {
        for (const entry of entries ?? []) plan.left.push({ mesId: entry?.mesId, reason });
        return plan;
    };

    const chatId = file.slice(0, -FILE_SUFFIX.length);
    const asNode = /** @type {{ owner_id: string } | undefined} */ (db.get(
        'SELECT owner_id FROM messages WHERE id = @id AND parent_id IS NOT NULL', { id: chatId }));
    const candidates = asNode ? [{ ownerId: asNode.owner_id, label: chatId }] : (byFileName.get(chatId) ?? []);
    if (candidates.length === 0) return leaveAll('no chat has this name or id now');
    if (new Set(candidates.map(c => c.ownerId)).size > 1) return leaveAll('more than one character or group has a chat by this name');
    if (new Set(candidates.map(c => c.label)).size > 1) return leaveAll('more than one chat has a name this file name stands for');

    const node = tree.resolveNodeOrName(db, candidates[0].ownerId, candidates[0].label);
    if (!node) return leaveAll('no chat has this name or id now');
    const ids = /** @type {{ id: string, parent_id: string | null }[]} */ (tree.getPathSync(db, tree.descendDefaultSync(db, node.id)))
        .filter(row => row.parent_id !== null)
        .map(row => row.id);
    const hasTable = Boolean(db.get('SELECT 1 AS ok FROM sqlite_master WHERE type = \'table\' AND name = \'itemizations\''));

    /** @type {Set<string>} */
    const taken = new Set();
    for (const entry of entries) {
        const mesId = Number(entry?.mesId);
        if (!entry || typeof entry !== 'object' || !Number.isInteger(mesId) || mesId < 0) {
            plan.left.push({ mesId: entry?.mesId, reason: 'it names no message position' });
            continue;
        }
        if (mesId >= ids.length) {
            plan.left.push({ mesId, reason: `the chat has ${ids.length} messages now` });
            continue;
        }
        const nodeId = ids[mesId];
        if (taken.has(nodeId)) {
            plan.left.push({ mesId, reason: 'an earlier entry for this message was the one shown' });
            continue;
        }
        taken.add(nodeId);
        if (hasTable && db.get('SELECT 1 AS ok FROM itemizations WHERE node_id = @nodeId', { nodeId })) {
            plan.left.push({ mesId, reason: 'the message already has an itemization' });
            continue;
        }
        const stored = { ...entry };
        delete stored.mesId;
        plan.convert.push({ nodeId, mesId, entry: stored });
    }
    return plan;
}

/**
 * @param {object} options
 * @param {string} options.dataRoot
 * @param {string} options.handle
 * @param {boolean} options.apply
 * @param {boolean} options.serverStopped
 * @param {() => Promise<{ running: boolean, lines: string[] }>} [options.probeServer]
 * @param {(line: string) => void} [options.log]
 * @param {(line: string) => void} [options.warn]
 * @param {Date} [options.now]
 * @returns {Promise<number>} Process exit code: 0 everything converted (or nothing to do), 1 refused, or something
 * was left unconverted or unread.
 */
export async function runConversion(options) {
    const { dataRoot, handle, apply, serverStopped } = options;
    const log = options.log ?? console.log;
    const warn = options.warn ?? console.warn;
    const probeServer = options.probeServer ?? probeConfiguredServer;
    const root = path.join(dataRoot, handle);
    const oldDir = path.join(root, OLD_DIR_NAME);
    const dbPath = path.join(root, 'message-tree.sqlite');

    log(`${LOG_PREFIX} ${apply ? 'real run' : 'dry run'} for ${oldDir}`);
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
    const files = listOldFiles(oldDir);
    if (files.length === 0) {
        log(`${LOG_PREFIX} no per-chat itemization files; nothing to convert.`);
        return 0;
    }
    if (!fs.existsSync(dbPath)) {
        warn(`${LOG_PREFIX} REFUSED: ${dbPath} doesn't exist, so no chat can be found for any file`);
        return 1;
    }

    const tree = await import('../message-tree-db.js');
    const { getSqliteEngine } = await import('../endpoints/sqlite-engine.js');
    const { recordItemization } = await import('../itemization-store.js');
    const engine = await getSqliteEngine();
    if (!engine) {
        warn(`${LOG_PREFIX} REFUSED: no SQLite engine is usable`);
        return 1;
    }
    const directories = /** @type {import('../message-tree-db.js').Directories} */ ({ root });
    const db = apply ? await tree.getMessageTreeDb(directories) : engine.openDatabase(dbPath, { readonly: true });
    if (!db) {
        warn(`${LOG_PREFIX} REFUSED: ${dbPath} couldn't be opened`);
        return 1;
    }

    let backupDir = '';
    if (apply) {
        const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
        backupDir = path.join(root, 'backups', BACKUP_DIR_NAME, stamp);
        fs.mkdirSync(backupDir, { recursive: true });
        log(`${LOG_PREFIX} converted files are moved to ${backupDir}`);
    }

    let converted = 0;
    let left = 0;
    let unreadable = 0;
    let failed = 0;
    try {
        const byFileName = chatNamesByFileName(db);
        for (const file of files) {
            const plan = planFile(db, oldDir, file, byFileName, tree);
            if ('unreadable' in plan) {
                unreadable++;
                warn(`${LOG_PREFIX}   LEFT AS IT IS ${file}: ${plan.unreadable}`);
                continue;
            }
            left += plan.left.length;
            for (const { mesId, reason } of plan.left) warn(`${LOG_PREFIX}   NOT CONVERTED ${file} message ${String(mesId)}: ${reason}`);
            if (!apply) {
                converted += plan.convert.length;
                log(`${LOG_PREFIX}   WOULD CONVERT ${file}: ${plan.convert.length} entr(ies)`);
                continue;
            }
            try {
                for (const { nodeId, entry } of plan.convert) {
                    if (await recordItemization(directories, nodeId, entry) === 'no-message') throw new Error(`message ${nodeId} is gone`);
                }
                fs.renameSync(path.join(oldDir, file), path.join(backupDir, file));
                converted += plan.convert.length;
                log(`${LOG_PREFIX}   CONVERTED ${file}: ${plan.convert.length} entr(ies)`);
            } catch (err) {
                failed++;
                warn(`${LOG_PREFIX}   FAILED ${file} (left where it is): ${/** @type {Error} */ (err).message}`);
            }
        }
    } finally {
        if (apply) tree.disposeMessageTreeStores();
        else db.close();
    }

    log(`${LOG_PREFIX} ${apply ? 'converted' : 'would convert'} ${converted} entr(ies) from ${files.length - unreadable - failed} file(s); ${left} entr(ies) not converted; ${unreadable} file(s) unreadable${apply ? `; ${failed} file(s) failed` : ''}.`);
    if (apply && fs.readdirSync(oldDir).length === 0) fs.rmdirSync(oldDir);
    if (!apply) log(`${LOG_PREFIX} dry run: nothing was written.`);
    return failed > 0 || left > 0 || unreadable > 0 ? 1 : 0;
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
 * @param {object} [deps]
 * @param {() => Promise<{ running: boolean, lines: string[] }>} [deps.probeServer]
 * @param {(line: string) => void} [deps.log]
 * @param {(line: string) => void} [deps.warn]
 * @param {Date} [deps.now]
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
    const args = parseArgs(argv);
    const warn = deps.warn ?? console.warn;
    if (args.unknown.length > 0 || args.dryRun === args.apply) {
        warn(`${LOG_PREFIX} usage: --dry-run | --apply --server-stopped  [--data-root ./data] [--handle default-user] [--config ./config.yaml]`);
        if (args.unknown.length > 0) warn(`${LOG_PREFIX} unknown argument(s): ${args.unknown.join(' ')}`);
        return 2;
    }
    return runConversion({ ...deps, dataRoot: args.dataRoot, handle: args.handle, apply: args.apply, serverStopped: args.serverStopped });
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    const args = parseArgs(process.argv.slice(2));
    setConfigFilePath(args.config);
    process.exitCode = await main(process.argv.slice(2));
}
