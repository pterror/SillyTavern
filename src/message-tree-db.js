import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { color } from './util.js';
import { getSqliteEngine } from './endpoints/sqlite-engine.js';

/**
 * Tree-structured message storage with parent pointers. A single `messages` table is the whole model:
 * there is no `branches` table, and there are no swipe arrays inside a message. Every alternative
 * continuation — whether it came from swiping or from forking — is its own sibling row sharing a
 * `parent_id`. A "chat" is not an object; it is a `label` on some message plus the `default_child_id`
 * chain hanging below it.
 *
 * Columns:
 *  - `content`          JSON blob shaped like a JSONL chat line, minus `swipes`/`swipe_id`/`swipe_info`
 *                       (those are the sibling rows) and minus `node_id`/`extra.branches`/
 *                       `extra.bookmark_link` (those are tree structure).
 *  - `default_child_id` Which child of this row is the currently-shown continuation. Local to this one
 *                       parent, mutable, no deeper truth claim. Cycling an alternative at message N sets
 *                       N's *parent*'s `default_child_id` and touches nothing else in the tree, so the
 *                       old path keeps its own downstream choices and re-following from the new pick
 *                       lands on a fully-resolved, previously-explored continuation.
 *  - `label`            A deliberate bookmark on any message, leaf or interior. This is what a chat name
 *                       is now. `owner_id = X AND label IS NOT NULL` is the list of chats worth showing.
 *  - `metadata`         JSON chat_metadata (note_*, tainted, persona, integrity, variables, …) for the
 *                       labeled node. Carries no meaning on unlabeled rows.
 *
 * Every owner has exactly one synthetic anchor row (`parent_id IS NULL`), uniformly, regardless of how
 * many real roots it has. Opening an owner's conversation with nothing pre-selected = find the anchor,
 * then follow `default_child_id` down until a row has none. That makes root handling identical to every
 * other fork, so no code anywhere special-cases "the first message".
 *
 * Nothing is ever deleted or reparented. A mid-chat delete/insert forks from the affected node's parent
 * and copies forward fresh rows; an existing row's `parent_id` never changes.
 *
 * Preview text and message counts are computed at read time by walking, never stored.
 *
 * The exported `*Branch*` function names are kept alive as label+anchor-backed adapters purely so
 * src/endpoints/chats.js and characters.js keep working unchanged; they synthesize branch-shaped
 * objects ({ name, leaf_id, message_count, last_mes, metadata, … }) out of labeled nodes.
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
        metadata         TEXT
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

/**
 * The synthetic anchor row's content. It must satisfy the NOT NULL content column, must never be
 * rendered as chat, and must be recognizable without a schema column, so it is a one-key JSON object.
 */
export const ANCHOR_CONTENT = '{"__anchor":true}';

/**
 * How many alternatives either side of the selected one are sent inline with a chat load. Wide enough
 * that ordinary messages ship whole and that stepping through alternatives never blocks on a fetch,
 * small enough that a 1,508-alternative greeting costs a few KB instead of 577.
 */
const ALTERNATIVE_WINDOW = 5;

/** @param {{ parent_id: string | null, content?: string }} row */
function isAnchorRow(row) {
    return !!row && row.parent_id === null;
}

// ---------------------------------------------------------------------------
//  Per-user DB handles (same pattern as chat-metadata-db.js)
// ---------------------------------------------------------------------------

/** @type {Map<string, { db: import('./endpoints/sqlite-engine.js').SqliteEngineHandle }>} */
const entries = new Map();
let warnedNoEngine = false;

/** @param {import('./users.js').UserDirectoryList} directories */
function getDbPath(directories) {
    return path.join(directories.root, 'message-tree.sqlite');
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @returns {Promise<{ db: import('./endpoints/sqlite-engine.js').SqliteEngineHandle } | null>}
 */
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
    const entry = { db };
    entries.set(key, entry);
    return entry;
}

// ---------------------------------------------------------------------------
//  Content <-> alternatives
// ---------------------------------------------------------------------------

function newId() {
    return crypto.randomUUID();
}

