import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { color } from './util.js';
import { getSqliteEngine } from './endpoints/sqlite-engine.js';

/**
 * Tree-structured message storage: one `messages` table, no swipe arrays — every alternative is a
 * sibling row sharing `parent_id`, and a "chat" is a `label` on a message plus its `default_child_id`
 * chain. Nothing is ever deleted or reparented; every owner has one synthetic anchor row (`parent_id
 * IS NULL`) as the uniform root. `*Branch*` exports are label+anchor adapters for chats.js/characters.js.
 */

const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS messages (
        id               TEXT PRIMARY KEY,
        parent_id        TEXT REFERENCES messages(id),
        owner_id         TEXT NOT NULL,
        content          TEXT NOT NULL,
        label            TEXT,
        created_at       INTEGER NOT NULL,
        default_child_id TEXT REFERENCES messages(id),
        metadata         TEXT,
        -- sha1 of nodeIdentityKey(parent, speaker, text); hashed instead of indexed directly to keep the index small.
        identity_hash    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_parent      ON messages(parent_id);
    CREATE INDEX IF NOT EXISTS idx_messages_owner       ON messages(owner_id);
    CREATE INDEX IF NOT EXISTS idx_messages_owner_label ON messages(owner_id, label) WHERE label IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_messages_anchor      ON messages(owner_id) WHERE parent_id IS NULL;

    CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
    );
`;

/** SQL to walk from a leaf to the root via recursive CTE, returning the path in root-to-leaf order. */
const PATH_CTE_SQL = `
    WITH RECURSIVE path(id, parent_id, owner_id, content, label, created_at, default_child_id, metadata, depth) AS (
        SELECT id, parent_id, owner_id, content, label, created_at, default_child_id, metadata, 0
        FROM messages WHERE id = @leafId
        UNION ALL
        SELECT m.id, m.parent_id, m.owner_id, m.content, m.label, m.created_at, m.default_child_id, m.metadata, p.depth + 1
        FROM messages m JOIN path p ON m.id = p.parent_id
    )
    SELECT id, parent_id, owner_id, content, label, created_at, default_child_id, metadata FROM path ORDER BY depth DESC
