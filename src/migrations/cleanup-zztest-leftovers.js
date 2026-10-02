import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { getConfigValue, setConfigFilePath } from '../util.js';
import { USER_DIRECTORY_TEMPLATE } from '../constants.js';
import { normalizeGroupRecord } from '../group-id.js';
import { openNativeTreeDatabase } from '../message-stats.js';
import { deleteNodesSync, swapDefaultChildSync } from '../message-tree-db.js';
import { groupDigestContentHash, groupDigestFavHash, normalizeFav } from '../../public/scripts/hash-utils.js';

/**
 * Removes three known leftover test records from one user's data:
 *
 * 1. Group `1740062933703`: `zztest-group-chat` is dropped from `chats` (nothing else in the file changes). The
 *    write goes through character-metadata-db.js's writeGroupFileAndRow() (createIfMissing: false), so the group's
 *    `groups` row digest follows the file. A missing row is reported and its digest write skipped.
 * 2. message-tree.sqlite: the group's anchor points its default child back at Ivy's opening instead of the stray
 *    "hi group" node (which stays in the tree).
 * 3. message-tree.sqlite: owner `zztestchar`'s two rows (its anchor and a user "hi") are removed. Any existing
 *    character-metadata.sqlite row its chat stats belong to is queued in `chat_stats_pending` to be counted again.
 *
 * Every item is checked against the exact expected state first; an item already in its end state is a no-op, and an
 * item in any other state is refused and left untouched. What an item changes is backed up (row JSON, a copy of the
 * group file) under `<user>/backups/_cleanup-zztest-leftovers/<timestamp>/` before it is changed; backups are never
 * deleted, and nothing is written at all when there is nothing to change.
 *
 * Dry run (read-only opens, writes nothing, may run while the server is running):
 *   node src/migrations/cleanup-zztest-leftovers.js --dry-run [--data-root ./data] [--handle default-user] [--config ./config.yaml]
 * Real run (the server must be stopped, and must have been started once on this data by the current code):
 *   node src/migrations/cleanup-zztest-leftovers.js --apply --server-stopped [--data-root ./data] [--handle default-user] [--config ./config.yaml]
 */

const LOG_PREFIX = '[cleanup-zztest]';
const BACKUP_DIR_NAME = '_cleanup-zztest-leftovers';

export const GROUP_ID = '1740062933703';
export const GROUP_CHAT = '2025-02-21@00h48m53s';
export const STRAY_GROUP_CHAT = 'zztest-group-chat';

export const GROUP_ANCHOR_ID = '6cf30128-c924-49cb-badb-fd9ffecaf68f';
export const HI_GROUP_ID = '1ee1d03f-df1d-4dce-a795-7aa4984c3ad4';
export const IVY_OPENING_ID = '443dc598-dc4f-4366-84f2-26113f8eb8ce';
export const LABEL_NODE_ID = 'efc37142-a0ef-45ee-9a2d-866b897845da';
const HI_GROUP_CREATED_AT = 1789578278574;
const HI_GROUP_INTEGRITY = 'bc756733-f799-4d6b-847c-20c413afd4a5';
/** Depth of Ivy's opening above the label node; the anchor is one further. */
const IVY_DEPTH = 28;

export const STRAY_OWNER = 'zztestchar';
export const STRAY_ANCHOR_ID = '0ed9ac5e-4ea1-4e59-8680-c60d03f3c745';
export const STRAY_CHILD_ID = '690b7bfa-71f6-448e-a6b2-0a53ae4b063b';
const ANCHOR_CONTENT = '{"__anchor":true}';

/** character-metadata-db.js's UNUSED_INDEXES_DROPPED_FLAG: set by its last schema step. */
export const MARKER_META_KEY = 'unused_indexes_dropped_v1';
export const MARKER_MISSING_MESSAGE = 'start the server once, stop it, then rerun';

