import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import DiffMatchPatch from 'diff-match-patch';
import sanitize from 'sanitize-filename';

import { openNativeDatabase } from '../../endpoints/sqlite-engine.js';
import { openReadOnly } from './old-library.js';
import { alternativesFromMessage, descendDefaultSync, getPathSync, identityHashOf, resolveNodeOrName } from '../../message-tree-db.js';
import { createMessageStatsTableSync } from '../../message-stats.js';
import { isChatHeaderEntry } from '../../chat-header.js';
import { applyChatRestore, planChatRestore, restoreGroupChatLosses } from '../restore-group-chat-migration-losses.js';
import { STRAY_OWNER, planRepoint, planStrayOwner, GROUP_ID as ZZTEST_GROUP_ID, GROUP_CHAT as ZZTEST_GROUP_CHAT, STRAY_GROUP_CHAT, IVY_OPENING_ID, GROUP_ANCHOR_ID } from '../cleanup-zztest-leftovers.js';

/**
 * Reads the chats as today's server reads them from `message-tree.sqlite` (never writing it), with the group chat
 * repair and the zztest cleanup applied to what is read, and the old per-chat prompt itemization files.
 */

/**
 * @typedef {import('../../endpoints/sqlite-engine.js').SqliteEngineHandle} Db
 * @typedef {object} Row
 * @property {string} id
 * @property {string | null} parent
 * @property {string | null} label
 * @property {number} created
 * @property {string | null} dflt Its default child.
 * @property {boolean} meta It holds chat metadata.
 */

/**
 * @param {any} Database
 * @param {string} file
 */
export function openTree(Database, file) {
    return openReadOnly(Database, file);
}

/**
 * A copy in memory of the group owners' rows and of `characterIds`' rows, with the group chat repair
 * (`restore-group-chat-migration-losses.js`) applied to it as that script applies it: the old file is only read.
 * @param {any} Database
 * @param {Db} tree
 * @param {{ root: string, groups: string, groupChats: string, backups: string }} dirs
 * @param {string[]} groupIds
 * @param {string[]} [characterIds] Characters' owner ids whose chat files `importChatFile()` writes into the copy.
 * @returns {Promise<{ db: Db, result: import('../restore-group-chat-migration-losses.js').RestoreResult }>}
 */
export async function groupOverlay(Database, tree, dirs, groupIds, characterIds = []) {
    const ownerList = [...groupIds, ...characterIds];
    const db = openNativeDatabase(Database, ':memory:');
    const schema = /** @type {{ type: string, sql: string }[]} */ (tree.readBounded(
        'SELECT type, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid', [], 100000));
    for (const e of schema) if (e.type === 'table') db.exec(e.sql);
    // Rows come in id order, not parents first.
    db.exec('PRAGMA foreign_keys = OFF');
    for (const table of ['messages', 'owners']) {
        if (!tree.get('SELECT 1 AS ok FROM sqlite_master WHERE type = \'table\' AND name = ?', [table])) continue;
        const cols = /** @type {{ name: string }[]} */ (tree.readBounded(`PRAGMA table_info("${table}")`, [], 1000)).map(c => c.name);
        const insert = `INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
        db.transaction(() => {
            for (const row of /** @type {Iterable<Record<string, unknown>>} */ (tree.iterate(
                `SELECT ${cols.map(c => `"${c}"`).join(', ')} FROM "${table}" WHERE owner_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(ownerList)]))) {
                db.run(insert, cols.map(c => row[c]));
            }
        });
    }
    // What hangs off the copied messages by their id.
    for (const table of ['send_keys', 'itemizations']) {
        if (!tree.get('SELECT 1 AS ok FROM sqlite_master WHERE type = \'table\' AND name = ?', [table])) continue;
        const cols = /** @type {{ name: string }[]} */ (tree.readBounded(`PRAGMA table_info("${table}")`, [], 1000)).map(c => c.name);
        const insert = `INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
        db.transaction(() => {
            for (const row of /** @type {Iterable<Record<string, unknown>>} */ (tree.iterate(
                `SELECT ${cols.map(c => `t."${c}"`).join(', ')} FROM "${table}" t JOIN messages m ON m.id = t.node_id WHERE m.owner_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(ownerList)]))) {
                db.run(insert, cols.map(c => row[c]));
            }
        });
    }
    db.exec('PRAGMA foreign_keys = ON');
    // Today's store has no triggers: the old file's (the message stats triggers) call functions nothing registers.
    for (const e of schema) if (e.type === 'index') db.exec(e.sql);
    createMessageStatsTableSync(db);
    const result = await restoreGroupChatLosses(dirs, { reader: db, apply: true, pauseMs: 0, queueChatStats: null });
    return { db, result };
}