`;

/** Content of the synthetic anchor row; a recognizable one-key object since it has no schema column of its own. */
export const ANCHOR_CONTENT = '{"__anchor":true}';

/** How many alternatives either side of the selected one are sent inline with a chat load. */
const ALTERNATIVE_WINDOW = 5;

function isAnchorRow(row) {
    return !!row && row.parent_id === null;
}

// ---------------------------------------------------------------------------
//  Per-user DB handles (same pattern as chat-metadata-db.js)
// ---------------------------------------------------------------------------

/** @type {Map<string, { db: import('./endpoints/sqlite-engine.js').SqliteEngineHandle }>} */
const entries = new Map();
let warnedNoEngine = false;

function getDbPath(directories) {
    return path.join(directories.root, 'message-tree.sqlite');
}

async function getEntry(directories) {
    const key = directories.root;
    const existing = entries.get(key);
    if (existing) return existing;

    const engine = await getSqliteEngine();
    if (!engine) {
        if (!warnedNoEngine) {
            warnedNoEngine = true;
            console.error(color.red('[message-tree] No usable SQLite backend — tree storage unavailable, falling back to JSONL.'));
        }
        return null;
    }

    if (!fs.existsSync(directories.root)) {
        fs.mkdirSync(directories.root, { recursive: true });
    }
    const db = engine.openDatabase(getDbPath(directories));
    db.exec(SCHEMA_SQL);
    migrateIdentityHashSync(db);
    const entry = { db };
    entries.set(key, entry);
    return entry;
}

/**
 * Backfills identity_hash and adds its unique index. Kept out of SCHEMA_SQL since the index can't be
 * created before the column exists. If duplicates block the index, the store still opens (unconstrained
 * beats unreadable) and logs how many groups collide.
 */
function migrateIdentityHashSync(db) {
    const columns = new Set(db.all('PRAGMA table_info(messages)').map(c => c.name));
    if (!columns.has('identity_hash')) {
        db.exec('ALTER TABLE messages ADD COLUMN identity_hash TEXT');
    }

    const pending = db.all('SELECT id, parent_id, content FROM messages WHERE parent_id IS NOT NULL AND identity_hash IS NULL');
    if (pending.length) {
        db.transaction(() => {
            for (const row of pending) {
                db.run('UPDATE messages SET identity_hash = @hash WHERE id = @id',
                    { id: row.id, hash: identityHashOf(row.parent_id, row.content) });
            }
        });
    }

    try {
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_identity ON messages(identity_hash) WHERE parent_id IS NOT NULL');
    } catch (error) {
        const clashing = db.get('SELECT COUNT(*) AS c FROM (SELECT identity_hash FROM messages WHERE identity_hash IS NOT NULL AND parent_id IS NOT NULL GROUP BY identity_hash HAVING COUNT(*) > 1)');
        console.error(`[message-tree] Identity constraint not applied: ${clashing?.c ?? '?'} groups of rows are duplicates of each other. They must be merged before the database can hold this rule.`, error);
    }
}

// ---------------------------------------------------------------------------
//  Content <-> alternatives
// ---------------------------------------------------------------------------

function newId() {
    return crypto.randomUUID();
}

/** Strips tree-internal fields before storing; swipe fields too, since every alternative is its own sibling row. */
function sanitizeForStorage(msg) {
    const clone = { ...msg };
    delete clone.node_id;
    delete clone.swipes;
    delete clone.swipe_id;
    delete clone.swipe_info;
    delete clone.swipe_speaker_default;
    delete clone._unchanged;

    if (clone.extra && typeof clone.extra === 'object') {
        clone.extra = { ...clone.extra };
        // sibling rows are the branches now
        delete clone.extra.branches;
        // bookmark_link becomes the label column
        delete clone.extra.bookmark_link;
    }

    return JSON.stringify(clone);
}

// Mirrors public/scripts/constants.js's MEDIA_TYPE/MEDIA_SOURCE enum VALUES only (not imported - this
// is a server module and those constants live in a client-only file) - used solely to reject a
// `media[].type`/`media[].source` value that isn't one of the client's own known enum members.
const KNOWN_MEDIA_TYPES = ['image', 'video', 'audio'];
const KNOWN_MEDIA_SOURCES = ['api', 'upload', 'generated', 'captioned'];
// Defensive caps - a client asserting thousands of attachment entries onto a single message has no
// legitimate use case; this is not a hard product limit, just a sane bound on this one payload shape.
const MAX_USER_MESSAGE_EXTRA_ENTRIES = 50;

/**
 * Allowlists/validates a CLIENT-SUPPLIED `extra` payload for a new user message before it is ever
 * persisted or handed to prompt assembly - the trust-boundary step `sanitizeForStorage()` above does
 * NOT perform (that function protects storage/round-trip integrity for `extra` values the SERVER
 * itself already trusts, e.g. read back off disk or built from an already-validated tree row; this
 * function is the thing that decides whether a brand-new, client-asserted `extra` is safe to accept
 * in the first place).
 *
 * Real, narrow use case this exists for: the raw-action `/generate` routes (text-completion and
 * chat-completion) let the client forward a REFERENCE to a file/media attachment it already uploaded
 * via the existing `/api/files/upload`/`saveBase64AsFile()` flow (see public/scripts/chats.js's
 * `populateFileAttachment()`) - the client sends only `{url, ...}` metadata, never file bytes, but
 * that metadata is still attacker-controlled input from an authenticated client and must not be
 * stored/forwarded verbatim.
 *
 * Only the following shape survives; everything else (unknown top-level keys, wrong-typed fields,
 * malformed array entries) is silently dropped rather than rejected outright, matching this
 * codebase's general "a bad/foreign field doesn't fail the whole request" stance (see e.g.
 * `resolveName2AndGroupMemberNames()`'s own "a missing/corrupt file is skipped, not fatal" doc
 * comment elsewhere in this codebase):
 * - `files`: array of `{url: string, size?: number, name?: string, created?: number}` - entries
 *   missing a non-empty string `url`, or with a wrong-typed optional field, are dropped whole rather
 *   than partially kept (a half-validated entry is not obviously safer than dropping it).
 * - `media`: array of `{url: string, type?: 'image'|'video'|'audio', title?: string,
 *   source?: 'api'|'upload'|'generated'|'captioned'}` - entries missing a non-empty string `url`, or
 *   with a `type`/`source` outside the known enum, are dropped whole.
 * - `media_index`: a non-negative integer strictly less than the (already-filtered) `media` array's
 *   length - out-of-range or non-integer values are dropped (omitted) rather than clamped, since a
 *   clamped index would silently point at a different attachment than the one the client meant.
 * - `inline_image`: boolean.
 * Both arrays are capped at `MAX_USER_MESSAGE_EXTRA_ENTRIES` entries (excess entries dropped from the
 * end) - a defensive bound, not a documented product limit.
 *
 * @param {unknown} extra Raw, untrusted value from the request body (may be anything - not assumed
 *   to already be an object).
 * @returns {{files?: object[], media?: object[], media_index?: number, inline_image?: boolean}} A
 *   fresh object containing only the validated fields above. Never throws; a completely invalid
 *   input yields `{}`.
 */
export function sanitizeUserMessageExtra(extra) {
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
        return {};
    }

    const result = {};

    if (Array.isArray(extra.files)) {
        const files = extra.files
            .slice(0, MAX_USER_MESSAGE_EXTRA_ENTRIES)
            .filter(file => file && typeof file === 'object' && typeof file.url === 'string' && file.url.length > 0)
            .map(file => {
                const entry = { url: file.url };
                if (typeof file.size === 'number' && Number.isFinite(file.size)) entry.size = file.size;
                if (typeof file.name === 'string') entry.name = file.name;
                if (typeof file.created === 'number' && Number.isFinite(file.created)) entry.created = file.created;
                return entry;
            });
        if (files.length) result.files = files;
    }

    if (Array.isArray(extra.media)) {
        const media = extra.media
            .slice(0, MAX_USER_MESSAGE_EXTRA_ENTRIES)
            .filter(item => item && typeof item === 'object' && typeof item.url === 'string' && item.url.length > 0
                && (item.type === undefined || KNOWN_MEDIA_TYPES.includes(item.type))
                && (item.source === undefined || KNOWN_MEDIA_SOURCES.includes(item.source)))
            .map(item => {
                const entry = { url: item.url };
                if (typeof item.type === 'string') entry.type = item.type;
                if (typeof item.title === 'string') entry.title = item.title;
                if (typeof item.source === 'string') entry.source = item.source;
                return entry;
            });
        if (media.length) result.media = media;
    }

    if (typeof extra.media_index === 'number' && Number.isInteger(extra.media_index)
        && extra.media_index >= 0 && Array.isArray(result.media) && extra.media_index < result.media.length) {
        result.media_index = extra.media_index;
    }

    if (typeof extra.inline_image === 'boolean') {
        result.inline_image = extra.inline_image;
    }

    return result;
}

/**
 * Expands one incoming message into its ordered sibling rows. A `swipes` array of length N becomes N
 * alternatives, each folding in its `swipe_info[i]` (send_date/extra) since there's nowhere else for
 * that per-alternative data to live once the array is gone. No swipes array means a single alternative.
 */
function alternativesFromMessage(msg) {
    const rawSwipes = Array.isArray(msg?.swipes) ? msg.swipes : null;
    if (!rawSwipes || rawSwipes.length === 0) {
        return { contents: [sanitizeForStorage(msg)], selected: 0, origIndices: [0], nodeIds: [msg?.node_id ?? null] };
    }

    // A hole means "not sent to the client", not "delete it" — skip it, but keep `origIndex` so
    // position-matching callers still see its original slot in the sparse `swipes` array.
    const rawSel = Number.isInteger(msg.swipe_id) ? msg.swipe_id : 0;
    const rawInfo = Array.isArray(msg.swipe_info) ? msg.swipe_info : [];
    const kept = [];
    for (let i = 0; i < rawSwipes.length; i++) {
        if (typeof rawSwipes[i] !== 'string') continue;
        kept.push({
            text: rawSwipes[i],
            info: rawInfo[i],
            wasSelected: i === rawSel,
            origIndex: i,
            // Only slots the client actually received carry a node id; a fabricated slot can't claim an existing row.
            nodeId: (rawInfo[i] && typeof rawInfo[i] === 'object' && rawInfo[i].node_id)
                ? rawInfo[i].node_id
                : (i === rawSel ? (msg?.node_id ?? null) : null),
        });
    }
    if (kept.length === 0) {
        return { contents: [sanitizeForStorage(msg)], selected: 0, origIndices: [0], nodeIds: [msg?.node_id ?? null] };
    }
    const swipes = kept.map(k => k.text);
    const info = kept.map(k => k.info);
    let selIdx = kept.findIndex(k => k.wasSelected);
    if (selIdx < 0) selIdx = 0;

    const def = msg.swipe_speaker_default;
    const defName = def && def.name !== undefined ? def.name : msg.name;
    const defIsUser = def ? !!def.is_user : !!msg.is_user;

    const contents = swipes.map((text, i) => {
        const alt = { ...msg };
        alt.mes = text;
        alt.name = defName;
        alt.is_user = defIsUser;
        const inf = info[i];
        if (inf && typeof inf === 'object') {
            if (inf.send_date !== undefined) alt.send_date = inf.send_date;
            if (inf.extra && typeof inf.extra === 'object') {
                alt.extra = { ...(msg.extra || {}), ...inf.extra };
            }
            if (inf.gen_started !== undefined) alt.gen_started = inf.gen_started;
            if (inf.gen_finished !== undefined) alt.gen_finished = inf.gen_finished;
            if (inf.name !== undefined) alt.name = inf.name;
            if (inf.is_user !== undefined) alt.is_user = !!inf.is_user;
        }
        return sanitizeForStorage(alt);
    });

    let selected = selIdx;
    if (selected < 0 || selected >= contents.length) selected = 0;
    const origIndices = kept.map(k => k.origIndex);
    const nodeIds = kept.map(k => k.nodeId);
    return { contents, selected, origIndices, nodeIds };
}

/** Rebuilds the client-facing message object for a node, re-synthesizing swipe arrays from sibling rows. */
function rowToMessage(row, siblings) {
    const msg = JSON.parse(row.content);
    msg.node_id = row.id;

    if (siblings && siblings.length > 1) {
        // Sent at full length but with holes (only a window around selected carries text) so
        // swipes.length/swipe_id keep working everywhere unchanged; text fills in on demand via /api/chats/alternatives.
        const idx = siblings.findIndex(s => s.id === row.id);
        const selected = idx < 0 ? 0 : idx;

        msg.swipes = new Array(siblings.length).fill(null);
        msg.swipe_info = new Array(siblings.length).fill(null);
        msg.swipe_id = selected;

        const from = Math.max(0, selected - ALTERNATIVE_WINDOW);
        const to = Math.min(siblings.length, selected + ALTERNATIVE_WINDOW + 1);
        for (let i = from; i < to; i++) {
            let o = {};
            try { o = JSON.parse(siblings[i].content); } catch { o = {}; }
            msg.swipes[i] = o?.mes ?? '';
            msg.swipe_info[i] = {
                send_date: o?.send_date, extra: o?.extra ?? {},
                name: o?.name, is_user: !!o?.is_user, node_id: siblings[i].id,
            };
        }
    }

    if (row.label) {
        if (!msg.extra || typeof msg.extra !== 'object') msg.extra = {};
        msg.extra.bookmark_link = row.label;
    }
    return msg;
}

/** nodeIdentityKey() reduced to a fixed-width digest, for the identity_hash column/index. */
export function identityHashOf(parentId, contentJson) {
    return crypto.createHash('sha1').update(nodeIdentityKey(parentId, contentJson)).digest('base64');
}

// A node's identity among siblings is (parent, speaker, text); a token count or send_date difference
// doesn't make two otherwise-identical alternatives different messages.
export function nodeIdentityKey(parentId, contentJson) {
    let speaker = '';
    let mes = '';
    try {
        const o = JSON.parse(contentJson);
        // A user message's speaker is the persona (avatar id) it was said as, not its name — two personas can share a name.
        speaker = o?.is_user
            ? 'u\u0001' + (o?.persona ?? o?.name ?? '')
            : 'c\u0001' + (o?.name ?? '');
        mes = o?.mes ?? '';
    } catch {
        speaker = '?';
        mes = contentJson;
    }
    return parentId + '\u0000' + speaker + '\u0000' + crypto.createHash('sha1').update(String(mes)).digest('base64');
}

function extractLastMes(contentJson) {
    try {
        return JSON.parse(contentJson)?.mes || null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
//  Core row operations (synchronous)
// ---------------------------------------------------------------------------

function insertMessageSync(db, { id, parentId, ownerId, content, label, createdAt, defaultChildId, metadata }) {
    db.run(
        `INSERT INTO messages (id, parent_id, owner_id, content, label, created_at, default_child_id, metadata, identity_hash)
         VALUES (@id, @parentId, @ownerId, @content, @label, @createdAt, @defaultChildId, @metadata, @identityHash)`,
        {
            id,
            parentId: parentId ?? null,
            identityHash: parentId ? identityHashOf(parentId, content) : null,
            ownerId,
            content,
            label: label ?? null,
            createdAt,
            defaultChildId: defaultChildId ?? null,
            metadata: metadata ?? null,
        },
    );
}

/** True when writing `incoming` over `stored` would replace real message text with nothing — a sign the client echoed an unloaded slot rather than a genuine edit. */
function wouldBlankStoredText(stored, incoming) {
    const mesOf = (json) => {
        try { return JSON.parse(json)?.mes ?? ''; } catch { return ''; }
    };
    return mesOf(stored).length > 0 && mesOf(incoming).length === 0;
}

function updateMessageContentSync(db, id, content) {
    const row = db.get('SELECT parent_id FROM messages WHERE id = @id', { id });
    const identityHash = row?.parent_id ? identityHashOf(row.parent_id, content) : null;
    db.run('UPDATE messages SET content = @content, identity_hash = @identityHash WHERE id = @id',
        { id, content, identityHash });
}

function labelMessageSync(db, id, label) {
    db.run('UPDATE messages SET label = @label WHERE id = @id', { id, label });
}

function setMetadataSync(db, id, metadata) {
    db.run('UPDATE messages SET metadata = @metadata WHERE id = @id', { id, metadata });
}

/** Pulls the `integrity` slug out of a row's raw metadata JSON, or null if there isn't one yet. */
function readIntegritySync(row) {
    if (!row?.metadata) return null;
    try {
        const parsed = JSON.parse(row.metadata);
        return typeof parsed?.integrity === 'string' ? parsed.integrity : null;
    } catch {
        return null;
    }
}

/** Points a parent at one of its children as the shown continuation. Touches exactly this one row. */
function setDefaultChildSync(db, parentId, childId) {
    if (!parentId || !childId) return false;
    // Must be a genuine child — refuse rather than leave a parent pointing outside its own subtree.
    const child = db.get('SELECT parent_id FROM messages WHERE id = @childId', { childId });
    if (!child || child.parent_id !== parentId) return false;
    db.run('UPDATE messages SET default_child_id = @childId WHERE id = @parentId', { parentId, childId });
    return true;
}

/** Walks from `leafId` to the root, returning rows in root-to-leaf order (anchor included). */
function getPathSync(db, leafId) {
    return db.all(PATH_CTE_SQL, { leafId });
}

/** Immediate children of a message, deterministically ordered. */
function getChildrenSync(db, messageId) {
    return db.all(
        `SELECT id, parent_id, content, label, created_at, default_child_id
         FROM messages WHERE parent_id = @messageId ORDER BY created_at ASC, id ASC`,
        { messageId },
    );
}

// ---------------------------------------------------------------------------
//  Anchor + default-child navigation
// ---------------------------------------------------------------------------

/** The owner's single synthetic anchor row, or undefined. */
function getAnchorSync(db, ownerId) {
    return db.get(
        'SELECT * FROM messages WHERE owner_id = @ownerId AND parent_id IS NULL ORDER BY created_at ASC, id ASC LIMIT 1',
        { ownerId },
    );
}

/** Returns the owner's anchor, creating it if this owner has none yet. */
function ensureAnchorSync(db, ownerId, now) {
    const existing = getAnchorSync(db, ownerId);
    if (existing) return existing;
    const id = newId();
    insertMessageSync(db, {
        id, parentId: null, ownerId, content: ANCHOR_CONTENT, createdAt: now ?? Date.now(),
    });
    return getAnchorSync(db, ownerId);
}

/** Follows `default_child_id` down until a row has none set (or points nowhere); guarded against cycles. */
function descendDefaultSync(db, nodeId) {
    let current = nodeId;
    const seen = new Set([current]);
    for (;;) {
        const row = db.get('SELECT default_child_id FROM messages WHERE id = @id', { id: current });
        const next = row?.default_child_id;
        if (!next || seen.has(next)) return current;
        const exists = db.get('SELECT 1 AS ok FROM messages WHERE id = @id', { id: next });
        if (!exists) return current;
        seen.add(next);
        current = next;
    }
}

/** First node from `nodeId` downwards with no label, or null if every one is already some chat's entry point. */
function firstUnlabeledOnPathSync(db, nodeId) {
    let current = nodeId;
    const seen = new Set();
    while (current && !seen.has(current)) {
        seen.add(current);
        const row = db.get('SELECT label, default_child_id FROM messages WHERE id = @id', { id: current });
        if (!row) return null;
        if (!row.label) return current;
        current = row.default_child_id;
    }
    return null;
}

/** Ordered siblings of a node (rows sharing its parent), including the node itself. */
function getSiblingsSync(db, parentId, nodeId) {
    if (!parentId) {
        return db.all('SELECT id, content FROM messages WHERE id = @nodeId', { nodeId });
    }
    return db.all(
        'SELECT id, content FROM messages WHERE parent_id = @parentId ORDER BY created_at ASC, id ASC',
        { parentId },
    );
}

// ---------------------------------------------------------------------------
//  Labeled nodes ("branches") — adapter layer
// ---------------------------------------------------------------------------

/** Synthesizes the branch-shaped object src/endpoints/*.js expects out of a labeled node; computed, never stored. */
function branchViewSync(db, node) {
    const leafId = descendDefaultSync(db, node.id);
    const leaf = leafId === node.id ? node : db.get('SELECT id, content, created_at FROM messages WHERE id = @id', { id: leafId });
    const countRow = db.get(`
        WITH RECURSIVE up(id, parent_id) AS (
            SELECT id, parent_id FROM messages WHERE id = @leafId
            UNION ALL
            SELECT m.id, m.parent_id FROM messages m JOIN up u ON m.id = u.parent_id
        )
        SELECT count(*) AS c FROM up WHERE parent_id IS NOT NULL
    `, { leafId });

    let meta = null;
    let isGroup = 0;
    if (node.metadata) {
        meta = node.metadata;
        try { isGroup = JSON.parse(node.metadata)?.__is_group ? 1 : 0; } catch { /* keep 0 */ }
    }

    return {
        id: node.id,
        owner_id: node.owner_id,
        leaf_id: leafId,
        name: node.label,
        is_group: isGroup,
        metadata: meta,
        message_count: countRow?.c ?? 0,
        last_mes: leaf ? extractLastMes(leaf.content) : null,
        created_at: node.created_at,
        // Last activity, not label creation time — created_at never moves, so sorting "recent" by it would freeze at bookmark time.
        last_activity: leaf?.created_at ?? node.created_at,
    };
}

/** Finds the labeled node carrying this chat name; ties broken by (created_at, id) for deterministic repeated calls. */
function getLabeledNodeSync(db, ownerId, name) {
    return db.get(
        'SELECT * FROM messages WHERE owner_id = @ownerId AND label = @name ORDER BY created_at ASC, id ASC LIMIT 1',
        { ownerId, name },
    );
}

function listLabeledNodesSync(db, ownerId) {
    return db.all(
        'SELECT * FROM messages WHERE owner_id = @ownerId AND label IS NOT NULL ORDER BY created_at ASC, id ASC',
        { ownerId },
    );
}

/** Back-compat name: returns a branch-shaped view of the labeled node, or undefined. */
function getBranchByNameSync(db, ownerId, name) {
    const node = getLabeledNodeSync(db, ownerId, name);
    return node ? branchViewSync(db, node) : undefined;
}

/** Back-compat name: does this owner have any listable chat at all? */
function hasBranchesSync(db, ownerId) {
    return !!db.get('SELECT 1 AS ok FROM messages WHERE owner_id = @ownerId AND label IS NOT NULL LIMIT 1', { ownerId });
}

/** Back-compat name: labels the node and parks chat metadata on it — there's no separate branch record anymore. */
function createBranchSync(db, { leafId, name, isGroup, metadata }) {
    let metaJson = metadata ?? null;
    if (isGroup) {
        let obj = {};
        try { obj = metaJson ? JSON.parse(metaJson) : {}; } catch { obj = {}; }
        obj.__is_group = true;
        metaJson = JSON.stringify(obj);
    }
    db.run('UPDATE messages SET label = @name, metadata = @metaJson WHERE id = @leafId', { leafId, name, metaJson });
}

// ---------------------------------------------------------------------------
//  Fork-point / sibling detection
// ---------------------------------------------------------------------------

/** For each immediate child of `messageId`, the labeled nodes reachable in that child's subtree. */
function getForkSiblingsSync(db, messageId) {
    // One walk of the whole subtree carrying which immediate child each row descends through, rather than one walk per child.
    const rows = db.all(`
        WITH RECURSIVE sub(id, root_child, label) AS (
            SELECT id, id, label FROM messages WHERE parent_id = @messageId
            UNION ALL
            SELECT m.id, s.root_child, m.label FROM messages m JOIN sub s ON m.parent_id = s.id
        )
        SELECT id, root_child AS childId, label AS name FROM sub WHERE label IS NOT NULL
    `, { messageId });

    const byChild = new Map();
    for (const r of rows) {
        if (!byChild.has(r.childId)) byChild.set(r.childId, []);
        byChild.get(r.childId).push({ id: r.id, name: r.name });
    }
    return [...byChild.entries()].map(([childId, branches]) => ({ childId, branches }));
}

/**
 * Siblings for many nodes at once, keyed by parent id. One query instead of one per path node.
 * @returns {Map<string, { id: string, content: string }[]>}
 */
function getSiblingsBatchSync(db, parentIds) {
    const ids = [...new Set(parentIds.filter(Boolean))];
    const out = new Map();
    if (ids.length === 0) return out;
    const rows = db.all(
        `SELECT id, parent_id, content FROM messages WHERE parent_id IN (${ids.map((_, i) => '@p' + i).join(',')})
         ORDER BY created_at ASC, id ASC`,
        Object.fromEntries(ids.map((v, i) => ['p' + i, v])),
    );
    for (const r of rows) {
        if (!out.has(r.parent_id)) out.set(r.parent_id, []);
        out.get(r.parent_id).push({ id: r.id, content: r.content });
    }
    return out;
}

/**
 * Immediate child ids for many nodes at once, keyed by node id. One query instead of one per node.
 * @returns {Map<string, string[]>}
 */
function getChildIdsBatchSync(db, nodeIds) {
    const ids = [...new Set(nodeIds.filter(Boolean))];
    const out = new Map();
    if (ids.length === 0) return out;
    const rows = db.all(
        `SELECT id, parent_id FROM messages WHERE parent_id IN (${ids.map((_, i) => '@p' + i).join(',')})`,
        Object.fromEntries(ids.map((v, i) => ['p' + i, v])),
    );
    for (const r of rows) {
        if (!out.has(r.parent_id)) out.set(r.parent_id, []);
        out.get(r.parent_id).push(r.id);
    }
    return out;
}

// ---------------------------------------------------------------------------
//  High-level exported operations
// ---------------------------------------------------------------------------

/** @param {import('./users.js').UserDirectoryList} directories */
export async function isAvailable(directories) {
    return !!(await getEntry(directories));
}

/**
 * Has this owner got any saved chats — anything labelled? Says "this character has chat history",
 * not "this character's data lives in the tree" (that question is answered by isAvailable() alone).
 */
export async function hasSavedChats(directories, ownerId) {
    const entry = await getEntry(directories);
    if (!entry) return false;
    return hasBranchesSync(entry.db, ownerId);
}

/**
 * Turns a contiguous run of path rows into client-shaped messages: sibling windows, node ids, and
 * extra.branches on fork points that actually diverge. Shared by a full chat load and a continuation
 * fetch so the two never disagree about message shape.
 */
function buildPathMessages(db, rows, branchName = null) {
    const siblingsByParent = getSiblingsBatchSync(db, rows.map(r => r.parent_id));
    const messages = rows.map(r => rowToMessage(
        r,
        r.parent_id ? (siblingsByParent.get(r.parent_id) ?? [{ id: r.id, content: r.content }]) : [{ id: r.id, content: r.content }],
    ));

    const childIds = getChildIdsBatchSync(db, rows.map(r => r.id));
    for (let i = 0; i < rows.length; i++) {
        const kids = childIds.get(rows[i].id) ?? [];
        const nextOnPath = rows[i + 1]?.id;
        if (!kids.some(id => id !== nextOnPath)) continue;

        const names = [];
        for (const { branches } of getForkSiblingsSync(db, rows[i].id)) {
            for (const b of branches) {
                if (b.name && b.name !== branchName && !names.includes(b.name)) names.push(b.name);
            }
        }
        if (names.length > 0) {
            if (!messages[i].extra || typeof messages[i].extra !== 'object') messages[i].extra = {};
            messages[i].extra.branches = names;
        }
    }
    return messages;
}

/** Resolves a target that may be a node id (exact) or a legacy chat name (label lookup, not unique per owner — first sort wins). */
function resolveNodeOrName(db, ownerId, target) {
    return db.get('SELECT * FROM messages WHERE id = @id AND owner_id = @ownerId', { id: target, ownerId })
        ?? getLabeledNodeSync(db, ownerId, target);
}

/** Loads a chat as the flat message array the client expects: labeled node → descend default_child_id to the leaf → walk back to the anchor → drop the anchor. */
export async function loadBranch(directories, ownerId, branchName) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const node = getLabeledNodeSync(entry.db, ownerId, branchName);
    if (!node) return null;

    const leafId = descendDefaultSync(entry.db, node.id);
    const rows = getPathSync(entry.db, leafId).filter(r => !isAnchorRow(r));

    const messages = buildPathMessages(entry.db, rows, branchName);

    let metadata = {};
    if (node.metadata) {
        try { metadata = JSON.parse(node.metadata); } catch { metadata = {}; }
    }
    delete metadata.__is_group;

    return { messages, metadata, branch: branchViewSync(entry.db, node) };
}

/**
 * Saves a whole chat array into the tree. Backs /api/chats/save and /api/chats/group/save, which the
 * first-party frontend still calls directly for a chat's first save and for tree-chat snapshots.
 *
 * Existing rows are matched by `node_id`; anything without one becomes new rows chained off the last
 * resolved node. Alternatives are written as sibling rows, and the chosen one is pointed at via the
 * parent's `default_child_id` — no other `default_child_id` in the tree is touched.
 */
export async function saveChatToTree(directories, ownerId, chatName, chatData, isGroup = false) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    if (!Array.isArray(chatData) || chatData.length === 0) return null;

    const header = chatData[0];
    const messages = chatData.slice(1);
    const metadata = { ...(header?.chat_metadata || {}) };

    const nextIntegrity = crypto.randomUUID();
    metadata.integrity = nextIntegrity;
    delete metadata.main_chat;
    delete metadata.fork_point;
    delete metadata._tree_stored;
    if (isGroup) metadata.__is_group = true;
    const metadataJson = JSON.stringify(metadata);

    const now = Date.now();
    /** @type {{ index: number, node_id: string }[]} */
    const assignedNodeIds = [];

    entry.db.transaction(() => {
        const anchor = ensureAnchorSync(entry.db, ownerId, now);
        const existingNode = getLabeledNodeSync(entry.db, ownerId, chatName);

        let parentId = anchor.id;
        let firstId = null;

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];

            // Unchanged stub, or a message we already have: keep the row, just re-point the parent.
            if (msg.node_id) {
                const known = entry.db.get('SELECT id, parent_id, content, label FROM messages WHERE id = @id', { id: msg.node_id });
                if (known) {
                    if (!msg._unchanged && known.parent_id === parentId) {
                        const { contents, selected, nodeIds } = alternativesFromMessage(msg);
                        // Match incoming alternatives to existing siblings by POSITION (original swipe-array
                        // slot), not text identity, so an edit to a non-selected alternative updates its row
                        // in place instead of minting a new orphan each time. A slot with no existing row is new.
                        const sibs = getSiblingsSync(entry.db, known.parent_id, known.id);
                        const sibById = new Map(sibs.map(x => [x.id, x]));
                        let chosenId = known.id;

                        for (let k = 0; k < contents.length; k++) {
                            const c = contents[k];
                            const claimedId = nodeIds[k];
                            const existing = claimedId ? sibById.get(claimedId) : null;

                            let sid;
                            if (existing) {
                                sid = existing.id;
                                if (existing.content !== c && !wouldBlankStoredText(existing.content, c)) {
                                    // If the edit's text now matches a sibling exactly, the unique identity
                                    // index would refuse the update — move the slot onto that sibling instead.
                                    const twin = entry.db.get(
                                        'SELECT id FROM messages WHERE parent_id = @parentId AND identity_hash = @identity AND id != @id',
                                        { parentId, identity: identityHashOf(parentId, c), id: sid });
                                    if (twin) {
                                        sid = twin.id;
                                    } else {
                                        updateMessageContentSync(entry.db, sid, c);
                                    }
                                }
                            } else {
                                // No claimed id: this slot can't overwrite an existing row, but if a sibling
                                // already has this exact content it IS this message — reuse it rather than duplicate.
                                const twin = entry.db.get(
                                    'SELECT id FROM messages WHERE parent_id = @parentId AND identity_hash = @identity',
                                    { parentId, identity: identityHashOf(parentId, c) });
                                if (twin) {
                                    sid = twin.id;
                                } else {
                                    sid = newId();
                                    insertMessageSync(entry.db, {
                                        id: sid, parentId, ownerId, content: c, createdAt: now + k,
                                    });
                                }
                            }
                            if (k === selected) chosenId = sid;
                        }

                        const newLabel = msg.extra?.bookmark_link || null;
                        if (known.label !== newLabel && newLabel !== null) labelMessageSync(entry.db, chosenId, newLabel);
                        setDefaultChildSync(entry.db, parentId, chosenId);
                        if (!firstId) firstId = chosenId;
                        parentId = chosenId;
                        continue;
                    }
                    // Same path: reuse the row. If the chain diverged upstream, this row belongs to the
                    // old branch — fall through and write a fresh row under the new parent instead.
                    if (known.parent_id === parentId) {
                        setDefaultChildSync(entry.db, parentId, known.id);
                        if (!firstId) firstId = known.id;
                        parentId = known.id;
                        continue;
                    }
                }
            }

            if (msg._unchanged) continue; // stub for a row we can't resolve — nothing to write

            const { contents, selected } = alternativesFromMessage(msg);
            const existingSibs = getSiblingsSync(entry.db, parentId, '');
            const byContent = new Map(existingSibs.map(s => [nodeIdentityKey(parentId, s.content), s.id]));
            let chosenId = null;
            for (let k = 0; k < contents.length; k++) {
                const c = contents[k];
                const ck = nodeIdentityKey(parentId, c);
                let sid = byContent.get(ck);
                if (!sid) {
                    sid = newId();
                    insertMessageSync(entry.db, {
                        id: sid,
                        parentId,
                        ownerId,
                        content: c,
                        label: k === selected ? (msg.extra?.bookmark_link || null) : null,
                        // +k keeps sibling order == swipe order under the (created_at, id) sort.
                        createdAt: now + k,
                    });
                    byContent.set(ck, sid);
                }
                if (k === selected) chosenId = sid;
            }
            assignedNodeIds.push({ index: i, node_id: chosenId });
            setDefaultChildSync(entry.db, parentId, chosenId);
            if (!firstId) firstId = chosenId;
            parentId = chosenId;
        }

        if (existingNode) {
            setMetadataSync(entry.db, existingNode.id, metadataJson);
        } else if (firstId) {
            // Label the first message of the new chain. If that node is already another chat's entry
            // point (two chats can open on byte-identical messages, e.g. shared group greetings), labeling
            // it would silently rename the older chat away — instead take the first unlabeled node on this
            // chat's own path, or report failure if the whole path is already claimed.
            const target = firstUnlabeledOnPathSync(entry.db, firstId);
            if (target) {
                db_label(entry.db, target, chatName, metadataJson);
            } else {
                console.error(color.red(`[message-tree] Could not name chat "${chatName}" for ${ownerId}: every node on its path is already another chat's entry point. The messages are stored; the name is not.`));
            }
        }
    });

    return { integrity: nextIntegrity, assignedNodeIds };
}

