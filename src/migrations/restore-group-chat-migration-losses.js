import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

import { color, getConfigFilePath } from '../util.js';
import { isChatHeaderEntry, parseChatFile } from '../chat-header.js';
import { USER_DIRECTORY_TEMPLATE } from '../constants.js';
import {
    getDbHandle, insertMessageSync, newId, ensureAnchorSync, setDefaultChildSync, alternativesFromMessage, identityHashOf,
} from '../message-tree-db.js';

/**
 * Repairs group chats damaged by an older tree migration, which took a headerless chat file's first line
 * as its header. For each such chat the original bytes sit in
 * `<groupChats>/<chatId>.jsonl.pre-migration` with no header line; the tree holds messages 2..n under the
 * group's anchor with message 1 missing, the label `<chatId>` on the last one and `{"__is_group":true}` as its
 * only metadata; a one-message chat got no label at all. The chat's metadata survives only in
 * `<backups>/_group_metadata_update/<group file name>`.
 *
 * Message 1 goes back in front of message 2, which moves message 2 and everything under it. A chat whose
 * current first message also carries other labels below it is refused: those chats would gain the
 * restored message too.
 *
 * Message 2's other alternatives are copied under the restored message rather than moved, since they may be
 * openings other chats start from.
 *
 * Dry run for one user, writing nothing:
 *   node src/migrations/restore-group-chat-migration-losses.js [--data-root ./data] [--handle default-user]
 */

const MARKER_KEY = 'group_chat_migration_losses_restored';
const DEFAULT_PAUSE_MS = 20;
const MAX_PATH_DEPTH = 1000000;
const MAX_LISTED_LABELS = 20;
const LOG_PREFIX = '[restore-group-chats]';

const WORKER_PATH = fileURLToPath(new URL('./restore-group-chat-migration-losses-worker.js', import.meta.url));

/**
 * @typedef {object} RestoreDirectories
 * @property {string} root
 * @property {string} groups
 * @property {string} groupChats
 * @property {string} backups
 */

/**
 * @typedef {object} Reader
 * @property {(sql: string, params?: object) => any} get One row, or undefined
 * @property {(sql: string, params?: object) => Iterable<any>} iterate
 */

/**
 * @typedef {object} ChatRestoreInput
 * @property {string} ownerId The group's id
 * @property {string} chatId
 * @property {object[]} messages Every line of the headerless original, parsed
 * @property {unknown} backupMetadata The chat's metadata from the backup, or null when it has none
 * @property {string} backupPath
 */

/**
 * @typedef {{ status: 'intact', metadataKept: string[] }
 *   | { status: 'restore', kind: 'metadata', labelId: string, labelMetadata: string, metadataAdd: Record<string, unknown>, metadataKept: string[] }
 *   | { status: 'restore', kind: 'prepend', anchorId: string, anchorDefault: string | null, bId: string, bCreatedAt: number, labelId: string, labelMetadata: string, metadataAdd: Record<string, unknown>, metadataKept: string[] }
 *   | { status: 'restore', kind: 'whole', metadataAdd: Record<string, unknown>, metadataKept: string[] }
 *   | { status: 'unrestorable', reason: string }} ChatRestorePlan
 */

/**
 * @typedef {object} Item
 * @property {string} groupId
 * @property {string} chatId
 * @property {string} text
 * @property {string} originalPath
 * @property {string} backupPath
 */

/**
 * @typedef {object} RestoreResult
 * @property {Item[]} intact
 * @property {Item[]} restored Would be restored, when not applying
 * @property {Item[]} unrestorable
 * @property {Item[]} notices
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
function sortKeysDeep(value) {
    if (Array.isArray(value)) return value.map(sortKeysDeep);
    if (isPlainObject(value)) {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeysDeep(value[key])]));
    }
    return value;
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function canonicalJsonEqual(a, b) {
    return JSON.stringify(sortKeysDeep(a)) === JSON.stringify(sortKeysDeep(b));
}

/**
 * @param {ChatRestoreInput} input
 * @param {string | null | undefined} labelMetadata The label row's stored metadata; undefined when the chat has no label yet
 * @returns {{ metadataAdd: Record<string, unknown>, metadataKept: string[] } | { reason: string }}
 */