/**
 * Strips tree-internal and branch-specific fields from a message object before storing it. Swipe
 * fields are stripped too — every alternative is a sibling row, so they have no representation in
 * a single row's content.
 * @param {object} msg
 * @returns {string} JSON string of the sanitized message
 */
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

/**
 * Expands one incoming message object into the ordered list of sibling rows it represents.
 *
 * A message with a `swipes` array of length N becomes N alternatives: alternative i takes `swipes[i]`
 * as its `mes`, and — where `swipe_info[i]` exists — that entry's `send_date` and `extra` (token counts,
 * model, generation timings) are folded onto the alternative, because once the array is gone there is
 * nowhere else for that per-alternative data to live. `swipe_info` shorter than `swipes` (2,612 rows in
 * the live install) simply leaves the extra alternatives with the parent message's own send_date/extra.
 * A `swipe_id` outside the array is clamped into range (2 rows in the live install).
 *
 * A message with no swipes array is a single alternative.
 *
 * @param {object} msg
 * @returns {{ contents: string[], selected: number, origIndices: number[] }}
 */
function alternativesFromMessage(msg) {
    const rawSwipes = Array.isArray(msg?.swipes) ? msg.swipes : null;
    if (!rawSwipes || rawSwipes.length === 0) {
        return { contents: [sanitizeForStorage(msg)], selected: 0, origIndices: [0], nodeIds: [msg?.node_id ?? null] };
    }

    // A hole means "this alternative exists but wasn't sent to the client", not "delete it". Nothing is
    // ever removed from the tree, so dropping unloaded entries here leaves their rows exactly where
    // they are. `origIndex` remembers each kept entry's position in the original (possibly sparse)
    // `swipes` array - callers that match siblings by position (rather than by text identity) need
    // that original slot, not the compacted index it ends up at in `kept`/`contents`.
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
            // The row this alternative was loaded from. Present only for slots the client genuinely
            // received; anything it fabricated locally has no id and cannot claim to be an existing
            // row. This is what lets the save verify rather than trust array positions.
            nodeId: (rawInfo[i] && typeof rawInfo[i] === 'object' && rawInfo[i].node_id)
                ? rawInfo[i].node_id
                // The selected slot is the message itself, so it can fall back to the message's own
                // row id. That keeps editing the visible message an in-place update even when
                // swipe_info predates carrying ids.
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

    // Speaker for an alternative: the set's default (the modal speaker the load sent, or this
    // message's own when they agree), overridden per entry where swipe_info says so.
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

/**
 * Rebuilds the client-facing message object for a node, re-synthesizing the swipe arrays from the
 * node's sibling rows so the unchanged client keeps working. Siblings are ordered by (created_at, id)
 * — the same deterministic ordering used everywhere else in this module.
 *
 * @param {{ id: string, content: string, label: string | null }} row
 * @param {{ id: string, content: string }[]} siblings ordered, includes `row` itself
 * @returns {object}
 */
function rowToMessage(row, siblings) {
    const msg = JSON.parse(row.content);
    msg.node_id = row.id;

    if (siblings && siblings.length > 1) {
        // The alternative arrays are sent at full length but with holes: only the selected entry
        // carries text. Length and index are what almost every consumer actually reads, and shipping
        // the rest costs 683KB of unread greetings on the worst real chat for zero benefit. The text
        // is filled in by /api/chats/alternatives at the moment something actually cycles.
        //
        // Holes rather than a bare count on purpose: `swipes.length`, `swipes[swipe_id]` and the
        // swipes/swipe_info length pairing keep working untouched everywhere they are read.
        const idx = siblings.findIndex(s => s.id === row.id);
        const selected = idx < 0 ? 0 : idx;

        msg.swipes = new Array(siblings.length).fill(null);
        msg.swipe_info = new Array(siblings.length).fill(null);
        msg.swipe_id = selected;

        // A window around the selected alternative is sent populated, the rest are holes. The window
        // means stepping left or right never waits on the network, and any message with
        // ALTERNATIVE_WINDOW*2+1 or fewer alternatives ships complete - so an ordinary two-or-three
        // swipe message behaves exactly as it always did, and only genuinely wide sets go sparse.
        const from = Math.max(0, selected - ALTERNATIVE_WINDOW);
        const to = Math.min(siblings.length, selected + ALTERNATIVE_WINDOW + 1);
        for (let i = from; i < to; i++) {
            let o = {};
            try { o = JSON.parse(siblings[i].content); } catch { o = {}; }
            msg.swipes[i] = o?.mes ?? '';
            // node_id per alternative: switching to one means moving onto that row's path, and the
            // client cannot ask for what is below it without knowing which row it is.
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

/**
 * The identity of a node among its siblings: its parent, its speaker, and its text.
 *
 * Text alone is not enough - the same words said by the user and by the character are two different
 * messages, and so are the same words said as two different personas. Beyond that, two alternatives with the same speaker and the same text under the same
 * parent are ONE node, even if their send_date or extra.token_count differ: a token count is a
 * derived measurement of the text, not part of what the message is.
 *
 * Every ingest path (client save, JSONL migration, the one-off DB transform) keys on this exact
 * function, so the same data arriving two different ways lands on the same rows.
 *
 * @param {string} parentId
 * @param {string} contentJson sanitized content blob
 * @returns {string}
 */
export function nodeIdentityKey(parentId, contentJson) {
    let speaker = '';
    let mes = '';
    try {
        const o = JSON.parse(contentJson);
        // A user message's speaker is the PERSONA it was said as. Two identical texts under one
        // parent, said as different personas, are two different messages and must not merge.
        //
        // A persona is a whole visible identity - its own avatar id, name, image and description. It
        // is who the reader sees as having said something, so two of them are different even when
        // every part that reaches the model happens to match. "Does it change the prompt" is the
        // wrong test here; that question belongs to chat metadata, not to who is speaking.
        //
        // The avatar id is the key. Names are distinct in practice but they are a display field, and
        // nothing stops two personas sharing one.
        //
        // Character messages keep the name - persona is a user-side concept and they have none.
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

/**
 * Extracts the preview text from a message content string.
 * @param {string} contentJson
 * @returns {string | null}
 */
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

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {{ id: string, parentId: string | null, ownerId: string, content: string, label?: string | null, createdAt: number, defaultChildId?: string | null, metadata?: string | null }} params
 */
function insertMessageSync(db, { id, parentId, ownerId, content, label, createdAt, defaultChildId, metadata }) {
    db.run(
        `INSERT INTO messages (id, parent_id, owner_id, content, label, created_at, default_child_id, metadata)
         VALUES (@id, @parentId, @ownerId, @content, @label, @createdAt, @defaultChildId, @metadata)`,
        {
            id,
            parentId: parentId ?? null,
            ownerId,
            content,
            label: label ?? null,
            createdAt,
            defaultChildId: defaultChildId ?? null,
            metadata: metadata ?? null,
        },
    );
}

/**
 * True when writing `incoming` over `stored` would replace real message text with nothing.
 *
 * Editing a message to be empty is not something the UI does, and a save carrying an empty
 * alternative where the database holds text means the client echoed back a slot it never actually
 * received. Refusing costs nothing in the legitimate case, and is the difference between a display
 * bug and permanent data loss in the other.
 *
 * @param {string} stored sanitized content JSON already in the row
 * @param {string} incoming sanitized content JSON from the client
 */
function wouldBlankStoredText(stored, incoming) {
    const mesOf = (json) => {
        try { return JSON.parse(json)?.mes ?? ''; } catch { return ''; }
    };
    return mesOf(stored).length > 0 && mesOf(incoming).length === 0;
}

function updateMessageContentSync(db, id, content) {
    db.run('UPDATE messages SET content = @content WHERE id = @id', { id, content });
}

function labelMessageSync(db, id, label) {
    db.run('UPDATE messages SET label = @label WHERE id = @id', { id, label });
}

function setMetadataSync(db, id, metadata) {
    db.run('UPDATE messages SET metadata = @metadata WHERE id = @id', { id, metadata });
}

/**
 * Points a parent at one of its children as the shown continuation. Touches exactly this one row.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
function setDefaultChildSync(db, parentId, childId) {
    if (!parentId || !childId) return false;
    // Only ever point at a genuine child. Switching an earlier message to a different alternative
    // makes everything after it belong to the OLD alternative's subtree, so a save that walked on
    // regardless would leave a parent pointing at a node that isn't below it.
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

/**
 * The owner's single synthetic anchor row, or undefined.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} ownerId
 */
function getAnchorSync(db, ownerId) {
    return db.get(
        'SELECT * FROM messages WHERE owner_id = @ownerId AND parent_id IS NULL ORDER BY created_at ASC, id ASC LIMIT 1',
        { ownerId },
    );
}

/**
 * Returns the owner's anchor, creating it if this owner has none yet. Applied uniformly to every
 * owner — a brand new owner gets an anchor with zero children, exactly the same shape as an owner
 * with 1085 of them.
 */
function ensureAnchorSync(db, ownerId, now) {
    const existing = getAnchorSync(db, ownerId);
    if (existing) return existing;
    const id = newId();
    insertMessageSync(db, {
        id, parentId: null, ownerId, content: ANCHOR_CONTENT, createdAt: now ?? Date.now(),
    });
    return getAnchorSync(db, ownerId);
}

/**
 * Follows `default_child_id` down from `nodeId` until a row has none set (or points nowhere).
 * Guarded against cycles so a corrupt pointer can't hang a request.
 * @returns {string} the deepest reachable node id
 */
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

/** Ordered siblings of a node (rows sharing its parent), including the node itself. */
function getSiblingsSync(db, parentId, nodeId) {
    if (!parentId) {
        // A row with no parent is an anchor; anchors have no siblings within an owner.
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

/**
 * Synthesizes the branch-shaped object src/endpoints/*.js still expects out of a labeled node.
 * `leaf_id`, `message_count` and `last_mes` are computed here, never stored.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {object} node a labeled `messages` row
 */
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
    };
}

/**
 * Finds the labeled node carrying this chat name. Ties broken by (created_at, id) so repeated calls
 * agree with each other and with the migration's own canonical-pick.
 */
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

/**
 * Back-compat name kept for the migration module. There is no branch record to create anymore —
 * this labels the node and parks the chat metadata on it.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {{ leafId: string, name: string, isGroup?: boolean, metadata?: string | null }} params
 */
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

/**
 * For each immediate child of `messageId`, the labeled nodes reachable in that child's subtree.
 * Same output shape the old branches-table version returned, so callers are unchanged.
 */
function getForkSiblingsSync(db, messageId) {
    // One walk of the subtree, carrying which immediate child each row descends through, instead of
    // one subtree walk per child. On the worst node in a real install (1,508 children, ~76k rows
    // below it) that is the difference between ~242ms and ~98ms.
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

/** Has this owner got anything listable in the tree yet? */
export async function isMigrated(directories, ownerId) {
    const entry = await getEntry(directories);
    if (!entry) return false;
    return hasBranchesSync(entry.db, ownerId);
}

/**
 * Turns a contiguous run of path rows into client-shaped messages: sibling windows, node ids, and
 * extra.branches on the fork points that actually diverge.
 *
 * Shared by a full chat load and by fetching the continuation below a node, so the two can never
 * disagree about what a message looks like.
 *
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {object[]} rows root-to-leaf order, anchor already removed
 * @param {string|null} branchName current chat name, excluded from its own extra.branches list
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

/**
 * Resolves a target that may be a node id or a legacy chat name.
 *
 * A node id is exact. A name resolves by label lookup, which is not unique per owner - this install
 * has 12 duplicate (owner, label) pairs - so it picks whichever row sorts first. Node first, name as
 * the fallback, so an old caller keeps working while the wrong-row hazard goes away for new ones.
 */
function resolveNodeOrName(db, ownerId, target) {
    return db.get('SELECT * FROM messages WHERE id = @id AND owner_id = @ownerId', { id: target, ownerId })
        ?? getLabeledNodeSync(db, ownerId, target);
}

/**
 * Loads a chat as the flat message array the client expects. Resolution is: labeled node → descend
 * `default_child_id` to the deepest row → walk parents back to the anchor → drop the anchor.
 *
 * @returns {Promise<{ messages: object[], metadata: object, branch: object } | null>}
 */
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
 * Saves a whole chat array into the tree.
 *
 * Kept for parity with upstream SillyTavern: /api/chats/save is what extensions and anything written
 * against the stock API call, so this shape has to keep working.
 *
 * Our own frontend does NOT use it, and shouldn't be routed back through it. It writes via the named
 * operations (editMessage / appendMessages / addAlternatives / selectDefaultChild / setChatMetadata),
 * each of which states the row it acts on. An array handed over wholesale is authority over rows the
 * caller may never have received, which is how a windowed load's unfilled slots came to overwrite
 * stored greetings with empty strings.
 *
 * Existing rows are matched by `node_id` (which survives the client round-trip). Anything without a
 * known node_id becomes new rows chained off the last resolved node. Every message's alternatives are
 * written as sibling rows and the chosen one is pointed at via the parent's `default_child_id`; no
 * other `default_child_id` in the tree is touched, so unrelated explored continuations keep theirs.
 *
 * @returns {Promise<{ integrity?: string, assignedNodeIds?: { index: number, node_id: string }[] } | null>}
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
                        // Re-materialize the alternative set around this node, matching each incoming
                        // alternative to an existing sibling by POSITION (its original slot in the
                        // swipe array) rather than by text identity. An edit to an alternative's text
                        // keeps its place in the swipe order - text identity reads that as "this
                        // alternative vanished, a different one appeared", which for a non-selected
                        // alternative used to fall straight to the newId() branch below and mint a
                        // fresh row every time the text changed (autosave-while-typing would then leave
                        // one permanent orphaned row per debounce tick, for any alternative that wasn't
                        // the selected one - only the selected slot ever got the in-place update).
                        // Position is what "the same alternative, edited" means to the caller, so a
                        // slot that already has a row gets that row's content updated in place, whether
                        // or not it is the selected one; only a slot with no existing row is new.
                        // Nothing is ever deleted - a slot the incoming array doesn't cover (a hole, or
                        // the array simply being shorter) just leaves whatever row already sits there
                        // untouched, orphaned children and all, same as before.
                        // Behaviour change worth flagging: two alternatives that happen to share exact
                        // text used to collapse onto the same row (text identity); by position they now
                        // stay two distinct rows, one per slot.
                        const sibs = getSiblingsSync(entry.db, known.parent_id, known.id);
                        const sibById = new Map(sibs.map(x => [x.id, x]));
                        let chosenId = known.id;

                        for (let k = 0; k < contents.length; k++) {
                            const c = contents[k];
                            const claimedId = nodeIds[k];
                            const existing = claimedId ? sibById.get(claimedId) : null;

                            let sid;
                            if (existing) {
                                // The client received this exact row, so it is entitled to edit it.
                                sid = existing.id;
                                if (existing.content !== c && !wouldBlankStoredText(existing.content, c)) {
                                    updateMessageContentSync(entry.db, sid, c);
                                }
                            } else {
                                // No id, or an id that isn't a sibling of this node: the client cannot
                                // show it received this row, so it does not get to speak for one. Write
                                // a new row instead of overwriting something it never held. A duplicate
                                // is recoverable; a clobbered alternative is not.
                                sid = newId();
                                insertMessageSync(entry.db, {
                                    id: sid, parentId, ownerId, content: c, createdAt: now + k,
                                });
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
                    // Still on the same path? Then reuse the row. If the chain diverged upstream
                    // (an earlier message was switched to a different alternative), this row belongs
                    // to the old branch and must not be dragged across - fall through and write a
                    // fresh row under the new parent instead. Nothing is reparented, nothing is lost.
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
                    byContent.set(c, sid);
                }
                if (k === selected) chosenId = sid;
            }
            assignedNodeIds.push({ index: i, node_id: chosenId });
            setDefaultChildSync(entry.db, parentId, chosenId);
            if (!firstId) firstId = chosenId;
            parentId = chosenId;
        }

        // Park the chat name + metadata. An existing chat keeps its label where the user put it;
        // a brand new one gets labeled at its first message so the whole chain hangs below the label.
        if (existingNode) {
            // The label stays exactly where the user put it; it is only an entry point, and the chain
            // it resolves through has just been extended below it.
            setMetadataSync(entry.db, existingNode.id, metadataJson);
        } else if (firstId) {
            // Brand new chat: label its first message so the whole chain hangs below the label.
            db_label(entry.db, firstId, chatName, metadataJson);
        }
    });

    return { integrity: nextIntegrity, assignedNodeIds };
}

function db_label(db, id, name, metadataJson) {
    db.run('UPDATE messages SET label = @name, metadata = @metadataJson WHERE id = @id', { id, name, metadataJson });
}

/**
 * Creates a fork. In this model that is purely a label: the fork point node gets a name, and the
 * chain already hanging below it (via default_child_id) is what that name resolves to. No rows are
 * copied, nothing is reparented.
 */
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

/**
 * "Deletes" a chat. Nothing is ever removed from the tree — the label is cleared, so the chat stops
 * being listable while every message it referenced stays reachable from any other label.
 */
export async function deleteBranch(directories, ownerId, branchName) {
    const entry = await getEntry(directories);
    if (!entry) return false;
    const node = resolveNodeOrName(entry.db, ownerId, branchName);
    if (!node) return false;
    // Removing a bookmark. The node and everything below it stays exactly where it is.
    labelMessageSync(entry.db, node.id, null);
    return true;
}

export async function renameBranch(directories, ownerId, oldName, newName) {
    const entry = await getEntry(directories);
    if (!entry) return false;
    const node = resolveNodeOrName(entry.db, ownerId, oldName);
    if (!node) return false;
    // Editing a bookmark's text. It does not move, and nothing pointing at the node cares.
    labelMessageSync(entry.db, node.id, newName);
    return true;
}

/** Labels (pins/checkpoints) any node. Pass null to clear. */
export async function labelNode(directories, nodeId, label) {
    const entry = await getEntry(directories);
    if (!entry) return false;
    const msg = entry.db.get('SELECT id FROM messages WHERE id = @id', { id: nodeId });
    if (!msg) return false;
    labelMessageSync(entry.db, nodeId, label);
    return true;
}

/**
 * Sets which child of `parentId` is the shown continuation. This is the whole of "swiping" now.
 * Touches exactly one row.
 */
export async function selectDefaultChild(directories, childId) {
    const entry = await getEntry(directories);
    if (!entry) return false;

    // A node has exactly one parent, so the caller never names it - which means it can never name the
    // wrong one. Selecting is "show this alternative", and the fork it belongs to follows from it.
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

/**
 * The alternatives at a node: every row sharing its parent, in sibling order, with the index of the
 * one asked about. This is what a slim load defers - `loadBranch(..., { includeAlternatives: false })`
 * sends only a count and a position, and this fills in the text when someone actually cycles.
 *
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} nodeId
 * @param {{ offset?: number, limit?: number }} [range] optional window for very wide sets
 * @returns {Promise<{ selected: number, total: number, alternatives: { node_id: string, mes: string, send_date: any, extra: object, name: string, is_user: boolean }[] } | null>}
 */
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

/**
 * The conversation below a node: follow its default_child_id chain to the deepest leaf and return
 * everything under it, in the same shape a chat load produces.
 *
 * Switching an earlier message to a different alternative moves the client onto that alternative's
 * path, and this is what it is now on. The rows below the OLD alternative are untouched and stay
 * exactly where they are - swiping back reaches them again.
 *
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} nodeId
 * @param {string|null} [branchName] current chat name, excluded from its own extra.branches list
 * @returns {Promise<{ messages: object[] } | null>} null when the node does not exist
 */
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

/**
 * The operations a save is actually made of.
 *
 * The tree already holds the path, so there is nothing for the client to restate. Each of these names
 * the row it acts on, which is what stops a client speaking for rows it never received - the shape
 * that let a windowed load's unfilled slots overwrite stored greetings with empty strings.
 */

/**
 * Edits one message's content in place.
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function editMessage(directories, ownerId, nodeId, content) {
    const entry = await getEntry(directories);
    if (!entry) return { ok: false, reason: 'unavailable' };

    const row = entry.db.get('SELECT id, content FROM messages WHERE id = @id AND owner_id = @ownerId',
        { id: nodeId, ownerId });
    if (!row) return { ok: false, reason: 'unknown node' };

    const next = sanitizeForStorage(content);
    if (row.content === next) return { ok: true };
    // No legitimate edit empties a message that has text; an incoming blank means the client is
    // echoing a slot it never loaded.
    if (wouldBlankStoredText(row.content, next)) return { ok: false, reason: 'refused to blank stored text' };

    updateMessageContentSync(entry.db, nodeId, next);
    return { ok: true };
}

/**
 * Appends messages after a node, chaining each onto the last and pointing the fork at them.
 * @param {object[]} contents ordered
 * @returns {Promise<{ ok: boolean, reason?: string, node_ids?: string[] }>}
 */
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
            const id = newId();
            insertMessageSync(entry.db, {
                id, parentId: cursor, ownerId, content: sanitizeForStorage(c), createdAt: now + nodeIds.length,
            });
            setDefaultChildSync(entry.db, cursor, id);
            nodeIds.push(id);
            cursor = id;
        }
    });
    return { ok: true, node_ids: nodeIds };
}