function db_label(db, id, name, metadataJson) {
    db.run('UPDATE messages SET label = @name, metadata = @metadataJson WHERE id = @id', { id, name, metadataJson });
}

/** Creates a fork: purely a label on the fork-point node, resolving to the chain already below it. No rows copied or reparented. */
export async function forkBranch(directories, ownerId, forkAtNodeId, newBranchName, isGroup = false, metadata = {}) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const msg = entry.db.get('SELECT id FROM messages WHERE id = @id', { id: forkAtNodeId });
    if (!msg) return null;

    const clean = { ...metadata };
    delete clean.main_chat;
    delete clean.fork_point;
    clean.integrity = crypto.randomUUID();
    if (isGroup) clean.__is_group = true;

    entry.db.transaction(() => {
        db_label(entry.db, forkAtNodeId, newBranchName, JSON.stringify(clean));
    });

    return { branchId: forkAtNodeId, branchName: newBranchName };
}

/** All listable chats for an owner, as branch-shaped views. */
export async function listBranches(directories, ownerId) {
    const entry = await getEntry(directories);
    if (!entry) return [];
    return listLabeledNodesSync(entry.db, ownerId).map(n => branchViewSync(entry.db, n));
}

/**
 * The branches spoken in most recently, across every owner. Owners are shortlisted by newest message
 * first (one grouped scan), and only that shortlist pays for the per-branch leaf walk.
 */