function planMetadata(input, labelMetadata) {
    if (input.backupMetadata === null) {
        return { metadataAdd: {}, metadataKept: [] };
    }
    if (!isPlainObject(input.backupMetadata)) {
        return { reason: `its metadata in ${input.backupPath} is not an object` };
    }
    const target = { ...input.backupMetadata };
    delete target.main_chat;
    delete target.fork_point;

    if (labelMetadata === undefined) {
        return { metadataAdd: target, metadataKept: [] };
    }

    let current;
    try {
        current = JSON.parse(/** @type {string} */ (labelMetadata));
    } catch {
        current = null;
    }
    if (current === null) {
        return { reason: 'its chat metadata in the tree is not valid JSON' };
    }

    /** @type {Record<string, unknown>} */
    const metadataAdd = {};
    /** @type {string[]} */
    const metadataKept = [];
    for (const key of Object.keys(target)) {
        if (key === '__is_group') continue;
        if (!Object.hasOwn(current, key)) {
            metadataAdd[key] = target[key];
        } else if (!canonicalJsonEqual(current[key], target[key])) {
            metadataKept.push(key);
        }
    }
    return { metadataAdd, metadataKept };
}

/**
 * Decides what restoring one chat would write, reading only.
 * @param {Reader} reader
 * @param {ChatRestoreInput} input
 * @returns {ChatRestorePlan}
 */
