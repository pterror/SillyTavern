import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { setConfigFilePath } from '../util.js';
import { tagEntityTypeOf } from '../group-id.js';

/**
 * Checks that everything in one user's `tags.json.migrated` (our old tags file, renamed once its contents were moved
 * into the character store) is in the store, or was one of the drops that move logged. Reads only, never deletes;
 * may run while the server is running. A one-off: run once, then deleted.
 *
 * - A tag (`tags[]`, by id) is in the store when `tags` has a row with its id (a tag marked deleted since keeps it).
 * - A `tag_map` entry (key, tag id) for a key naming no character (`.png`) or group row was dropped by the move,
 *   with a warning. For a key naming one, it is in the store when the entity's tag row is there, or the tag is marked
 *   deleted with a merge target and the entity has the target's row. A key whose value isn't a list held no tags
 *   (the move warned and imported nothing for it).
 *
 * Output names nothing: counts, and the sha256 of each missing item.
 *
 *   node src/migrations/check-tags-json-migrated.js [--data-root ./data] [--handle default-user] [--config ./config.yaml]
 */

const LOG_PREFIX = '[check-tags-json]';
const BATCH = 500;

/** @param {string} text */
function hash(text) {
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * @param {any} db better-sqlite3 connection to character-metadata.sqlite.
 * @param {{ tags?: unknown, tag_map?: unknown }} file tags.json.migrated, parsed.
 * @returns {{ tags: { total: number, present: number, missing: string[] }, entries: { total: number, present: number, merged: number, droppedKeys: number, droppedEntries: number, notLists: number, missing: string[] } }}
 *   missing: hashes (of the tag id; of `key \0 tag id`).
 */
export function checkTagsFile(db, file) {
    const has = (/** @type {string} */ sql, /** @type {unknown[]} */ params) => !!db.prepare(sql).get(...params);
    const result = {
        tags: { total: 0, present: 0, missing: /** @type {string[]} */ ([]) },
        entries: { total: 0, present: 0, merged: 0, droppedKeys: 0, droppedEntries: 0, notLists: 0, missing: /** @type {string[]} */ ([]) },
    };

    const tags = Array.isArray(file.tags) ? file.tags : [];
    for (const tag of tags) {
        const id = tag && typeof tag === 'object' ? /** @type {{ id?: unknown }} */ (tag).id : undefined;
        if (typeof id !== 'string' || !id) continue;
        result.tags.total++;
        if (has('SELECT 1 FROM tags WHERE id = ?', [id])) result.tags.present++;
        else result.tags.missing.push(hash(id));
    }

    const tagMap = file.tag_map && typeof file.tag_map === 'object' ? /** @type {Record<string, unknown>} */ (file.tag_map) : {};
    const keys = Object.keys(tagMap);
    for (let i = 0; i < keys.length; i += BATCH) {
        for (const key of keys.slice(i, i + BATCH)) {
            const value = tagMap[key];
            if (!Array.isArray(value)) {
                result.entries.notLists++;
                continue;
            }
            const tagIds = [...new Set(value.filter(t => typeof t === 'string'))];
            result.entries.total += tagIds.length;
            const type = tagEntityTypeOf(key);
            const table = type === 'character' ? 'characters' : type === 'group' ? 'groups' : null;
            if (table === null || !has(`SELECT 1 FROM ${table} WHERE id = ?`, [key])) {
                result.entries.droppedKeys++;
                result.entries.droppedEntries += tagIds.length;
                continue;
            }
            const [tagTable, column] = type === 'character' ? ['character_tags', 'character_id'] : ['group_tags', 'group_id'];
            for (const tagId of tagIds) {
                if (has(`SELECT 1 FROM ${tagTable} WHERE ${column} = ? AND tag_id = ?`, [key, tagId])) {
                    result.entries.present++;
                    continue;
                }
                let target = tagId;
                for (let hops = 0; hops < 100; hops++) {
                    const mark = db.prepare('SELECT merge_into FROM tag_deletions WHERE tag_id = ?').get(target);
                    if (!mark || typeof mark.merge_into !== 'string') break;
                    target = mark.merge_into;
                }
                if (target !== tagId && has(`SELECT 1 FROM ${tagTable} WHERE ${column} = ? AND tag_id = ?`, [key, target])) result.entries.merged++;
                else result.entries.missing.push(hash(`${key}\0${tagId}`));
            }
        }
    }
    return result;
}

/**
 * @param {object} options
 * @param {string} options.dataRoot
 * @param {string} options.handle
 * @param {any} options.Database better-sqlite3 constructor, or null when the native binding isn't usable.
 * @param {(line: string) => void} [options.log]
 * @param {(line: string) => void} [options.warn]
 * @returns {Promise<number>} Process exit code: 0 everything accounted for (or no file), 1 something missing or refused.
 */
export async function runCheck(options) {
    const { dataRoot, handle, Database } = options;
    const log = options.log ?? console.log;
    const warn = options.warn ?? console.warn;
    const root = path.join(dataRoot, handle);
    const filePath = path.join(root, 'tags.json.migrated');
    const dbPath = path.join(root, 'character-metadata.sqlite');

    log(`${LOG_PREFIX} ${filePath}`);
    if (!Database) {
        warn(`${LOG_PREFIX} REFUSED: native better-sqlite3 is not available; this script never opens these databases with the wasm engine`);
        return 1;
    }
    if (!fs.existsSync(filePath)) {
        log(`${LOG_PREFIX} no tags.json.migrated; nothing to check.`);
        return 0;
    }
    if (!fs.existsSync(dbPath)) {
        warn(`${LOG_PREFIX} REFUSED: ${dbPath} does not exist`);
        return 1;
    }
    let file;
    try {
        file = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        warn(`${LOG_PREFIX} REFUSED: tags.json.migrated can't be parsed: ${/** @type {Error} */ (err).message}`);
        return 1;
    }

    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    let result;
    try {
        result = checkTagsFile(db, file ?? {});
    } finally {
        db.close();
    }

    const { tags, entries } = result;
    log(`${LOG_PREFIX} tags: ${tags.total}, in the store ${tags.present}, missing ${tags.missing.length}.`);
    log(`${LOG_PREFIX} tag_map entries: ${entries.total}, in the store ${entries.present}, under a merge target ${entries.merged}, dropped with their key (no such character or group, logged) ${entries.droppedEntries} in ${entries.droppedKeys} key(s), missing ${entries.missing.length}; keys whose value isn't a list (held no tags, logged): ${entries.notLists}.`);
    for (const h of tags.missing) warn(`${LOG_PREFIX}   MISSING tag #${h}`);
    for (const h of entries.missing) warn(`${LOG_PREFIX}   MISSING tag_map entry #${h}`);
    const missing = tags.missing.length + entries.missing.length;
    log(`${LOG_PREFIX} ${missing === 0 ? 'everything in it is in the store or was a logged drop.' : `${missing} item(s) are in neither.`} Nothing was written.`);
    return missing === 0 ? 0 : 1;
}

/**
 * @param {string[]} argv
 * @returns {{ dataRoot: string, handle: string, config: string, unknown: string[] }}
 */
export function parseArgs(argv) {
    const out = { dataRoot: './data', handle: 'default-user', config: './config.yaml', unknown: /** @type {string[]} */ ([]) };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if ((arg === '--data-root' || arg === '--handle' || arg === '--config') && argv[i + 1] !== undefined) {
            out[{ '--data-root': 'dataRoot', '--handle': 'handle', '--config': 'config' }[arg]] = argv[++i];
        } else out.unknown.push(arg);
    }
    return out;
}

/**
 * @param {string[]} argv
 * @param {object} deps
 * @param {any} deps.Database
 * @param {(line: string) => void} [deps.log]
 * @param {(line: string) => void} [deps.warn]
 * @returns {Promise<number>}
 */
export async function main(argv, deps) {
    const args = parseArgs(argv);
    const warn = deps.warn ?? console.warn;
    if (args.unknown.length > 0) {
        warn(`${LOG_PREFIX} usage: [--data-root ./data] [--handle default-user] [--config ./config.yaml]`);
        warn(`${LOG_PREFIX} unknown argument(s): ${args.unknown.join(' ')}`);
        return 2;
    }
    return runCheck({ ...deps, dataRoot: args.dataRoot, handle: args.handle });
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    const args = parseArgs(process.argv.slice(2));
    setConfigFilePath(args.config);
    const { getBetterSqlite3 } = await import('../endpoints/native-sqlite.js');
    const Database = await getBetterSqlite3();
    process.exitCode = await main(process.argv.slice(2), { Database });
}