/**
 * @typedef {object} Reader
 * @property {(sql: string, params?: object) => any} get
 * @property {(sql: string, params?: object) => any[]} rows Bounded by the query's own LIMIT.
 * @property {() => void} close
 */

/**
 * @typedef {object} ItemPlan
 * @property {'change' | 'done' | 'refused'} status
 * @property {string[]} lines What was found / would change.
 * @property {string} [reason] Why it was refused.
 */

/**
 * @param {any} db better-sqlite3 connection
 * @returns {Reader & { exec: (sql: string) => void, run: (sql: string, params?: object) => { changes: number }, defineFunction: (name: string, fn: (...args: any[]) => any) => void }}
 */
function wrap(db) {
    return {
        defineFunction: (name, fn) => db.function(name, { deterministic: true }, fn),
        get: (sql, params) => db.prepare(sql).get(params ?? {}),
        rows: (sql, params) => {
            const out = [];
            for (const row of db.prepare(sql).iterate(params ?? {})) out.push(row);
            return out;
        },
        iterate: (sql, params) => db.prepare(sql).iterate(params ?? {}),
        exec: sql => db.exec(sql),
        run: (sql, params) => db.prepare(sql).run(params ?? {}),
        close: () => db.close(),
    };
}

/**
 * @param {any} Database better-sqlite3 constructor
 * @param {string} file
 */
function openReadOnly(Database, file) {
    return wrap(new Database(file, { readonly: true, fileMustExist: true }));
}

/** @param {string} root */
function userDirectories(root) {
    return {
        root,
        groups: path.join(root, USER_DIRECTORY_TEMPLATE.groups),
        groupChats: path.join(root, USER_DIRECTORY_TEMPLATE.groupChats),
        characters: path.join(root, USER_DIRECTORY_TEMPLATE.characters),
        backups: path.join(root, USER_DIRECTORY_TEMPLATE.backups),
    };
}

const refused = (lines, reason) => /** @type {ItemPlan} */ ({ status: 'refused', lines, reason });

// ---------------------------------------------------------------------------
//  Item 1: the group file
// ---------------------------------------------------------------------------

/**
 * @param {ReturnType<typeof userDirectories>} dirs
 * @returns {ItemPlan & { filePath: string, originalText?: string, newText?: string, newGroup?: object }}
 */
function planGroupFile(dirs) {
    const filePath = path.join(dirs.groups, `${GROUP_ID}.json`);
    const lines = [`group file ${filePath}`];
    if (!fs.existsSync(filePath)) return { ...refused(lines, 'group file does not exist'), filePath };

    const originalText = fs.readFileSync(filePath, 'utf8');
    let group;
    try {
        group = JSON.parse(originalText);
    } catch (err) {
        return { ...refused(lines, `group file is not valid JSON: ${err.message}`), filePath };
    }
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
        return { ...refused(lines, 'group file is not a JSON object'), filePath };
    }
    if (group.id !== GROUP_ID) return { ...refused(lines, `id is ${JSON.stringify(group.id)}, expected "${GROUP_ID}"`), filePath };
    // The app writes groups in normalized form; anything else would be rewritten by more than the `chats` change.
    const normalized = normalizeGroupRecord(JSON.parse(originalText));
    if (JSON.stringify(normalized) !== JSON.stringify(group)) {
        return { ...refused(lines, 'group file is not in the normalized form the app writes'), filePath };
    }
    if (group.fav !== normalizeFav(group.fav)) {
        return { ...refused(lines, `fav is ${JSON.stringify(group.fav)}, not the boolean the app writes`), filePath };
    }
    if (group.chat_id !== GROUP_CHAT) {
        return { ...refused(lines, `chat_id is ${JSON.stringify(group.chat_id)}, expected "${GROUP_CHAT}"`), filePath };
    }
    const chatsJson = JSON.stringify(group.chats);
    if (chatsJson === JSON.stringify([GROUP_CHAT])) {
        lines.push(`chats is already ${chatsJson}`);
        return { status: 'done', lines, filePath };
    }
    if (chatsJson !== JSON.stringify([GROUP_CHAT, STRAY_GROUP_CHAT])) {
        return { ...refused(lines, `chats is ${chatsJson}, expected ${JSON.stringify([GROUP_CHAT, STRAY_GROUP_CHAT])}`), filePath };
    }

    const newGroup = JSON.parse(originalText);
    newGroup.chats = [GROUP_CHAT];
    const newText = JSON.stringify(newGroup, null, 4);
    lines.push(`chats: ${chatsJson} -> ${JSON.stringify(newGroup.chats)}`);
    if (originalText !== JSON.stringify(group, null, 4)) {
        lines.push('note: the file is rewritten in the app\'s 4-space JSON layout (whitespace only; no other value changes)');
    }
    return { status: 'change', lines, filePath, originalText, newText, newGroup };
}