export function planChatRestore(reader, input) {
    const { ownerId, chatId, messages } = input;
    const n = messages.length;
    const alts = messages.map(message => alternativesFromMessage(/** @type {any} */ (message)));
    /** @param {number} i */
    const sel = i => alts[i].contents[alts[i].selected];

    const anchor = reader.get(
        'SELECT id, default_child_id FROM messages WHERE owner_id = @ownerId AND parent_id IS NULL ORDER BY created_at ASC, id ASC LIMIT 1',
        { ownerId });

    const labelRows = Array.from(reader.iterate(
        'SELECT id, parent_id, metadata FROM messages WHERE owner_id = @ownerId AND label = @chatId LIMIT 2',
        { ownerId, chatId }));
    if (labelRows.length === 2) {
        return { status: 'unrestorable', reason: `more than one message in the tree is named "${chatId}"` };
    }

    if (labelRows.length === 1) {
        const label = labelRows[0];
        if (!anchor) {
            return { status: 'unrestorable', reason: 'the chat is in the tree but its group has no anchor message' };
        }

        const walk = [];
        let id = label.id;
        for (;;) {
            if (walk.length === MAX_PATH_DEPTH) {
                return { status: 'unrestorable', reason: `its path in the tree is deeper than ${MAX_PATH_DEPTH} messages` };
            }
            const row = reader.get(
                'SELECT id, parent_id, identity_hash, content, created_at, default_child_id FROM messages WHERE id = @id',
                { id });
            if (!row) {
                return { status: 'unrestorable', reason: 'its path in the tree is broken' };
            }
            walk.push(row);
            if (row.parent_id === null) break;
            id = row.parent_id;
        }
        const p = walk.reverse();
        if (p[0].id !== anchor.id) {
            return { status: 'unrestorable', reason: 'its path in the tree does not start at the group\'s anchor' };
        }

        let good = p.length - 1 >= n;
        for (let i = 0; good && i < n; i++) {
            good = p[i + 1].identity_hash === identityHashOf(p[i].id, sel(i));
        }

        if (good) {
            const metadata = planMetadata(input, label.metadata);
            if ('reason' in metadata) return { status: 'unrestorable', reason: metadata.reason };
            if (Object.keys(metadata.metadataAdd).length === 0) {
                return { status: 'intact', metadataKept: metadata.metadataKept };
            }
            return {
                status: 'restore', kind: 'metadata', labelId: label.id, labelMetadata: label.metadata,
                metadataAdd: metadata.metadataAdd, metadataKept: metadata.metadataKept,
            };
        }

        let firstMismatch = 1;
        if (n >= 2) {
            firstMismatch = 0;
            for (let i = 1; i < n; i++) {
                if (i >= p.length || p[i].identity_hash !== identityHashOf(p[i - 1].id, sel(i))) {
                    firstMismatch = i + 1;
                    break;
                }
            }
        }
        if (firstMismatch !== 0) {
            return { status: 'unrestorable', reason: `its messages in the tree no longer match the original from message ${firstMismatch} on` };
        }

        const b = p[1];
        const otherLabels = Array.from(reader.iterate(
            'WITH RECURSIVE sub(id) AS (SELECT @b UNION ALL SELECT m.id FROM messages m JOIN sub s ON m.parent_id = s.id) SELECT m.label AS label FROM messages m JOIN sub ON m.id = sub.id WHERE m.label IS NOT NULL AND m.label != @chatId LIMIT 21',
            { b: b.id, chatId }));
        if (otherLabels.length > 0) {
            const listed = otherLabels.slice(0, MAX_LISTED_LABELS).map(row => `"${row.label}"`).join(', ');
            const more = otherLabels.length > MAX_LISTED_LABELS ? ' and more' : '';
            return {
                status: 'unrestorable',
                reason: `other chats or bookmarks continue from its current first message, so adding the lost first message there would change them too: ${listed}${more}`,
            };
        }

        const x = reader.get(
            'SELECT id, default_child_id FROM messages WHERE parent_id = @a AND identity_hash = @h',
            { a: anchor.id, h: identityHashOf(anchor.id, sel(0)) });
        const xId = x?.id ?? null;
        if (xId === b.id) {
            return { status: 'unrestorable', reason: 'its lost first message is identical to its current first message, so where it belongs is ambiguous' };
        }
        if (x) {
            const twin = reader.get(
                'SELECT id FROM messages WHERE parent_id = @x AND identity_hash = @h',
                { x: x.id, h: identityHashOf(x.id, b.content) });
            if (twin) {
                return { status: 'unrestorable', reason: 'the tree already holds its first two messages on another path, so where it belongs is ambiguous' };
            }
        }

        const metadata = planMetadata(input, label.metadata);
        if ('reason' in metadata) return { status: 'unrestorable', reason: metadata.reason };
        return {
            status: 'restore', kind: 'prepend',
            anchorId: anchor.id, anchorDefault: anchor.default_child_id, bId: b.id, bCreatedAt: b.created_at,
            labelId: label.id, labelMetadata: label.metadata,
            metadataAdd: metadata.metadataAdd, metadataKept: metadata.metadataKept,
        };
    }

    let parent = anchor?.id ?? null;
    let chosen;
    let found = 0;
    for (let i = 0; i < n && parent !== null; i++) {
        chosen = reader.get(
            'SELECT id, label FROM messages WHERE parent_id = @p AND identity_hash = @h',
            { p: parent, h: identityHashOf(parent, sel(i)) });
        if (!chosen) break;
        found++;
        parent = chosen.id;
    }
    if (found === n && chosen.label !== null) {
        return { status: 'unrestorable', reason: `its messages already form the chat "${chosen.label}" in the tree, so it cannot get its own name there` };
    }

    const metadata = planMetadata(input, undefined);
    if ('reason' in metadata) return { status: 'unrestorable', reason: metadata.reason };
    return { status: 'restore', kind: 'whole', metadataAdd: metadata.metadataAdd, metadataKept: metadata.metadataKept };
}

/**
 * @param {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} ownerId
 * @param {string} parentId
 * @param {string} content
 * @param {number} createdAt
 * @returns {string}
 */
function childWithContentSync(db, ownerId, parentId, content, createdAt) {
    const twin = /** @type {{ id: string } | undefined} */ (db.get(
        'SELECT id FROM messages WHERE parent_id = @p AND identity_hash = @h',
        { p: parentId, h: identityHashOf(parentId, content) }));
    if (twin) return twin.id;
    const id = newId();
    insertMessageSync(db, { id, parentId, ownerId, content, createdAt });
    return id;
}