/**
 * Adds an alternative alongside an existing node - another option at the same fork.
 *
 * Named by SIBLING rather than by parent: every node knows its own parent, so the caller never has
 * to, which also means it can't name the wrong one or need to know about the synthetic anchor to add
 * an alternative to the opening message.
 *
 * Idempotent: one that is already there resolves to the existing row instead of duplicating, so a
 * whole set can be asserted on every chat open without the fork growing each time. That is what lets
 * a character's current greetings always be present in every chat, including ones created before the
 * greeting existed, while greetings a chat has diverged into stay put alongside them.
 *
 * @param {object[]|object} contents one alternative, or many
 * @returns {Promise<{ ok: boolean, reason?: string, node_ids?: string[], added?: number }>}
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

    // The resulting fork width, so a caller that just widened it can keep its own view in step
    // without pulling every alternative's text back.
    const total = getSiblingsSync(entry.db, parentId, '').length;
    return { ok: true, node_ids: nodeIds, added, total };
}

/**
 * Replaces a chat's metadata and rotates its integrity slug.
 * @returns {Promise<{ ok: boolean, reason?: string, integrity?: string }>}
 */
export async function setChatMetadata(directories, ownerId, chatName, metadata) {
    const entry = await getEntry(directories);
    if (!entry) return { ok: false, reason: 'unavailable' };

    // The caller may name a node or a legacy chat name. A node id is exact; a name resolves by label
    // lookup, which is not unique per owner. Node first, name as the fallback.
    const node = entry.db.get('SELECT id FROM messages WHERE id = @id AND owner_id = @ownerId',
        { id: chatName, ownerId })
        ?? getLabeledNodeSync(entry.db, ownerId, chatName);
    if (!node) return { ok: false, reason: 'unknown chat' };

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
 * The opening alternatives for a character: the anchor's children, which is every greeting any of its
 * chats has ever opened on.
 *
 * Addressed by OWNER rather than by a node, because starting a chat has no node to start from yet.
 * That is the whole point - a new chat picks one of these and holds its id, instead of copying a
 * greeting off the card into a fresh message the way the JSONL era had to.
 *
 * Windowed around the default, with `total` so the caller can size its arrays and fill the rest in
 * on demand.
 *
 * @returns {Promise<{ migrated: boolean, total: number, default_index: number, default_node_id: string|null, offset: number, alternatives: object[] } | null>}
 */
export async function getOpeningAlternatives(directories, ownerId, range = {}, cardGreetings = []) {
    const entry = await getEntry(directories);
    if (!entry) return null;

    // `migrated` distinguishes "lives in the tree and simply has no openings yet" from "still
    // file-backed", which the caller cannot tell from an empty list alone.
    const migrated = hasBranchesSync(entry.db, ownerId);
    const anchor = getAnchorSync(entry.db, ownerId);
    if (!anchor) return { migrated, total: 0, default_index: 0, default_node_id: null, offset: 0, alternatives: [] };

    const rows = entry.db.all(
        'SELECT id, content FROM messages WHERE parent_id = @p ORDER BY created_at ASC, id ASC',
        { p: anchor.id },
    );

    // The card's current greetings, merged in at READ time rather than copied into the tree.
    //
    // Asserting them into the tree on load was a sync: two sources of truth kept in step by hand, so
    // a greeting edited on the card stayed wrong until something re-ran the assertion. Merging here
    // makes the staleness impossible instead of shorter-lived - and a greeting nobody has opened a
    // conversation on does not need a row. It gets one when it is first used.
    //
    // A card greeting already present as a node is not repeated: same identity, same entry.
    const seen = new Set(rows.map(r => nodeIdentityKey(anchor.id, r.content)));
    const virtual = [];
    for (const greeting of (Array.isArray(cardGreetings) ? cardGreetings : [])) {
        const body = sanitizeForStorage(greeting);
        const key = nodeIdentityKey(anchor.id, body);
        if (seen.has(key)) continue;
        seen.add(key);
        virtual.push(JSON.parse(body));
    }

    const defaultNodeId = anchor.default_child_id ?? (rows[0]?.id ?? null);
    const defaultIndex = Math.max(0, rows.findIndex(r => r.id === defaultNodeId));

    // Windowed like a chat load, and for the same reason: one character here has 1,508 openings, and
    // shipping their text would be most of a megabyte nobody reads. The caller gets the total so it
    // can size its arrays, and fills the rest in on demand.
    // Stored openings first, in their own order, then card greetings that have no row yet. An entry
    // with no node_id is a greeting that exists on the card and nowhere else.
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
        migrated,
        total: all.length,
        stored: rows.length,
        default_index: defaultIndex,
        default_node_id: defaultNodeId,
        offset: from,
        alternatives: all.slice(from, to),
    };
}