/**
 * The `groups` row as writeGroupFileAndRow()'s upsert would leave it, for the report.
 * @param {object} newGroup
 */
function predictedGroupRow(newGroup) {
    const group = /** @type {any} */ (newGroup);
    const fav = normalizeFav(group.fav);
    return {
        name: group.name ?? '',
        fav: fav ? 1 : 0,
        digest_fav: groupDigestFavHash({ fav }),
        digest_content: groupDigestContentHash(JSON.parse(JSON.stringify(group))),
    };
}

// ---------------------------------------------------------------------------
//  character-metadata.sqlite: marker, group row, character existence
// ---------------------------------------------------------------------------

/**
 * @param {Reader | null} meta
 * @returns {{ ok: boolean, detail: string }}
 */
function checkMarker(meta) {
    if (!meta) return { ok: false, detail: 'character-metadata.sqlite does not exist' };
    const table = meta.get('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'characters\' LIMIT 1');
    if (!table) return { ok: false, detail: 'character-metadata.sqlite has no characters table' };
    const mtime = meta.get('SELECT name FROM pragma_table_info(\'characters\') WHERE name = \'file_mtime\' LIMIT 1');
    if (mtime) return { ok: false, detail: 'characters still has file_mtime (the newest schema step has not run)' };
    const hasMeta = meta.get('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'meta\' LIMIT 1');
    if (!hasMeta || !meta.get('SELECT 1 FROM meta WHERE key = @key LIMIT 1', { key: MARKER_META_KEY })) {
        return { ok: false, detail: `meta has no ${MARKER_META_KEY} (the last schema step has not completed)` };
    }
    return { ok: true, detail: 'schema is current' };
}

/**
 * @param {Reader | null} meta
 * @returns {object | null}
 */
function readGroupRow(meta) {
    if (!meta) return null;
    const hasTable = meta.get('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'groups\' LIMIT 1');
    if (!hasTable) return null;
    return meta.get('SELECT * FROM groups WHERE id = @id LIMIT 1', { id: GROUP_ID }) ?? null;
}

/**
 * @param {object | null} row
 * @param {object} newGroup
 * @returns {string[]}
 */
function describeGroupRowChange(row, newGroup) {
    if (!row) return [`groups row for ${GROUP_ID}: missing - the digest write is skipped, no row is created`];
    const next = predictedGroupRow(newGroup);
    const lines = [];
    for (const [key, value] of Object.entries(next)) {
        const current = row[key] === null || row[key] === undefined ? row[key] : (typeof value === 'number' ? Number(row[key]) : row[key]);
        lines.push(current === value
            ? `groups row ${key}: unchanged (${JSON.stringify(value)})`
            : `groups row ${key}: ${JSON.stringify(current)} -> ${JSON.stringify(value)}`);
    }
    lines.push('groups row name_fold: recomputed from name by the app\'s upsert');
    return lines;
}

// ---------------------------------------------------------------------------
//  Items 2 and 3: message-tree.sqlite
// ---------------------------------------------------------------------------

const MESSAGE_COLUMNS = 'id, parent_id, owner_id, content, label, created_at, metadata, default_child_id, identity_hash';