export async function listRecentBranches(directories, max) {
    const entry = await getEntry(directories);
    if (!entry) return [];

    const limit = Math.max(1, Number(max) || 1);
    // Bounded independently of `limit` since callers may pass MAX_SAFE_INTEGER.
    const shortlist = Math.min(limit, 500);

    const owners = entry.db.all(
        'SELECT owner_id, MAX(created_at) AS t FROM messages GROUP BY owner_id ORDER BY t DESC LIMIT @shortlist',
        { shortlist },
    );

    const branches = [];
    for (const o of owners) {
        for (const node of listLabeledNodesSync(entry.db, o.owner_id)) {
            branches.push(branchViewSync(entry.db, node));
        }
    }

    branches.sort((a, b) => (b.last_activity ?? 0) - (a.last_activity ?? 0));
    return branches.slice(0, limit);
}

/**
 * Chats whose history contains all given fragments, or all chats when fragments is empty.
 * A chat matches when a matching message lies anywhere on its root-to-leaf path.
 */
export async function searchBranchesByContent(directories, ownerId, fragments) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const nodes = listLabeledNodesSync(entry.db, ownerId);
    const views = nodes.map(n => {
        const v = branchViewSync(entry.db, n);
        const leaf = entry.db.get('SELECT content FROM messages WHERE id = @id', { id: v.leaf_id });
        let sendDate = null;
        try { sendDate = leaf ? JSON.parse(leaf.content)?.send_date ?? null : null; } catch { /* ignore */ }
        return { ...v, leaf_send_date: sendDate };
    });

    if (fragments.length === 0) return views;

    const matched = [];
    for (const v of views) {
        const hit = entry.db.get(`
            WITH RECURSIVE up(id, parent_id, content) AS (
                SELECT id, parent_id, content FROM messages WHERE id = @leafId
                UNION ALL
                SELECT m.id, m.parent_id, m.content FROM messages m JOIN up u ON m.id = u.parent_id
            )
            SELECT 1 AS ok FROM up WHERE ${fragments.map((_, i) => `EXISTS (SELECT 1 FROM up WHERE lower(json_extract(content,'$.mes')) LIKE @frag${i})`).join(' AND ')} LIMIT 1
        `, { leafId: v.leaf_id, ...Object.fromEntries(fragments.map((f, i) => [`frag${i}`, `%${f}%`])) });
        if (hit) matched.push(v);
    }
    return matched;
}