/**
 * @param {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} labelId
 * @param {string} labelMetadata
 * @param {Record<string, unknown>} metadataAdd
 */
function addMetadataSync(db, labelId, labelMetadata, metadataAdd) {
    const current = JSON.parse(labelMetadata);
    db.run('UPDATE messages SET metadata = @m WHERE id = @id', { m: JSON.stringify({ ...current, ...metadataAdd }), id: labelId });
}

/**
 * @param {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} id
 * @returns {string | null}
 */
function defaultChildOfSync(db, id) {
    return /** @type {{ default_child_id: string | null }} */ (db.get('SELECT default_child_id FROM messages WHERE id = @id', { id })).default_child_id;
}

/**
 * Writes a plan. Must run inside `db.transaction()`, with `plan` from planChatRestore(db, input) in that same
 * transaction.
 * @param {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {Extract<ChatRestorePlan, { status: 'restore' }>} plan
 * @param {ChatRestoreInput} input
 * @param {number} now
 */
export function applyChatRestore(db, plan, input, now) {
    const { ownerId, chatId, messages } = input;

    if (plan.kind === 'metadata') {
        addMetadataSync(db, plan.labelId, plan.labelMetadata, plan.metadataAdd);
        return;
    }

    if (plan.kind === 'prepend') {
        const first = alternativesFromMessage(/** @type {any} */ (messages[0]));
        let xId = '';
        first.contents.forEach((content, k) => {
            const id = childWithContentSync(db, ownerId, plan.anchorId, content, now + k);
            if (k === first.selected) xId = id;
        });

        const bContent = /** @type {{ content: string }} */ (db.get('SELECT content FROM messages WHERE id = @id', { id: plan.bId })).content;
        db.run('UPDATE messages SET parent_id = @x, identity_hash = @h WHERE id = @b',
            { x: xId, h: identityHashOf(xId, bContent), b: plan.bId });

        const second = alternativesFromMessage(/** @type {any} */ (messages[1]));
        second.contents.forEach((content, k) => {
            if (k === second.selected) return;
            childWithContentSync(db, ownerId, xId, content, plan.bCreatedAt - second.selected + k);
        });

        if (plan.anchorDefault === plan.bId) {
            setDefaultChildSync(db, plan.anchorId, xId);
        }
        if (defaultChildOfSync(db, xId) === null) {
            setDefaultChildSync(db, xId, plan.bId);
        }

        if (Object.keys(plan.metadataAdd).length > 0) {
            addMetadataSync(db, plan.labelId, plan.labelMetadata, plan.metadataAdd);
        }
        return;
    }

    const anchor = ensureAnchorSync(db, ownerId, now, { kind: 'group', rowId: ownerId });
    let parent = anchor.id;
    for (const message of messages) {
        const alts = alternativesFromMessage(/** @type {any} */ (message));
        let chosen = '';
        alts.contents.forEach((content, k) => {
            const id = childWithContentSync(db, ownerId, parent, content, now + k);
            if (k === alts.selected) chosen = id;
        });
        if (defaultChildOfSync(db, parent) === null) {
            setDefaultChildSync(db, parent, chosen);
        }
        parent = chosen;
    }
    db.run('UPDATE messages SET label = @chatId, metadata = @m WHERE id = @last',
        { chatId, m: JSON.stringify({ ...plan.metadataAdd, __is_group: true }), last: parent });
}

/**
 * @param {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {ChatRestoreInput} input
 * @returns {ChatRestorePlan}
 */
function planAndApplySync(db, input) {
    /** @type {{ plan?: ChatRestorePlan }} */
    const out = {};
    db.transaction(() => {
        out.plan = planChatRestore(db, input);
        if (out.plan.status === 'restore') applyChatRestore(db, out.plan, input, Date.now());
    });
    // transaction() runs its callback before returning, so plan is set here.
    return /** @type {ChatRestorePlan} */ (out.plan);
}