/** @param {Reader} db @param {string} id */
const getMessage = (db, id) => db.get(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = @id LIMIT 1`, { id });

/**
 * @param {Reader} db
 * @returns {ItemPlan}
 */
export function planRepoint(db) {
    const lines = [`group ${GROUP_ID} anchor ${GROUP_ANCHOR_ID}`];
    const anchor = getMessage(db, GROUP_ANCHOR_ID);
    if (!anchor) return refused(lines, 'anchor row does not exist');
    if (anchor.owner_id !== GROUP_ID || anchor.parent_id !== null || anchor.label !== null) {
        return refused(lines, `anchor row is not the group's unlabeled root (owner ${anchor.owner_id}, parent ${anchor.parent_id}, label ${anchor.label})`);
    }
    const anchors = db.rows('SELECT id FROM messages WHERE owner_id = @o AND parent_id IS NULL LIMIT 2', { o: GROUP_ID });
    if (anchors.length !== 1) return refused(lines, `owner ${GROUP_ID} has ${anchors.length} root rows, expected exactly 1`);

    const children = db.rows('SELECT id FROM messages WHERE parent_id = @p LIMIT 3', { p: GROUP_ANCHOR_ID }).map(r => r.id).sort();
    const expectedChildren = [HI_GROUP_ID, IVY_OPENING_ID].sort();
    if (JSON.stringify(children) !== JSON.stringify(expectedChildren)) {
        return refused(lines, `anchor children are ${JSON.stringify(children)}, expected ${JSON.stringify(expectedChildren)}`);
    }

    const hi = getMessage(db, HI_GROUP_ID);
    let hiMeta = null;
    try { hiMeta = JSON.parse(hi.metadata); } catch { /* checked below */ }
    if (hi.owner_id !== GROUP_ID || hi.label !== null || Number(hi.created_at) !== HI_GROUP_CREATED_AT
        || hiMeta?.integrity !== HI_GROUP_INTEGRITY || hiMeta?.__is_group !== true) {
        return refused(lines, '"hi group" node does not match (owner, no label, created_at, metadata integrity/__is_group)');
    }
    if (db.get('SELECT id FROM messages WHERE parent_id = @p LIMIT 1', { p: HI_GROUP_ID })) {
        return refused(lines, '"hi group" node has children');
    }

    const ivy = getMessage(db, IVY_OPENING_ID);
    if (ivy.owner_id !== GROUP_ID) return refused(lines, `Ivy's opening has owner ${ivy.owner_id}`);

    const labels = db.rows('SELECT id, label FROM messages WHERE owner_id = @o AND label IS NOT NULL LIMIT 2', { o: GROUP_ID });
    if (labels.length !== 1 || labels[0].id !== LABEL_NODE_ID || labels[0].label !== GROUP_CHAT) {
        return refused(lines, `owner's labels are ${JSON.stringify(labels)}, expected only "${GROUP_CHAT}" on ${LABEL_NODE_ID}`);
    }

    // Walk up from the label; bounded to the expected depth plus one.
    let current = getMessage(db, LABEL_NODE_ID);
    for (let depth = 1; depth <= IVY_DEPTH + 1; depth++) {
        if (!current?.parent_id) return refused(lines, `label path ends at depth ${depth - 1}, expected the anchor at depth ${IVY_DEPTH + 1}`);
        current = getMessage(db, current.parent_id);
        if (!current || current.owner_id !== GROUP_ID) return refused(lines, `label path leaves owner ${GROUP_ID} at depth ${depth}`);
        if (depth === IVY_DEPTH && current.id !== IVY_OPENING_ID) return refused(lines, `label path has ${current.id} at depth ${IVY_DEPTH}, expected Ivy's opening`);
    }
    if (current.id !== GROUP_ANCHOR_ID) return refused(lines, `label path reaches ${current.id} at depth ${IVY_DEPTH + 1}, expected the anchor`);

    if (anchor.default_child_id === IVY_OPENING_ID) {
        lines.push(`default_child_id is already Ivy's opening ${IVY_OPENING_ID}`);
        return { status: 'done', lines };
    }
    if (anchor.default_child_id !== HI_GROUP_ID) {
        return refused(lines, `default_child_id is ${anchor.default_child_id}, expected "hi group" ${HI_GROUP_ID}`);
    }
    lines.push(`default_child_id: ${HI_GROUP_ID} ("hi group", stays in the tree) -> ${IVY_OPENING_ID} (Ivy's opening)`);
    return { status: 'change', lines };
}