/** "Deletes" a chat by clearing its label; nothing is removed, so its messages stay reachable from any other label. */
export async function deleteBranch(directories, ownerId, branchName) {
    const entry = await getEntry(directories);
    if (!entry) return false;
    const node = resolveNodeOrName(entry.db, ownerId, branchName);
    if (!node) return false;
    labelMessageSync(entry.db, node.id, null);
    return true;
}

export async function renameBranch(directories, ownerId, oldName, newName) {
    const entry = await getEntry(directories);
    if (!entry) return false;
    const node = resolveNodeOrName(entry.db, ownerId, oldName);
    if (!node) return false;
    labelMessageSync(entry.db, node.id, newName);
    return true;
}

/**
 * Labels (pins/checkpoints) any node. Pass null to clear.
 * @param {object} [options]
 * @param {string} [options.ownerId] Required when `unique` is true - scopes the collision check.
 * @param {boolean} [options.unique] If the label collides with an existing one for this owner,
 * suffix it " - Branch #N" (incrementing N) until it doesn't, instead of failing.
 * @returns {Promise<{ok: boolean, label?: string}>}
 */
export async function labelNode(directories, nodeId, label, { ownerId, unique = false } = {}) {
    const entry = await getEntry(directories);
    if (!entry) return { ok: false };
    const msg = entry.db.get('SELECT id FROM messages WHERE id = @id', { id: nodeId });
    if (!msg) return { ok: false };

    let resolvedLabel = label;
    if (unique && label && ownerId) {
        const existingLabels = new Set(listLabeledNodesSync(entry.db, ownerId).map(n => n.label));
        if (existingLabels.has(resolvedLabel)) {
            const baseLabel = String(label).replace(/ - Branch #\d+$/, '');
            let i = 1;
            while (existingLabels.has(`${baseLabel} - Branch #${i}`)) i++;
            resolvedLabel = `${baseLabel} - Branch #${i}`;
        }
    }

    labelMessageSync(entry.db, nodeId, resolvedLabel);
    return { ok: true, label: resolvedLabel };
}

/**
 * Ends the conversation at this node: clears its default_child_id so nothing shows after it. Children
 * and their subtrees are untouched — pointing default_child_id at one again brings it right back.
 */
export async function endPathAt(directories, ownerId, nodeId) {
    const entry = await getEntry(directories);
    if (!entry) return false;

    const node = entry.db.get('SELECT id FROM messages WHERE id = @id AND owner_id = @ownerId',
        { id: nodeId, ownerId });
    if (!node) return false;

    entry.db.run('UPDATE messages SET default_child_id = NULL WHERE id = @id', { id: nodeId });
    return true;
}

export async function selectDefaultChild(directories, childId) {
    const entry = await getEntry(directories);
    if (!entry) return false;

    const child = entry.db.get('SELECT id, parent_id FROM messages WHERE id = @id', { id: childId });
    if (!child || !child.parent_id) return false;

    setDefaultChildSync(entry.db, child.parent_id, childId);
    return true;
}

export async function getForkRing(directories, nodeId) {
    const entry = await getEntry(directories);
    if (!entry) return null;
    return getForkSiblingsSync(entry.db, nodeId);
}

/** The alternatives at a node: every row sharing its parent, in sibling order, with the index asked about. */
export async function getAlternatives(directories, nodeId, range = {}) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const node = entry.db.get('SELECT id, parent_id FROM messages WHERE id = @id', { id: nodeId });
    if (!node) return null;

    const siblings = node.parent_id
        ? entry.db.all(
            'SELECT id, content FROM messages WHERE parent_id = @p ORDER BY created_at ASC, id ASC',
            { p: node.parent_id })
        : [entry.db.get('SELECT id, content FROM messages WHERE id = @id', { id: nodeId })];

    const selected = siblings.findIndex(s => s.id === nodeId);
    const from = Math.max(0, range.offset ?? 0);
    const to = range.limit ? from + range.limit : siblings.length;

    const alternatives = siblings.slice(from, to).map(s => {
        let o = {};
        try { o = JSON.parse(s.content); } catch { /* leave empty */ }
        return {
            node_id: s.id,
            mes: o?.mes ?? '',
            send_date: o?.send_date,
            extra: o?.extra ?? {},
            name: o?.name,
            is_user: !!o?.is_user,
        };
    });

    return { selected: selected < 0 ? 0 : selected, total: siblings.length, alternatives };
}