/**
 * @param {string} filePath
 * @returns {Promise<{ skip: true } | { error: any } | { line: string }>}
 */
async function readFirstLine(filePath) {
    let stat;
    try {
        stat = await fsPromises.stat(filePath);
    } catch (err) {
        return err?.code === 'ENOENT' ? { skip: true } : { error: err };
    }
    if (!stat.isFile()) return { skip: true };

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
        for await (const line of lines) {
            if (line.trim()) return { line };
        }
        return { skip: true };
    } catch (err) {
        return err?.code === 'ENOENT' ? { skip: true } : { error: err };
    } finally {
        lines.close();
        stream.destroy();
    }
}

/**
 * @param {string} backupPath
 * @param {string} groupId
 * @returns {Promise<{ backup: Record<string, any> | null } | { reason: string }>}
 */
async function readBackup(backupPath, groupId) {
    let raw;
    try {
        raw = await fsPromises.readFile(backupPath, 'utf8');
    } catch (err) {
        if (err?.code === 'ENOENT') return { backup: null };
        return { reason: `its group's metadata backup ${backupPath} cannot be read: ${err.code ?? err.message}` };
    }
    let backup;
    try {
        backup = JSON.parse(raw);
    } catch {
        return { reason: `its group's metadata backup ${backupPath} is not valid JSON` };
    }
    if (!isPlainObject(backup)) {
        return { reason: `its group's metadata backup ${backupPath} is not a JSON object` };
    }
    if (backup.id !== groupId) {
        return { reason: `its group's metadata backup ${backupPath} belongs to group ${backup.id}` };
    }
    return { backup };
}

/**
 * Finds every group chat whose headerless original survives as `.pre-migration` and restores (or, with
 * `apply` false, plans) what the tree lost from it.
 * @param {RestoreDirectories} directories
 * @param {object} options
 * @param {Reader} options.reader With `apply`, the getDbHandle(directories) write handle.
 * @param {boolean} options.apply
 * @param {number} [options.pauseMs]
 * @returns {Promise<RestoreResult>}
 */