/**
 * @param {Reader} db
 * @param {{ characterFileExists: boolean, characterRowExists: boolean }} character
 * @returns {ItemPlan}
 */
export function planStrayOwner(db, character) {
    const lines = [`owner ${STRAY_OWNER}`];
    const rows = db.rows(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE owner_id = @o LIMIT 3`, { o: STRAY_OWNER });
    if (rows.length === 0) {
        lines.push('no rows left');
        return { status: 'done', lines };
    }
    if (character.characterFileExists || character.characterRowExists) {
        return refused(lines, `character ${STRAY_OWNER} exists (${character.characterFileExists ? 'card file' : 'metadata row'})`);
    }
    const ids = rows.map(r => r.id).sort();
    const expectedIds = [STRAY_ANCHOR_ID, STRAY_CHILD_ID].sort();
    if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) {
        return refused(lines, `owner rows are ${JSON.stringify(ids)}, expected exactly ${JSON.stringify(expectedIds)}`);
    }
    const anchor = rows.find(r => r.id === STRAY_ANCHOR_ID);
    const child = rows.find(r => r.id === STRAY_CHILD_ID);
    if (anchor.parent_id !== null || anchor.label !== null || anchor.content !== ANCHOR_CONTENT
        || (anchor.metadata !== null && anchor.metadata !== ANCHOR_CONTENT)
        || (anchor.default_child_id !== null && anchor.default_child_id !== STRAY_CHILD_ID)) {
        return refused(lines, 'anchor row does not match (root, no label, anchor content, default child none or the "hi")');
    }
    let message = null;
    try { message = JSON.parse(child.content); } catch { /* checked below */ }
    if (child.parent_id !== STRAY_ANCHOR_ID || child.label !== null || child.default_child_id !== null
        || message?.is_user !== true || message?.mes !== 'hi') {
        return refused(lines, 'child row does not match (under the anchor, no label, no default child, user message "hi")');
    }
    const referencing = db.get(
        'SELECT id FROM messages WHERE (parent_id IN (@a, @c) OR default_child_id IN (@a, @c)) AND id NOT IN (@a, @c) LIMIT 1',
        { a: STRAY_ANCHOR_ID, c: STRAY_CHILD_ID },
    );
    if (referencing) return refused(lines, `row ${referencing.id} references them`);

    lines.push(`delete ${STRAY_ANCHOR_ID} (anchor) and ${STRAY_CHILD_ID} (user message "hi")`);
    return { status: 'change', lines };
}

// ---------------------------------------------------------------------------
//  Running-server check
// ---------------------------------------------------------------------------

/**
 * @param {string} host
 * @param {number} port
 * @returns {Promise<'free' | 'in-use' | 'unavailable' | string>}
 */
function probeBind(host, port) {
    return new Promise(resolve => {
        const server = net.createServer();
        server.once('error', err => {
            const code = /** @type {any} */ (err).code;
            if (code === 'EADDRINUSE') resolve('in-use');
            else if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') resolve('unavailable');
            else resolve(`error ${code ?? err.message}`);
        });
        server.listen({ host, port, exclusive: true }, () => server.close(() => resolve('free')));
    });
}

/**
 * Binds the configured listen addresses the way the server would (src/command-line.js getIPv4ListenUrl /
 * getIPv6ListenUrl), both families regardless of `protocol`. EADDRINUSE is how the server itself finds a running
 * instance (src/server-startup.js).
 * @returns {Promise<{ running: boolean, lines: string[] }>}
 */
export async function probeConfiguredServer() {
    const port = getConfigValue('port', 8000, 'number');
    const listen = getConfigValue('listen', false, 'boolean');
    const v4 = String(getConfigValue('listenAddress.ipv4', '0.0.0.0'));
    const v6 = String(getConfigValue('listenAddress.ipv6', '[::]')).replace(/^\[|\]$/g, '');
    const hosts = [
        listen ? (net.isIPv4(v4) ? v4 : '0.0.0.0') : '127.0.0.1',
        listen ? (net.isIPv6(v6) ? v6 : '::') : '::1',
    ];
    const lines = [];
    let running = false;
    for (const host of hosts) {
        const result = await probeBind(host, port);
        lines.push(`port probe ${host.includes(':') ? `[${host}]` : host}:${port}: ${result}`);
        if (result !== 'free' && result !== 'unavailable') running = true;
    }
    return { running, lines };
}

// ---------------------------------------------------------------------------
//  Backups
// ---------------------------------------------------------------------------

/**
 * @param {ReturnType<typeof userDirectories>} dirs
 * @param {Date} now
 */
function createBackupDir(dirs, now) {
    const parent = path.join(dirs.backups, BACKUP_DIR_NAME);
    fs.mkdirSync(parent, { recursive: true });
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    for (let n = 0; ; n++) {
        const dir = path.join(parent, n === 0 ? stamp : `${stamp}-${n}`);
        try {
            fs.mkdirSync(dir);
            return dir;
        } catch (err) {
            if (/** @type {any} */ (err).code !== 'EEXIST') throw err;
        }
    }
}

/**
 * @param {string} file
 * @param {string | Buffer} data
 */
function writeBackupFile(file, data) {
    const fd = fs.openSync(file, 'wx');
    try {
        fs.writeSync(fd, data);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
}

// ---------------------------------------------------------------------------
//  Run
// ---------------------------------------------------------------------------

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
 * @param {Date} [options.now]
 * @returns {Promise<number>} Process exit code: 0 done, 1 something refused.
 */
export async function runCleanup(options) {
    const { dataRoot, handle, apply, serverStopped, Database } = options;
    const log = options.log ?? console.log;
    const warn = options.warn ?? console.warn;
    const probeServer = options.probeServer ?? probeConfiguredServer;
    const root = path.join(dataRoot, handle);
    const dirs = userDirectories(root);
    const treePath = path.join(root, 'message-tree.sqlite');
    const metaPath = path.join(root, 'character-metadata.sqlite');
    const mode = apply ? 'real run' : 'dry run';

    log(`${LOG_PREFIX} ${mode} for ${root}`);
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
    if (!fs.existsSync(treePath)) {
        warn(`${LOG_PREFIX} REFUSED: ${treePath} does not exist`);
        return 1;
    }

    // Read-only planning; every connection is closed before anything is written.
    const groupPlan = planGroupFile(dirs);
    const characterFileExists = fs.existsSync(path.join(dirs.characters, `${STRAY_OWNER}.png`));
    let marker;
    let groupRow = null;
    let characterRowExists = false;
    const meta = fs.existsSync(metaPath) ? openReadOnly(Database, metaPath) : null;
    try {
        marker = checkMarker(meta);
        groupRow = readGroupRow(meta);
        if (meta && meta.get('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'characters\' LIMIT 1')) {
            characterRowExists = !!meta.get('SELECT id FROM characters WHERE id = @id LIMIT 1', { id: `${STRAY_OWNER}.png` });
        }
    } finally {
        meta?.close();
    }
    let repointPlan;
    let strayPlan;
    const tree = wrap(openNativeTreeDatabase(Database, treePath, { readonly: true, fileMustExist: true }));
    try {
        repointPlan = planRepoint(tree);
        strayPlan = planStrayOwner(tree, { characterFileExists, characterRowExists });
    } finally {
        tree.close();
    }
    if (groupPlan.status === 'change') groupPlan.lines.push(...describeGroupRowChange(groupRow, groupPlan.newGroup));

    const items = [['1. group file', groupPlan], ['2. anchor default', repointPlan], ['3. zztestchar rows', strayPlan]];
    const verb = { change: apply ? 'CHANGE' : 'WOULD CHANGE', done: 'ALREADY DONE', refused: 'REFUSED' };
    for (const [name, plan] of /** @type {[string, ItemPlan][]} */ (items)) {
        const out = plan.status === 'refused' ? warn : log;
        out(`${LOG_PREFIX} ${name}: ${verb[plan.status]}${plan.reason ? ` - ${plan.reason}; left untouched` : ''}`);
        plan.lines.forEach(line => out(`${LOG_PREFIX}   ${line}`));
    }
    const anyRefused = items.some(([, plan]) => plan.status === 'refused');
    const anyChange = items.some(([, plan]) => plan.status === 'change');

    if (!apply) {
        log(`${LOG_PREFIX} real-run schema check: ${marker.ok ? 'ok' : `would refuse (${marker.detail}): ${MARKER_MISSING_MESSAGE}`}`);
        log(`${LOG_PREFIX} dry run: nothing was written.`);
        return anyRefused ? 1 : 0;
    }
    if (!marker.ok) {
        warn(`${LOG_PREFIX} REFUSED: ${marker.detail}; ${MARKER_MISSING_MESSAGE}`);
        return 1;
    }
    if (!anyChange) {
        log(`${LOG_PREFIX} nothing to change; nothing was written.`);
        return anyRefused ? 1 : 0;
    }

    const backupDir = createBackupDir(dirs, options.now ?? new Date());
    log(`${LOG_PREFIX} backups: ${backupDir}`);
    let failed = false;

    if (strayPlan.status === 'change') await queueStrayOwnerChatStats(dirs, warn);
    if (repointPlan.status === 'change' || strayPlan.status === 'change') {
        failed = !applyTree({ Database, treePath, backupDir, repoint: repointPlan.status === 'change', stray: strayPlan.status === 'change', characterFileExists, characterRowExists, log, warn });
    }
    if (groupPlan.status === 'change') {
        failed = !(await applyGroup({ dirs, metaPath, groupPlan, groupRow, backupDir, log, warn })) || failed;
    }
    return anyRefused || failed ? 1 : 0;
}

/**
 * Item 3 deletes messages without going through the owner write hook, so any row holding the owner's chat stats is
 * queued to be counted again on the next server start. Queued before the delete, so a crash can't lose it.
 * @param {object} dirs
 * @param {(line: string) => void} warn
 */
async function queueStrayOwnerChatStats(dirs, warn) {
    const { openOwnerChatStatsQueue, disposeMetadataStores } = await import('../character-metadata-db.js');
    try {
        const queue = await openOwnerChatStatsQueue(/** @type {import('../users.js').UserDirectoryList} */ (dirs), { existingOnly: true });
        queue?.(STRAY_OWNER);
    } catch (err) {
        warn(`${LOG_PREFIX} 3. zztestchar rows: queueing their owner's chat stats to be counted again failed: ${err.message}`);
    } finally {
        disposeMetadataStores();
    }
}