/**
 * A chat file's header and its messages: the lines from the start that each hold a JSON object, up to the first that
 * doesn't. Blank lines are skipped.
 * @param {string} raw
 * @returns {{ header: Record<string, any> | null, messages: Record<string, any>[], stopsAt: number | null, rest: number }}
 * `stopsAt`: the line number of the first line not read; `rest`: the non-blank lines from there on, none read.
 */
export function readChatRun(raw) {
    const lines = raw.split('\n');
    /** @type {Record<string, any>[]} */
    const entries = [];
    let stopsAt = null;
    let rest = 0;
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        if (stopsAt !== null) {
            rest++;
            continue;
        }
        let entry;
        try {
            entry = JSON.parse(lines[i]);
        } catch {
            entry = null;
        }
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            stopsAt = i + 1;
            rest++;
            continue;
        }
        entries.push(entry);
    }
    const header = entries.length > 0 && isChatHeaderEntry(entries[0]) ? entries[0] : null;
    return { header, messages: header ? entries.slice(1) : entries, stopsAt, rest };
}

/**
 * Follows a chat's messages down an owner's tree from its first anchor, each to the reply holding its shown text,
 * else the text of its shown swipe (a greeting whose `mes` has its macros filled in where the tree holds them as
 * written).
 * @param {Db} db
 * @param {string} ownerId
 * @param {Record<string, any>[]} messages
 * @returns {{ end: string | null, bySwipe: number }} `end`: the message the last one is, null when one isn't there;
 * `bySwipe`: how many were found by their shown swipe's text.
 */
export function walkChat(db, ownerId, messages) {
    const anchor = /** @type {{ id: string } | undefined} */ (db.get('SELECT id FROM messages WHERE owner_id = ? AND parent_id IS NULL ORDER BY created_at ASC, id ASC LIMIT 1', [ownerId]));
    let at = anchor?.id ?? null;
    let bySwipe = 0;
    const replyOf = (/** @type {string} */ parent, /** @type {string} */ content) => /** @type {{ id: string } | undefined} */ (db.get('SELECT id FROM messages WHERE parent_id = ? AND identity_hash = ?', [parent, identityHashOf(parent, content)]))?.id ?? null;
    for (const message of messages) {
        if (at === null) break;
        const alts = alternativesFromMessage(/** @type {any} */ (message));
        let next = replyOf(at, alts.contents[alts.selected]);
        const swipe = Array.isArray(message.swipes) && Number.isInteger(message.swipe_id) ? message.swipes[message.swipe_id] : undefined;
        if (next === null && typeof swipe === 'string' && swipe !== message.mes) {
            const shown = alternativesFromMessage(/** @type {any} */ ({ ...message, mes: swipe }));
            next = replyOf(at, shown.contents[shown.selected]);
            if (next !== null) bySwipe++;
        }
        at = next;
    }
    return { end: at, bySwipe };
}

/**
 * A character's chat files (`chats/<owner>/<name>.jsonl.pre-migration`) that no label of that owner in the tree
 * names (as the label, or as its file name).
 * @param {Db} tree
 * @param {string} chatsDir
 * @returns {{ ownerId: string, name: string, file: string }[]}
 */