/**
 * Makes sure these openings exist for a character, creating the anchor if this is its first.
 *
 * Same idempotence as addAlternatives, and addressed by owner for the same reason as above: a
 * character with nothing in the tree yet has no sibling to name, so the card's greetings would
 * otherwise have nowhere to attach.
 *
 * @returns {Promise<{ ok: boolean, node_ids: string[], added: number, total: number }>}
 */
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
 * Reads the tree at a node: everything above it, and the continuation below it.
 *
 * Node-addressed, because a node is the only thing that actually identifies a position. A name does
 * not: `label` is not unique per owner (12 duplicate pairs in a real install), so name lookup does
 * `LIMIT 1` and silently picks one of them.
 *
 * There is no chat here. Walk up for what came before, follow default_child_id down for what comes
 * after, and that is the whole of it.
 *
 * @returns {Promise<{ messages: object[], metadata: object, node_id: string, label: string|null } | null>}
 */
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

/**
 * The bookmarks an owner has: nodes someone labelled so they could get back to them.
 *
 * Describes the nodes, not a set of objects - node id, the label text, when it was made, and the text
 * of the message it sits on so it can be told apart from the others.
 *
 * @returns {Promise<{ node_id: string, label: string, created_at: number, mes: string }[]>}
 */
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
 * @returns {Promise<{ ok: boolean, reason?: string, integrity?: string }>}
 */
export async function setNodeMetadata(directories, ownerId, nodeId, metadata) {
    const entry = await getEntry(directories);
    if (!entry) return { ok: false, reason: 'unavailable' };

    const node = entry.db.get('SELECT id FROM messages WHERE id = @id AND owner_id = @ownerId',
        { id: nodeId, ownerId });
    if (!node) return { ok: false, reason: 'unknown node' };

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

/**
 * Renames the character inside all of an owner's character messages, in SQL rather than a
 * round-trip per chat. Anchors are skipped (they have no name field to begin with).
 * @returns {Promise<number>} rows updated
 */
export async function renameCharacterInMessages(directories, ownerId, newName) {
    const entry = await getEntry(directories);
    if (!entry) return 0;

    const rows = entry.db.all(
        `SELECT id, content FROM messages
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

/** Closes all open DB handles — test cleanup. */
export function disposeMessageTreeStores() {
    for (const entry of entries.values()) {
        try { entry.db.close(); } catch { /* best-effort */ }
    }
    entries.clear();
}