/** Path from the owner's anchor down to `nodeId` by actual parentage (not default_child_id — a bookmark can sit off the default path). Returns messages root-to-node, oldest first; null if unknown. */
export async function getAncestorPath(directories, nodeId) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const node = entry.db.get('SELECT id FROM messages WHERE id = @id', { id: nodeId });
    if (!node) return null;

    const rows = getPathSync(entry.db, nodeId).filter(r => !isAnchorRow(r));
    return buildPathMessages(entry.db, rows, null);
}

/** The conversation below a node: follows default_child_id to the deepest leaf, in chat-load shape. Returns null when the node doesn't exist. */
export async function getContinuation(directories, nodeId, branchName = null) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const node = entry.db.get('SELECT id FROM messages WHERE id = @id', { id: nodeId });
    if (!node) return null;

    const leafId = descendDefaultSync(entry.db, nodeId);
    if (leafId === nodeId) return { messages: [] };

    const path = getPathSync(entry.db, leafId).filter(r => !isAnchorRow(r));
    const at = path.findIndex(r => r.id === nodeId);
    const rows = at < 0 ? [] : path.slice(at + 1);

    return { messages: buildPathMessages(entry.db, rows, branchName) };
}

// Each of the operations below names the row it acts on, rather than the client restating the whole path.

/** Edits one message's content in place. */
export async function editMessage(directories, ownerId, nodeId, content) {
    const entry = await getEntry(directories);
    if (!entry) return { ok: false, reason: 'unavailable' };
    return editMessageSync(entry.db, ownerId, nodeId, content);
}

/**
 * Applies many edits in one transaction rather than one request per message. A message the store
 * declines (would blank stored text, or collide with a sibling) is reported, not silently skipped,
 * and doesn't stop the others.
 */
export async function editMessages(directories, ownerId, edits) {
    const entry = await getEntry(directories);
    if (!entry) return { ok: false, applied: 0, refused: [] };

    const list = Array.isArray(edits) ? edits : [];
    let applied = 0;
    const refused = [];

    entry.db.transaction(() => {
        for (const edit of list) {
            const nodeId = String(edit?.node_id || '');
            if (!nodeId) continue;
            const result = editMessageSync(entry.db, ownerId, nodeId, edit.content);
            if (result.ok) applied++;
            else refused.push({ node_id: nodeId, reason: result.reason ?? 'refused' });
        }
    });

    return { ok: true, applied, refused };
}

/** The rules one edit follows, with no transaction of its own so a batch can hold them all. */
function editMessageSync(db, ownerId, nodeId, content) {
    const entry = { db };

    const row = entry.db.get('SELECT id, content FROM messages WHERE id = @id AND owner_id = @ownerId',
        { id: nodeId, ownerId });
    if (!row) return { ok: false, reason: 'unknown node' };

    const next = sanitizeForStorage(content);
    if (row.content === next) return { ok: true };
    if (wouldBlankStoredText(row.content, next)) return { ok: false, reason: 'refused to blank stored text' };

    // Would collide with a sibling's identity hash — report it instead of letting the unique index throw.
    const parent = entry.db.get('SELECT parent_id FROM messages WHERE id = @id', { id: nodeId })?.parent_id;
    if (parent) {
        const twin = entry.db.get(
            'SELECT id FROM messages WHERE parent_id = @parent AND identity_hash = @identity AND id != @id',
            { parent, identity: identityHashOf(parent, next), id: nodeId });
        if (twin) return { ok: false, reason: 'an alternative with this text already exists', node_id: twin.id };
    }

    updateMessageContentSync(entry.db, nodeId, next);
    return { ok: true };
}

/** Appends messages after a node, chaining each onto the last and pointing the fork at them. */
export async function appendMessages(directories, ownerId, afterNodeId, contents) {
    const entry = await getEntry(directories);
    if (!entry) return { ok: false, reason: 'unavailable' };
    if (!Array.isArray(contents) || contents.length === 0) return { ok: true, node_ids: [] };

    const anchor = entry.db.get('SELECT id FROM messages WHERE id = @id AND owner_id = @ownerId',
        { id: afterNodeId, ownerId });
    if (!anchor) return { ok: false, reason: 'unknown anchor' };

    const now = Date.now();
    const nodeIds = [];
    entry.db.transaction(() => {
        let cursor = afterNodeId;
        for (const c of contents) {
            const body = sanitizeForStorage(c);
            // A retry/double-send that matches an existing sibling lands on that row instead of duplicating.
            const twin = entry.db.get(
                'SELECT id FROM messages WHERE parent_id = @parentId AND identity_hash = @identity',
                { parentId: cursor, identity: identityHashOf(cursor, body) });
            const id = twin ? twin.id : newId();
            if (!twin) {
                insertMessageSync(entry.db, {
                    id, parentId: cursor, ownerId, content: body, createdAt: now + nodeIds.length,
                });
            }
            setDefaultChildSync(entry.db, cursor, id);
            nodeIds.push(id);
            cursor = id;
        }
    });
    return { ok: true, node_ids: nodeIds };
}

/**
 * Grafts a new node between `afterNodeId` and `beforeNodeId`: inserts a node under `afterNodeId`,
 * then reparents `beforeNodeId` onto it. This is the mid-chain-insert primitive — inserting a message
 * in the middle of a chain is structurally "point the new node at what used to be the default child,
 * then take over that slot". Refuses unless `beforeNodeId` is CURRENTLY parented under `afterNodeId`
 * AND is currently `afterNodeId`'s own default child (guards against grafting across an edge that
 * moved, or a default-child selection that changed - e.g. another session swiped to a different
 * alternative - since the caller last read it; mirrors {@link degraftRange}'s own equivalent
 * default-path check on the node it removes, for the same concurrent-edit-safety reason).
 */
export async function graftMessage(directories, ownerId, afterNodeId, beforeNodeId, content) {
    const entry = await getEntry(directories);
    if (!entry) return { ok: false, reason: 'unavailable' };

    const after = entry.db.get('SELECT id, default_child_id FROM messages WHERE id = @id AND owner_id = @ownerId',
        { id: afterNodeId, ownerId });
    if (!after) return { ok: false, reason: 'unknown after node' };

    const before = entry.db.get('SELECT id, parent_id FROM messages WHERE id = @id AND owner_id = @ownerId',
        { id: beforeNodeId, ownerId });
    if (!before) return { ok: false, reason: 'unknown before node' };
    if (before.parent_id !== afterNodeId) return { ok: false, reason: 'not adjacent' };
    if (after.default_child_id !== beforeNodeId) return { ok: false, reason: 'not on default path' };

    const now = Date.now();
    let newNodeId;
    entry.db.transaction(() => {
        const body = sanitizeForStorage(content);
        // Same convergence rule appendMessages()/addAlternatives() use: a retry that matches an
        // existing sibling of afterNodeId lands on that row instead of duplicating.
        const twin = entry.db.get(
            'SELECT id FROM messages WHERE parent_id = @parentId AND identity_hash = @identity',
            { parentId: afterNodeId, identity: identityHashOf(afterNodeId, body) });
        newNodeId = twin ? twin.id : newId();
        if (!twin) {
            insertMessageSync(entry.db, { id: newNodeId, parentId: afterNodeId, ownerId, content: body, createdAt: now });
        }

        // Reparent beforeNodeId onto the new node — identity_hash bakes in parent_id, so it must be
        // recomputed, not just the row's parent pointer.
        const beforeContent = entry.db.get('SELECT content FROM messages WHERE id = @id', { id: beforeNodeId }).content;
        const recomputedHash = identityHashOf(newNodeId, beforeContent);
        entry.db.run('UPDATE messages SET parent_id = @newNodeId, identity_hash = @hash WHERE id = @id',
            { id: beforeNodeId, newNodeId, hash: recomputedHash });

        setDefaultChildSync(entry.db, afterNodeId, newNodeId);
        setDefaultChildSync(entry.db, newNodeId, beforeNodeId);
    });

    return { ok: true, node_id: newNodeId };
}