export function unlabeledChatFiles(tree, chatsDir) {
    const suffix = '.jsonl.pre-migration';
    const out = [];
    if (!fs.existsSync(chatsDir)) return out;
    for (const dir of fs.readdirSync(chatsDir, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const ownerId = dir.name;
        /** @type {Set<string> | null} */
        let fileNames = null;
        for (const f of fs.readdirSync(path.join(chatsDir, ownerId)).sort()) {
            if (!f.endsWith(suffix)) continue;
            const name = f.slice(0, -suffix.length);
            if (tree.get('SELECT 1 AS ok FROM messages WHERE owner_id = ? AND label = ? LIMIT 1', [ownerId, name])) continue;
            fileNames ??= new Set([...tree.iterate('SELECT DISTINCT label FROM messages WHERE owner_id = ? AND label IS NOT NULL', [ownerId])].map(r => sanitize(String(r.label))));
            if (fileNames.has(name)) continue;
            out.push({ ownerId, name, file: path.join(chatsDir, ownerId, f) });
        }
    }
    return out;
}

/**
 * Writes a character's chat read from its file into an owner's rows as the group chat repair writes a chat it
 * restores whole: each message with all its alternatives under the one before it from the anchor (a reply already
 * holding one's text is that one), the last labelled with the chat's name and holding its metadata.
 * @param {Db} db The overlay holding the owner's rows.
 * @param {{ ownerId: string, avatar: string, name: string, file: string, header: Record<string, any> | null, messages: Record<string, any>[] }} chat
 * Its messages at least one.
 * @param {number} now
 * @returns {{ written: true } | { reason: string }}
 */
export function importChatFile(db, chat, now) {
    const input = {
        ownerId: chat.ownerId, chatId: chat.name, messages: chat.messages, backupPath: chat.file,
        backupMetadata: chat.header?.chat_metadata ?? null, character: /** @type {const} */ ({ kind: 'character', rowId: chat.avatar }),
    };
    /** @type {{ plan?: import('../restore-group-chat-migration-losses.js').ChatRestorePlan }} */
    const out = {};
    db.transaction(() => {
        out.plan = planChatRestore(db, input);
        if (out.plan.status === 'restore') applyChatRestore(db, out.plan, input, now);
    });
    const plan = /** @type {import('../restore-group-chat-migration-losses.js').ChatRestorePlan} */ (out.plan);
    return plan.status === 'restore' ? { written: true } : { reason: 'reason' in plan ? plan.reason : 'it is in the tree already' };
}

/**
 * Every owner id the tree holds rows for, in id order.
 * @param {Db} tree
 * @returns {string[]}
 */
export function ownerIds(tree) {
    return /** @type {{ owner_id: string }[]} */ (tree.readBounded('SELECT DISTINCT owner_id FROM messages ORDER BY owner_id', [], 100_000_000)).map(r => r.owner_id);
}

/** Compares two ids as SQLite's BINARY collation does (UTF-8 bytes). */
const byBytes = (/** @type {string} */ a, /** @type {string} */ b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/**
 * An owner's rows without their contents, in (created_at, id) order, and the order they can be stored in: parents
 * first, each one's replies in (created_at, id) order. Rows no anchor reaches (a parent missing, in another owner, or
 * a cycle) are listed in `unreachable`.
 * @param {Db} db
 * @param {string} ownerId
 */
export function loadOwner(db, ownerId) {
    /** @type {Map<string, Row>} */
    const rows = new Map();
    for (const r of /** @type {Iterable<any>} */ (db.iterate(
        'SELECT id, parent_id, label, created_at, default_child_id, metadata IS NOT NULL AS meta FROM messages WHERE owner_id = ?', [ownerId]))) {
        rows.set(r.id, { id: r.id, parent: r.parent_id, label: r.label, created: Number(r.created_at), dflt: r.default_child_id, meta: !!r.meta });
    }
    const sorted = [...rows.values()].sort((a, b) => (a.created - b.created) || byBytes(a.id, b.id));
    /** @type {Map<string | null, Row[]>} */
    const children = new Map();
    for (const r of sorted) {
        const p = r.parent;
        if (p !== null && !rows.has(p)) continue;
        if (!children.has(p)) children.set(p, []);
        /** @type {Row[]} */ (children.get(p)).push(r);
    }
    const anchors = children.get(null) ?? [];
    /** @type {Row[]} */
    const order = [];
    /** @type {Row[]} */
    let level = anchors;
    while (level.length) {
        /** @type {Row[]} */
        const next = [];
        for (const r of level) {
            order.push(r);
            for (const c of children.get(r.id) ?? []) next.push(c);
        }
        level = next;
    }
    const reached = new Set(order.map(r => r.id));
    const unreachable = sorted.filter(r => !reached.has(r.id)).map(r => r.id);
    return { rows, sorted, children, anchors, order, unreachable };
}

/**
 * The contents and metadata of rows, read a batch at a time.
 * @param {Db} db
 * @param {string[]} ids
 * @returns {Map<string, { content: string, metadata: string | null }>}
 */
export function contentsOf(db, ids) {
    /** @type {Map<string, { content: string, metadata: string | null }>} */
    const out = new Map();
    for (let i = 0; i < ids.length; i += 500) {
        for (const r of /** @type {Iterable<any>} */ (db.iterate(
            'SELECT id, content, metadata FROM messages WHERE id IN (SELECT value FROM json_each(?))', [JSON.stringify(ids.slice(i, i + 500))]))) {
            out.set(r.id, { content: r.content, metadata: r.metadata });
        }
    }
    return out;
}

/**
 * The chat a name or node id opens in an owner's tree, as `/api/chats/open` resolves it, and the message it opens at:
 * down its default children.
 * @param {Db} db
 * @param {string} ownerId
 * @param {string} target
 * @returns {{ node: string, end: string } | null}
 */
export function opens(db, ownerId, target) {
    const node = resolveNodeOrName(db, ownerId, target);
    if (!node) return null;
    return { node: node.id, end: descendDefaultSync(db, node.id) };
}

/**
 * The node ids from an anchor down to `leaf` (the anchor left out).
 * @param {Db} db
 * @param {string} leaf
 * @returns {string[]}
 */
export function pathTo(db, leaf) {
    return /** @type {{ id: string, parent_id: string | null }[]} */ (getPathSync(db, leaf)).filter(r => r.parent_id !== null).map(r => r.id);
}

/**
 * The zztest cleanup's three records, planned as `cleanup-zztest-leftovers.js` plans them against today's data.
 * @param {Db} tree
 * @param {{ characterFileExists: boolean, characterRowExists: boolean }} character `zztestchar`'s.
 * @param {Record<string, any> | undefined} group Group `1740062933703`'s file.
 */
export function zztestPlans(tree, character, group) {
    const reader = {
        get: (/** @type {string} */ sql, /** @type {any} */ p) => tree.get(sql, p ?? {}),
        rows: (/** @type {string} */ sql, /** @type {any} */ p) => tree.readBounded(sql, p ?? {}, 1000),
    };
    const repoint = planRepoint(/** @type {any} */ (reader));
    const stray = planStrayOwner(/** @type {any} */ (reader), character);
    const chats = JSON.stringify(group?.chats);
    const strayChat = chats === JSON.stringify([ZZTEST_GROUP_CHAT, STRAY_GROUP_CHAT]);
    return { repoint, stray, strayChat };
}
export { STRAY_OWNER, ZZTEST_GROUP_ID, STRAY_GROUP_CHAT, IVY_OPENING_ID, GROUP_ANCHOR_ID };

// ---- prompt itemizations from before they were kept per message ----

const ITEMIZED_SUFFIX = '.json.zst';
const LOG_MAGIC = Buffer.from('IPL1', 'ascii');

/**
 * The value a per-chat file holds: one zstd frame, or the `IPL1` log of a `full` frame and `append` frames, stopping
 * at the first frame that can't be read.
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
 * The entries a stored value holds: a plain list, the pooled form, or the older form with each raw prompt stored as
 * a delta from the one before.
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
        /** @type {string | undefined} */
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
 * @typedef {object} ItemizedFilePlan
 * @property {string} file
 * @property {string | null} ownerId
 * @property {{ nodeId: string, mesId: number }[]} convert
 * @property {{ mesId: unknown, reason: string }[]} left Entries not converted, and why.
 * @property {string} [kept] Why none of its entries are converted (a `KEPT` reason): the file is kept as it is.
 * @property {number} entries How many entries it holds.
 * @property {string} [unreadable]
 */

/** Why an itemization file's entries are kept in it rather than converted. */
export const KEPT = Object.freeze({
    noChat: 'no chat has this name or id now',
    ownerShared: 'more than one character or group has a chat by this name',
    nameShared: 'more than one chat has a name this file name stands for',
    pastEnd: 'some of its entries are past the end of its chat, so it may have been saved under another chat\'s name',
    conflict: 'another file has a different itemization for a message it names',
});

/**
 * What converting each per-chat itemization file does (the rules of the deleted
 * `convert-itemized-prompts-to-nodes.js`): each entry to the message at its position down its chat's current path;
 * not converted, and listed: a later entry for a position that already had one and an entry for a message that has
 * an itemization row. A file whose chat can't be found or is named by more than one character or group, or with an
 * entry past its chat's end, is kept (`kept`): none of its entries are converted.
 * @param {Db} tree
 * @param {(ownerId: string) => Db} dbOf The tree an owner is read from (a repaired group's copy, else the file).
 * @param {string} dir `<user>/itemized prompts`.
 * @returns {ItemizedFilePlan[]}
 */
export function itemizedFilePlans(tree, dbOf, dir) {
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith(ITEMIZED_SUFFIX)).map(e => e.name).sort();
    if (files.length === 0) return [];
    /** @type {Map<string, { ownerId: string, label: string }[]>} */
    const byFileName = new Map();
    for (const row of /** @type {Iterable<{ owner_id: string, label: string }>} */ (tree.iterate('SELECT DISTINCT owner_id, label FROM messages WHERE label IS NOT NULL'))) {
        const key = sanitize(row.label);
        if (!byFileName.has(key)) byFileName.set(key, []);
        /** @type {any[]} */ (byFileName.get(key)).push({ ownerId: row.owner_id, label: row.label });
    }
    const hasTable = Boolean(tree.get('SELECT 1 AS ok FROM sqlite_master WHERE type = \'table\' AND name = \'itemizations\''));
    return files.map(file => {
        /** @type {ItemizedFilePlan} */
        const plan = { file, ownerId: null, convert: [], left: [], entries: 0 };
        const entries = readItemizedFile(dir, file);
        if ('unreadable' in entries) return { ...plan, unreadable: entries.unreadable };
        plan.entries = entries.list.length;
        const keep = (/** @type {string} */ reason) => ({ ...plan, kept: reason });
        const chatId = file.slice(0, -ITEMIZED_SUFFIX.length);
        const asNode = /** @type {{ owner_id: string } | undefined} */ (tree.get('SELECT owner_id FROM messages WHERE id = ? AND parent_id IS NOT NULL', [chatId]));
        const candidates = asNode ? [{ ownerId: asNode.owner_id, label: chatId }] : (byFileName.get(chatId) ?? []);
        if (candidates.length === 0) return keep(KEPT.noChat);
        if (new Set(candidates.map(c => c.ownerId)).size > 1) return keep(KEPT.ownerShared);
        if (new Set(candidates.map(c => c.label)).size > 1) return keep(KEPT.nameShared);
        const ownerId = candidates[0].ownerId;
        const db = dbOf(ownerId);
        const at = opens(db, ownerId, candidates[0].label);
        if (!at) return keep(KEPT.noChat);
        plan.ownerId = ownerId;
        const ids = pathTo(db, at.end);
        const taken = new Set();
        for (const entry of entries.list) {
            const mesId = Number(entry?.mesId);
            if (!entry || typeof entry !== 'object' || !Number.isInteger(mesId) || mesId < 0) {
                plan.left.push({ mesId: entry?.mesId, reason: 'it names no message position' });
                continue;
            }
            if (mesId >= ids.length) return keep(KEPT.pastEnd);
            const nodeId = ids[mesId];
            if (taken.has(nodeId)) {
                plan.left.push({ mesId, reason: 'an earlier entry for this message was the one shown' });
                continue;
            }
            taken.add(nodeId);
            if (hasTable && tree.get('SELECT 1 AS ok FROM itemizations WHERE node_id = ?', [nodeId])) {
                plan.left.push({ mesId, reason: 'the message already has an itemization' });
                continue;
            }
            plan.convert.push({ nodeId, mesId });
        }
        return plan;
    });
}

/**
 * @param {string} dir
 * @param {string} file
 * @returns {{ list: Record<string, any>[] } | { unreadable: string }}
 */
export function readItemizedFile(dir, file) {
    try {
        const list = decodeEntries(readStoredValue(fs.readFileSync(path.join(dir, file))));
        return list ? { list } : { unreadable: 'it holds no list of entries' };
    } catch (err) {
        return { unreadable: /** @type {Error} */ (err).message };
    }
}

/**
 * The entries a plan converts, as stored: each without its `mesId`, by node id.
 * @param {string} dir
 * @param {ItemizedFilePlan} plan
 * @returns {Map<string, Record<string, any>>}
 */
export function itemizedEntries(dir, plan) {
    const read = readItemizedFile(dir, plan.file);
    /** @type {Map<string, Record<string, any>>} */
    const out = new Map();
    if ('unreadable' in read) return out;
    const wanted = new Map(plan.convert.map(c => [c.mesId, c.nodeId]));
    const seen = new Set();
    for (const entry of read.list) {
        const mesId = Number(entry?.mesId);
        const nodeId = wanted.get(mesId);
        if (nodeId === undefined || seen.has(mesId)) continue;
        seen.add(mesId);
        const stored = { ...entry };
        delete stored.mesId;
        out.set(nodeId, stored);
    }
    return out;
}