/**
 * Both tree items in one IMMEDIATE transaction: re-verified on the write connection, rows backed up, then changed.
 * @returns {boolean} Whether it committed.
 */
function applyTree({ Database, treePath, backupDir, repoint, stray, characterFileExists, characterRowExists, log, warn }) {
    const db = wrap(openNativeTreeDatabase(Database, treePath, { fileMustExist: true }));
    try {
        db.exec('BEGIN IMMEDIATE');
        try {
            if (repoint && planRepoint(db).status !== 'change') throw new Error('anchor state changed since planning');
            if (stray && planStrayOwner(db, { characterFileExists, characterRowExists }).status !== 'change') throw new Error('zztestchar rows changed since planning');

            const ids = [...(repoint ? [GROUP_ANCHOR_ID] : []), ...(stray ? [STRAY_ANCHOR_ID, STRAY_CHILD_ID] : [])];
            const rows = ids.map(id => getMessage(db, id));
            writeBackupFile(path.join(backupDir, 'message-tree-rows.json'), JSON.stringify({ database: treePath, rows }, null, 4));

            if (repoint) {
                const changes = swapDefaultChildSync(db, { id: GROUP_ANCHOR_ID, ownerId: GROUP_ID, from: HI_GROUP_ID, to: IVY_OPENING_ID });
                if (changes !== 1) throw new Error(`anchor update changed ${changes} rows`);
            }
            if (stray) {
                // One statement, so the anchor's default_child_id reference to the child never dangles mid-way.
                const changes = deleteNodesSync(db, STRAY_OWNER, [STRAY_ANCHOR_ID, STRAY_CHILD_ID]);
                if (changes !== 2) throw new Error(`delete removed ${changes} rows`);
            }
            db.exec('COMMIT');
        } catch (err) {
            db.exec('ROLLBACK');
            throw err;
        }
    } catch (err) {
        warn(`${LOG_PREFIX} REFUSED message-tree changes, nothing changed there: ${err.message}`);
        return false;
    } finally {
        db.close();
    }
    if (repoint) log(`${LOG_PREFIX} 2. anchor default: changed to Ivy's opening`);
    if (stray) log(`${LOG_PREFIX} 3. zztestchar rows: removed`);
    return true;
}