export async function restoreGroupChatLosses(directories, { reader, apply, pauseMs = DEFAULT_PAUSE_MS }) {
    /** @type {RestoreResult} */
    const result = { intact: [], restored: [], unrestorable: [], notices: [] };

    let dir;
    try {
        dir = await fsPromises.opendir(directories.groups);
    } catch (err) {
        if (err?.code === 'ENOENT') return result;
        throw err;
    }

    for await (const entry of dir) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        let group;
        try {
            group = JSON.parse(await fsPromises.readFile(path.join(directories.groups, entry.name), 'utf8'));
        } catch {
            continue;
        }
        if (typeof group?.id !== 'string' || !Array.isArray(group.chats)) continue;

        const groupId = group.id;
        const backupPath = path.join(directories.backups, '_group_metadata_update', entry.name);
        /** @type {Awaited<ReturnType<typeof readBackup>> | undefined} */
        let backupRead;
        const chatIds = [...new Set(group.chats)].filter(c =>
            typeof c === 'string' && !c.includes('/') && !c.includes('\\') && path.basename(c) === c);

        for (const chatId of chatIds) {
            const originalPath = path.join(directories.groupChats, `${chatId}.jsonl.pre-migration`);
            /** @param {string} text @returns {Item} */
            const item = text => ({ groupId, chatId, text, originalPath, backupPath });

            const head = await readFirstLine(originalPath);
            if ('skip' in head) continue;
            if ('error' in head) {
                result.unrestorable.push(item(`its original cannot be read: ${head.error.code ?? head.error.message}`));
                continue;
            }
            let firstEntry;
            try {
                firstEntry = JSON.parse(head.line);
            } catch {
                result.unrestorable.push(item('its original\'s first line is not valid JSON'));
                continue;
            }
            if (isChatHeaderEntry(firstEntry)) continue;

            const handleCandidate = async () => {
                let raw;
                try {
                    raw = await fsPromises.readFile(originalPath, 'utf8');
                } catch (err) {
                    if (err?.code !== 'ENOENT') {
                        result.unrestorable.push(item(`its original cannot be read: ${err.code ?? err.message}`));
                    }
                    return;
                }
                const parsed = parseChatFile(raw);
                if ('error' in parsed) {
                    result.unrestorable.push(item(`its original cannot be read whole: ${parsed.error}`));
                    return;
                }

                backupRead ??= await readBackup(backupPath, groupId);
                if ('reason' in backupRead) {
                    result.unrestorable.push(item(backupRead.reason));
                    return;
                }
                const backup = backupRead.backup;
                const backupMetadata = backup === null
                    ? null
                    : ((backup.chat_id === chatId && Object.hasOwn(backup, 'chat_metadata'))
                        ? backup.chat_metadata
                        : backup.past_metadata?.[chatId]) ?? null;

                /** @type {ChatRestoreInput} */
                const input = { ownerId: groupId, chatId, messages: parsed.messages, backupMetadata, backupPath };

                /** @type {ChatRestorePlan} */
                let plan;
                if (!apply) {
                    plan = planChatRestore(reader, input);
                } else {
                    try {
                        plan = planAndApplySync(/** @type {import('../endpoints/sqlite-engine.js').SqliteEngineHandle} */ (reader), input);
                    } catch (err) {
                        plan = { status: 'unrestorable', reason: `restoring it failed: ${err?.message ?? String(err)}` };
                    }
                }

                if (plan.status === 'unrestorable') {
                    result.unrestorable.push(item(plan.reason));
                    return;
                }
                if (plan.status === 'intact') {
                    result.intact.push(item('messages and metadata already in the tree'));
                } else {
                    const keys = Object.keys(plan.metadataAdd).join(', ');
                    let text;
                    if (plan.kind === 'prepend') {
                        text = `add its lost first message in front of its ${parsed.messages.length - 1} message(s) in the tree${keys ? `; add metadata keys ${keys}` : ''}`;
                    } else if (plan.kind === 'whole') {
                        text = `add the whole chat (${parsed.messages.length} message(s)) to the tree${keys ? ` with metadata keys ${keys}` : ''}`;
                    } else {
                        text = `add metadata keys ${keys}`;
                    }
                    result.restored.push(item(text));
                }
                if (plan.metadataKept.length > 0) {
                    result.notices.push(item(`metadata keys kept at their current value, which differs from the backup: ${plan.metadataKept.join(', ')}`));
                }
            };

            await handleCandidate();
            await new Promise(resolve => setTimeout(resolve, pauseMs));
        }
    }

    return result;
}

/**
 * @param {string} root
 * @param {RestoreResult} result
 * @param {boolean} apply
 * @returns {string[]} Summary, then restored, intact, cannot-restore and note lines, in that order
 */
export function formatReport(root, result, apply) {
    const c = result.intact.length + result.restored.length + result.unrestorable.length;
    const lines = [
        `${LOG_PREFIX} ${root}: ${c} headerless original(s) found; ${result.restored.length} ${apply ? 'restored' : 'would be restored'}, ${result.intact.length} already intact, ${result.unrestorable.length} cannot be restored.`,
    ];
    for (const it of result.restored) {
        lines.push(`${LOG_PREFIX}   ${apply ? 'RESTORED' : 'WOULD RESTORE'} group ${it.groupId} chat "${it.chatId}": ${it.text}`);
    }
    for (const it of result.intact) {
        lines.push(`${LOG_PREFIX}   INTACT group ${it.groupId} chat "${it.chatId}": ${it.text}`);
    }
    for (const it of result.unrestorable) {
        lines.push(`${LOG_PREFIX}   CANNOT RESTORE group ${it.groupId} chat "${it.chatId}": ${it.text} (original: ${it.originalPath}, backup: ${it.backupPath}) - left untouched`);
    }
    for (const it of result.notices) {
        lines.push(`${LOG_PREFIX}   NOTE group ${it.groupId} chat "${it.chatId}": ${it.text} (backup: ${it.backupPath})`);
    }
    return lines;
}