/**
 * Removes `nodeId` from the default path by reparenting its current default child onto `nodeId`'s own
 * parent — the mid-chain-delete primitive. `nodeId`'s row is NOT deleted (matches every other
 * "removal" in this file — `deleteBranch` only clears a label, `endPathAt` only clears a pointer): it
 * becomes unreachable from the default path but stays addressable by raw node_id, so a label already
 * sitting on it survives untouched rather than needing to move anywhere.
 *
 * If `nodeId` has no default child, there is nothing after it on the path to reparent — that's the
 * existing tail-delete case `endPathAt()` already covers, so this refuses rather than duplicate it.
 */
export async function degraftMessage(directories, ownerId, nodeId) {
    return degraftRange(directories, ownerId, nodeId, nodeId);
}

/**
 * Same operation as {@link degraftMessage}, computed from the two ends of a contiguous default-path
 * run (needed when a caller removes more than one message at once, e.g. a tool-call group): reparents
 * `lastNodeId`'s default child onto `firstNodeId`'s parent. Refuses unless `firstNodeId` through
 * `lastNodeId` actually form a contiguous default-path chain — walked via `default_child_id` from
 * `firstNodeId`, not `parent_id`, so a node that's on some OTHER node's default path but not on this
 * one's can't be swept in.
 */
export async function degraftRange(directories, ownerId, firstNodeId, lastNodeId) {
    const entry = await getEntry(directories);
    if (!entry) return { ok: false, reason: 'unavailable' };

    const first = entry.db.get('SELECT id, parent_id FROM messages WHERE id = @id AND owner_id = @ownerId',
        { id: firstNodeId, ownerId });
    if (!first) return { ok: false, reason: 'unknown node' };
    if (!first.parent_id) return { ok: false, reason: 'unknown node' };

    // firstNodeId must be its parent's CURRENT default child — can't degraft a message that isn't
    // even the one currently shown on the path (would corrupt an alternative branch).
    const parent = entry.db.get('SELECT default_child_id FROM messages WHERE id = @id', { id: first.parent_id });
    if (!parent || parent.default_child_id !== firstNodeId) return { ok: false, reason: 'not on default path' };

    // Walk default_child_id from firstNodeId to confirm lastNodeId is reached by a contiguous run.
    let cursor = entry.db.get('SELECT id, default_child_id FROM messages WHERE id = @id', { id: firstNodeId });
    const seen = new Set([cursor.id]);
    while (cursor.id !== lastNodeId) {
        const next = cursor.default_child_id;
        if (!next || seen.has(next)) return { ok: false, reason: 'not on default path' };
        const row = entry.db.get('SELECT id, owner_id, default_child_id FROM messages WHERE id = @id', { id: next });
        if (!row || row.owner_id !== ownerId) return { ok: false, reason: 'not on default path' };
        seen.add(next);
        cursor = row;
    }

    const last = entry.db.get('SELECT id, default_child_id FROM messages WHERE id = @id', { id: lastNodeId });
    const childId = last.default_child_id;
    if (!childId) return { ok: false, reason: 'use end-path instead' };

    const parentId = first.parent_id;

    entry.db.transaction(() => {
        const childRow = entry.db.get('SELECT content FROM messages WHERE id = @id', { id: childId });
        const recomputedHash = identityHashOf(parentId, childRow.content);
        entry.db.run('UPDATE messages SET parent_id = @parentId, identity_hash = @hash WHERE id = @id',
            { id: childId, parentId, hash: recomputedHash });
        setDefaultChildSync(entry.db, parentId, childId);
    });

    return { ok: true };
}

/**
 * Adds an alternative alongside an existing node. Named by SIBLING (not parent) so the caller never
 * needs to know about the synthetic anchor. Idempotent: a matching alternative resolves to the
 * existing row instead of duplicating, so a set can be asserted on every chat open safely.
 */
export async function addAlternatives(directories, ownerId, siblingNodeId, contents) {
    const entry = await getEntry(directories);
    if (!entry) return { ok: false, reason: 'unavailable' };

    const sibling = entry.db.get('SELECT id, parent_id FROM messages WHERE id = @id AND owner_id = @ownerId',
        { id: siblingNodeId, ownerId });
    if (!sibling) return { ok: false, reason: 'unknown node' };
    if (!sibling.parent_id) return { ok: false, reason: 'node has no parent' };

    const list = Array.isArray(contents) ? contents : [contents];
    const parentId = sibling.parent_id;

    const byIdentity = new Map();
    for (const sib of getSiblingsSync(entry.db, parentId, '')) {
        byIdentity.set(nodeIdentityKey(parentId, sib.content), sib.id);
    }

    const nodeIds = [];
    let added = 0;
    entry.db.transaction(() => {
        const now = Date.now();
        for (const content of list) {
            const body = sanitizeForStorage(content);
            const key = nodeIdentityKey(parentId, body);
            const existing = byIdentity.get(key);
            if (existing) { nodeIds.push(existing); continue; }

            const id = newId();
            insertMessageSync(entry.db, {
                id, parentId, ownerId, content: body, createdAt: now + added,
            });
            byIdentity.set(key, id);
            nodeIds.push(id);
            added++;
        }
    });

    const total = getSiblingsSync(entry.db, parentId, '').length;
    return { ok: true, node_ids: nodeIds, added, total };
}

/**
 * Replaces a chat's metadata and rotates its integrity slug.
 * If `expectedIntegrity` is given, the write is rejected with a conflict when the node's current
 * `integrity` doesn't match - the same optional, per-write precondition `/api/settings/save-partial`
 * applies to its `expectedHashes`. Omitting it (older client, or a node with no integrity yet) allows
 * the write unconditionally.
 */
export async function setChatMetadata(directories, ownerId, chatName, metadata, expectedIntegrity) {
    const entry = await getEntry(directories);
    if (!entry) return { ok: false, reason: 'unavailable' };

    const node = entry.db.get('SELECT id, metadata FROM messages WHERE id = @id AND owner_id = @ownerId',
        { id: chatName, ownerId })
        ?? getLabeledNodeSync(entry.db, ownerId, chatName);
    if (!node) return { ok: false, reason: 'unknown chat' };

    if (typeof expectedIntegrity === 'string' && expectedIntegrity) {
        const currentIntegrity = readIntegritySync(node);
        if (currentIntegrity !== expectedIntegrity) {
            return { ok: false, reason: 'conflict' };
        }
    }

    const meta = { ...(metadata || {}) };
    const integrity = crypto.randomUUID();
    meta.integrity = integrity;
    delete meta.main_chat;
    delete meta.fork_point;
    delete meta._tree_stored;

    setMetadataSync(entry.db, node.id, JSON.stringify(meta));
    return { ok: true, integrity };
}

/**
 * The opening alternatives for a character: the anchor's children — every greeting any of its chats
 * has ever opened on. Addressed by OWNER since starting a chat has no node yet; a new chat picks one
 * of these and holds its id. Windowed around the default, with `total` for sizing.
 */
export async function getOpeningAlternatives(directories, ownerId, range = {}, cardGreetings = []) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const hasSavedChats = hasBranchesSync(entry.db, ownerId);
    // No anchor just means nothing stored yet — the card's greetings are still valid openings.
    const anchor = getAnchorSync(entry.db, ownerId);

    const rows = anchor ? entry.db.all(
        'SELECT id, content FROM messages WHERE parent_id = @p ORDER BY created_at ASC, id ASC',
        { p: anchor.id },
    ) : [];

    // The card's current greetings are merged in at read time rather than synced into the tree, so an
    // edited greeting is never stale; a greeting not yet opened gets no row until first used.
    const identity = body => (anchor ? nodeIdentityKey(anchor.id, body) : body);
    const seen = new Set(rows.map(r => identity(r.content)));
    const virtual = [];
    for (const greeting of (Array.isArray(cardGreetings) ? cardGreetings : [])) {
        const body = sanitizeForStorage(greeting);
        const key = identity(body);
        if (seen.has(key)) continue;
        seen.add(key);
        virtual.push(JSON.parse(body));
    }

    const defaultNodeId = anchor?.default_child_id ?? (rows[0]?.id ?? null);
    const defaultIndex = Math.max(0, rows.findIndex(r => r.id === defaultNodeId));

    // Windowed like a chat load; stored openings first, then card greetings with no row yet (node_id: null).
    const all = [
        ...rows.map(r => {
            let o = {};
            try { o = JSON.parse(r.content); } catch { /* leave empty */ }
            return { node_id: r.id, mes: o?.mes ?? '', send_date: o?.send_date, extra: o?.extra ?? {}, name: o?.name, is_user: !!o?.is_user };
        }),
        ...virtual.map(o => ({ node_id: null, mes: o?.mes ?? '', send_date: o?.send_date, extra: o?.extra ?? {}, name: o?.name, is_user: !!o?.is_user })),
    ];

    const width = Number.isInteger(range.limit) ? range.limit : 11;
    const from = Number.isInteger(range.offset)
        ? Math.max(0, range.offset)
        : Math.max(0, defaultIndex - Math.floor(width / 2));
    const to = Math.min(all.length, from + width);

    return {
        has_saved_chats: hasSavedChats,
        total: all.length,
        stored: rows.length,
        default_index: defaultIndex,
        default_node_id: defaultNodeId,
        offset: from,
        alternatives: all.slice(from, to),
    };
}