/**
 * @returns {Promise<boolean>}
 */
async function applyGroup({ dirs, metaPath, groupPlan, groupRow, backupDir, log, warn }) {
    const current = fs.existsSync(groupPlan.filePath) ? fs.readFileSync(groupPlan.filePath, 'utf8') : null;
    if (current !== groupPlan.originalText) {
        warn(`${LOG_PREFIX} REFUSED group file: it changed since planning; left untouched`);
        return false;
    }
    writeBackupFile(path.join(backupDir, `group-${GROUP_ID}.json`), groupPlan.originalText);
    if (groupRow) {
        writeBackupFile(path.join(backupDir, 'character-metadata-groups-row.json'), JSON.stringify(groupRow, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 4));
    }
    const writeFile = () => writeFileAtomicSync(groupPlan.filePath, groupPlan.newText);
    // Opening the store would create it. A new store has no groups version log to add to: its index builds from the files.
    if (!fs.existsSync(metaPath)) {
        writeFile();
        log(`${LOG_PREFIX} 1. group file: chats updated; character-metadata.sqlite missing, digest write skipped`);
        return true;
    }
    const { writeGroupFileAndRow, disposeMetadataStores } = await import('../character-metadata-db.js');
    try {
        await writeGroupFileAndRow(dirs, groupPlan.newGroup, writeFile, { createIfMissing: false });
    } finally {
        disposeMetadataStores();
    }
    log(`${LOG_PREFIX} 1. group file: chats updated; ${groupRow ? 'groups row updated with it' : 'groups row missing, digest write skipped'}`);
    return true;
}

/**
 * @param {string[]} argv
 * @returns {{ dataRoot: string, handle: string, config: string, dryRun: boolean, apply: boolean, serverStopped: boolean, unknown: string[] }}
 */
export function parseArgs(argv) {
    const out = { dataRoot: './data', handle: 'default-user', config: './config.yaml', dryRun: false, apply: false, serverStopped: false, unknown: [] };
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
 * @param {Date} [deps.now]
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
    return runCleanup({ ...deps, dataRoot: args.dataRoot, handle: args.handle, apply: args.apply, serverStopped: args.serverStopped });
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    const args = parseArgs(process.argv.slice(2));
    setConfigFilePath(args.config);
    const { getBetterSqlite3 } = await import('../endpoints/native-sqlite.js');
    const Database = await getBetterSqlite3();
    process.exitCode = await main(process.argv.slice(2), { Database });
}