/**
 * @param {RestoreDirectories} directories
 * @param {object} [options]
 * @param {(line: string) => void} [options.log]
 * @param {(line: string) => void} [options.warn]
 * @param {number} [options.pauseMs]
 * @returns {Promise<{ status: 'unavailable' | 'already-complete' | 'error' } | { status: 'ran', result: RestoreResult }>}
 */
export async function runOnceAtBoot(directories, options = {}) {
    const log = options.log ?? console.log;
    const warn = options.warn ?? console.warn;
    const root = directories.root;

    const db = await getDbHandle(directories);
    if (!db) return { status: 'unavailable' };
    if (db.get('SELECT value FROM meta WHERE key = @key', { key: MARKER_KEY })) {
        return { status: 'already-complete' };
    }

    let result;
    try {
        result = await restoreGroupChatLosses(directories, { reader: db, apply: true, pauseMs: options.pauseMs });
    } catch (err) {
        warn(color.red(`${LOG_PREFIX} ${root}: run failed, will retry next boot: ${err?.message ?? String(err)}`));
        return { status: 'error' };
    }

    const lines = formatReport(root, result, true);
    const logged = 1 + result.restored.length + result.intact.length;
    lines.slice(0, logged).forEach(line => log(line));
    lines.slice(logged).forEach(line => warn(color.yellow(line)));

    db.run('INSERT INTO meta (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        { key: MARKER_KEY, value: String(Date.now()) });
    return { status: 'ran', result };
}

/** @param {object} workerData */
const defaultSpawn = workerData => new Worker(WORKER_PATH, { workerData });

/**
 * @param {RestoreDirectories[]} directoriesList Users to restore
 * @param {object} options
 * @param {boolean} options.enabled
 * @param {RestoreDirectories[]} [options.held] Users not restored this boot because the group chat migration left
 * some of their chat files un-migrated; the restore reads what that migration landed, so it waits until it has all
 * @param {(workerData: { directoriesList: RestoreDirectories[], configPath: string | null }) => import('node:worker_threads').Worker} [options.spawnWorker]
 * @returns {boolean} Whether a worker was started
 */
export function maybeStartGroupChatRestore(directoriesList, { enabled, held = [], spawnWorker = defaultSpawn }) {
    if (!enabled) return false;
    for (const directories of held) {
        console.warn(color.yellow(`${LOG_PREFIX} ${directories.root}: not run this boot; it waits until every group chat file the migration left in place (listed above) has migrated`));
    }
    if (directoriesList.length === 0) return false;
    const worker = spawnWorker({ directoriesList, configPath: getConfigFilePath() });
    worker.on('error', err => console.error(color.red(`${LOG_PREFIX} worker failed:`), err));
    worker.unref?.();
    return true;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    const { default: Database } = await import('better-sqlite3');

    const args = process.argv.slice(2);
    const getArg = (name, fallback) => {
        const index = args.indexOf(`--${name}`);
        return index !== -1 && args[index + 1] !== undefined ? args[index + 1] : fallback;
    };

    const dataRoot = getArg('data-root', './data');
    const handle = getArg('handle', 'default-user');
    const root = path.join(dataRoot, handle);
    const dirs = {
        root,
        groups: path.join(root, USER_DIRECTORY_TEMPLATE.groups),
        groupChats: path.join(root, USER_DIRECTORY_TEMPLATE.groupChats),
        backups: path.join(root, USER_DIRECTORY_TEMPLATE.backups),
    };

    const db = new Database(path.join(root, 'message-tree.sqlite'), { readonly: true, fileMustExist: true });
    const reader = {
        get: (sql, p) => db.prepare(sql).get(p ?? {}),
        iterate: (sql, p) => db.prepare(sql).iterate(p ?? {}),
    };
    let result;
    try {
        result = await restoreGroupChatLosses(dirs, { reader, apply: false, pauseMs: 0 });
    } finally {
        db.close();
    }
    for (const line of formatReport(root, result, false)) {
        console.log(line);
    }
    console.log(`${LOG_PREFIX} dry run: nothing was written.`);
}