/** Makes sure these openings exist for a character, creating the anchor if this is its first. Idempotent, like addAlternatives. */
export async function addOpeningAlternatives(directories, ownerId, contents) {
    const entry = await getEntry(directories);
    if (!entry) return { ok: false, node_ids: [], added: 0, total: 0 };

    const list = Array.isArray(contents) ? contents : [contents];
    const nodeIds = [];
    let added = 0;
    let total = 0;

    entry.db.transaction(() => {
        const now = Date.now();
        const anchor = ensureAnchorSync(entry.db, ownerId, now);

        const byIdentity = new Map();
        for (const sib of getSiblingsSync(entry.db, anchor.id, '')) {
            byIdentity.set(nodeIdentityKey(anchor.id, sib.content), sib.id);
        }

        for (const content of list) {
            // An empty-text opening (e.g. an overswiped-to blank slot) would leave a permanent blank
            // greeting since rows are never deleted — skip it, keeping node_ids[i] aligned with contents.
            if (!String(content?.mes ?? '').trim()) { nodeIds.push(null); continue; }

            const body = sanitizeForStorage(content);
            const key = nodeIdentityKey(anchor.id, body);
            const existing = byIdentity.get(key);
            if (existing) { nodeIds.push(existing); continue; }

            const id = newId();
            insertMessageSync(entry.db, {
                id, parentId: anchor.id, ownerId, content: body, createdAt: now + added,
            });
            byIdentity.set(key, id);
            nodeIds.push(id);
            added++;
        }

        total = getSiblingsSync(entry.db, anchor.id, '').length;
    });

    return { ok: true, node_ids: nodeIds, added, total };
}

/**
 * Returns this owner's synthetic anchor row id, creating the anchor (with no name/label required at
 * all) if this is the owner's very first-ever touch. The async, `directories`-taking counterpart to
 * `ensureAnchorSync` — every other exported op in this file resolves its own `entry` this same way.
 * Wrapped in a transaction for the same reason `addOpeningAlternatives()` wraps its own
 * `ensureAnchorSync()` call: `ensureAnchorSync` itself is a plain get-then-insert-if-missing, not
 * atomic on its own.
 */
export async function getOrCreateAnchor(directories, ownerId) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    let anchor;
    entry.db.transaction(() => {
        anchor = ensureAnchorSync(entry.db, ownerId, Date.now());
    });
    return anchor.id;
}

/** Reads the tree at a node: everything above it plus the continuation below it. Node-addressed since `label` isn't unique per owner. */
export async function loadAtNode(directories, ownerId, nodeId) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    const node = entry.db.get('SELECT * FROM messages WHERE id = @id AND owner_id = @ownerId',
        { id: nodeId, ownerId });
    if (!node) return null;

    const leafId = descendDefaultSync(entry.db, node.id);
    const rows = getPathSync(entry.db, leafId).filter(r => !isAnchorRow(r));

    let metadata = {};
    if (node.metadata) {
        try { metadata = JSON.parse(node.metadata); } catch { metadata = {}; }
    }
    delete metadata.__is_group;

    return {
        messages: buildPathMessages(entry.db, rows, node.label ?? null),
        metadata,
        node_id: node.id,
        label: node.label ?? null,
    };
}

/** The bookmarks an owner has: nodes someone labelled so they could get back to them. */
export async function listLabels(directories, ownerId) {
    const entry = await getEntry(directories);
    if (!entry) return [];

    return entry.db.all(
        `SELECT id, label, created_at, content FROM messages
         WHERE owner_id = @ownerId AND label IS NOT NULL
         ORDER BY created_at ASC, id ASC`,
        { ownerId },
    ).map(r => {
        let mes = '';
        try { mes = JSON.parse(r.content)?.mes ?? ''; } catch { /* leave empty */ }
        return { node_id: r.id, label: r.label, created_at: r.created_at, mes };
    });
}

/**
 * Replaces the metadata stored on a node, node-addressed.
 * If `expectedIntegrity` is given, the write is rejected with a conflict when the node's current
 * `integrity` doesn't match - see `setChatMetadata()` for the same optional precondition.
 */
export async function setNodeMetadata(directories, ownerId, nodeId, metadata, expectedIntegrity) {
    const entry = await getEntry(directories);
    if (!entry) return { ok: false, reason: 'unavailable' };

    const node = entry.db.get('SELECT id, metadata FROM messages WHERE id = @id AND owner_id = @ownerId',
        { id: nodeId, ownerId });
    if (!node) return { ok: false, reason: 'unknown node' };

    if (typeof expectedIntegrity === 'string' && expectedIntegrity) {
        const currentIntegrity = readIntegritySync(node);
        if (currentIntegrity !== expectedIntegrity) {
            return { ok: false, reason: 'conflict' };
        }
    }

    const meta = { ...(metadata || {}) };
    const integrity = crypto.randomUUID();
    meta.integrity = integrity;
    delete meta.main_chat;
    delete meta.fork_point;
    delete meta._tree_stored;

    setMetadataSync(entry.db, nodeId, JSON.stringify(meta));
    return { ok: true, integrity };
}

/** Direct handle for the migration module, which batches many writes into one transaction. */
export async function getDbHandle(directories) {
    const entry = await getEntry(directories);
    return entry ? entry.db : null;
}

/** Renames the character inside all of an owner's character messages, in SQL rather than a round-trip per chat. */
export async function renameCharacterInMessages(directories, ownerId, newName) {
    const entry = await getEntry(directories);
    if (!entry) return 0;

    const rows = entry.db.all(
        `SELECT id, parent_id, content FROM messages
         WHERE owner_id = @ownerId
           AND parent_id IS NOT NULL
           AND json_extract(content, '$.is_user') IS NOT 1
           AND json_extract(content, '$.is_system') IS NOT 1
           AND COALESCE(json_extract(content, '$.extra.type'), '') != 'narrator'
           AND json_extract(content, '$.name') IS NOT @newName`,
        { ownerId, newName },
    );
    if (rows.length === 0) return 0;

    let updated = 0;
    entry.db.transaction(() => {
        for (const row of rows) {
            try {
                const msg = JSON.parse(row.content);
                msg.name = newName;
                const next = JSON.stringify(msg);
                // Speaker is part of identity, so renaming can collide two rows into the same identity hash.
                // Leave the colliding row with its old name rather than merge distinct subtrees.
                const twin = entry.db.get(
                    'SELECT id FROM messages WHERE parent_id = @parentId AND identity_hash = @identity AND id != @id',
                    { parentId: row.parent_id, identity: identityHashOf(row.parent_id, next), id: row.id });
                if (twin) {
                    console.warn(`[message-tree] Not renaming ${row.id}: ${twin.id} already says the same thing under this parent.`);
                    continue;
                }
                updateMessageContentSync(entry.db, row.id, next);
                updated++;
            } catch { /* skip malformed */ }
        }
    });
    return updated;
}

/** Renames one member's messages inside a group's tree, matched by their original_avatar. */
export async function renameGroupMemberInMessages(directories, groupOwnerId, oldAvatar, newAvatar, newName) {
    const entry = await getEntry(directories);
    if (!entry) return 0;

    const rows = entry.db.all(
        `SELECT id, content FROM messages
         WHERE owner_id = @groupOwnerId
           AND parent_id IS NOT NULL
           AND json_extract(content, '$.original_avatar') = @oldAvatar`,
        { groupOwnerId, oldAvatar },
    );
    if (rows.length === 0) return 0;

    const oldEncoded = encodeURIComponent(oldAvatar);
    const newEncoded = encodeURIComponent(newAvatar);

    let updated = 0;
    entry.db.transaction(() => {
        for (const row of rows) {
            try {
                const msg = JSON.parse(row.content);
                msg.name = newName;
                msg.original_avatar = newAvatar;
                if (typeof msg.force_avatar === 'string') {
                    msg.force_avatar = msg.force_avatar.replace(oldEncoded, newEncoded);
                }
                updateMessageContentSync(entry.db, row.id, JSON.stringify(msg));
                updated++;
            } catch { /* skip malformed */ }
        }
    });
    return updated;
}

export {
    insertMessageSync, createBranchSync, getPathSync, getBranchByNameSync, hasBranchesSync,
    newId, sanitizeForStorage, extractLastMes,
    ensureAnchorSync, descendDefaultSync, setDefaultChildSync, alternativesFromMessage, branchViewSync,
};

/** Closes all open DB handles. Checkpoints each in TRUNCATE mode first — an ordinary close never shrinks the WAL file back down. */
export function disposeMessageTreeStores() {
    for (const entry of entries.values()) {
        try { entry.db.checkpoint(); } catch { /* best-effort */ }
        try { entry.db.close(); } catch { /* best-effort */ }
    }
    entries.clear();
}
