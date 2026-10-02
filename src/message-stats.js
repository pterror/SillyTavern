import { deleteTreeMetaSync, setTreeMetaSync } from './message-tree-meta.js';
import { writeRowIfChanged } from './row-values.js';

/**
 * Per-owner message statistics, derived from the message tree: the stored messages are the only source. Every write to
 * `messages` (message-tree-db.js) counts its rows into `owner_message_stats` in the same transaction
 * (countMessageWriteSync(), deleteMessagesCountedSync()); `fillMessageStatsBatch()` recounts owners from their rows. Row `''` holds the user's totals.
 *
 * What counts: every user message, and every character message except the greetings (character messages whose
 * parent is the owner's anchor). System messages don't count. A swipe is every character message beyond the first
 * under the same parent.
 */

const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * A message timestamp in milliseconds, 0 when it can't be read. Takes what upstream chats have held: epoch numbers,
 * ISO strings, `Month DD, YYYY H:MMam`, and the `YYYY-MM-DD@HHhMMmSSsMSms` forms.
 * @param {unknown} timestamp
 * @returns {number}
 */
export function parseTimestamp(timestamp) {
    if (!timestamp) return 0;
    if (timestamp instanceof Date) return timestamp.getTime();
    if (typeof timestamp === 'number' || (typeof timestamp === 'string' && /^\d+$/.test(timestamp))) {
        const unixTime = Number(timestamp);
        return Number.isFinite(unixTime) && unixTime >= 0 ? unixTime : 0;
    }
    if (typeof timestamp !== 'string') return 0;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(timestamp)) return new Date(timestamp).getTime();

    const meridiem = timestamp.match(/(\w+)\s(\d{1,2}),\s(\d{4})\s(\d{1,2}):(\d{1,2})(am|pm)/i);
    if (meridiem) {
        const [, month, day, year, hour, minute, ampm] = meridiem;
        const hour24 = ampm.toLowerCase() === 'pm' ? (parseInt(hour, 10) % 12) + 12 : parseInt(hour, 10) % 12;
        const t = new Date(`${year}-${String(monthNames.indexOf(month) + 1).padStart(2, '0')}-${day.padStart(2, '0')}T${String(hour24).padStart(2, '0')}:${minute.padStart(2, '0')}:00`).getTime();
        return Number.isFinite(t) ? t : 0;
    }
    const humanized = timestamp.match(/(\d{4})-(\d{1,2})-(\d{1,2}) ?@(\d{1,2})h ?(\d{1,2})m ?(\d{1,2})s ?(?:(\d{1,3})ms)?/);
    if (humanized) {
        const [, year, month, day, hour, min, sec, ms] = humanized;
        const t = new Date(`${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${min.padStart(2, '0')}:${sec.padStart(2, '0')}${ms ? `.${ms.padStart(3, '0')}` : ''}Z`).getTime();
        return Number.isFinite(t) ? t : 0;
    }
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Words in a text: every run of word characters, the one method every count uses.
 * @param {unknown} text
 * @returns {number}
 */
export function countWords(text) {
    if (typeof text !== 'string') return 0;
    const match = text.match(/\b\w+\b/g);
    return match ? match.length : 0;
}

/** @type {{ content: string | null, parsed: any }} Counting a row reads its content several times. */
const lastParsed = { content: null, parsed: null };

/** @param {unknown} content */
function parseContent(content) {
    if (typeof content !== 'string') return null;
    if (lastParsed.content === content) return lastParsed.parsed;
    let parsed = null;
    try {
        parsed = JSON.parse(content);
    } catch {
        parsed = null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.__anchor) parsed = null;
    lastParsed.content = content;
    lastParsed.parsed = parsed;
    return parsed;
}

/**
 * 'user' or 'char' for a message that counts, null for anything else (system messages, unreadable content).
 * @param {unknown} content
 * @returns {'user' | 'char' | null}
 */
export function messageKind(content) {
    const message = parseContent(content);
    if (!message || message.is_system) return null;
    return message.is_user ? 'user' : 'char';
}

/**
 * How long the reply took to generate, null when it doesn't say.
 * @param {unknown} content
 * @returns {number | null}
 */
export function generationMs(content) {
    const message = parseContent(content);
    if (!message || !message.gen_started || !message.gen_finished) return null;
    const started = parseTimestamp(message.gen_started);
    const finished = parseTimestamp(message.gen_finished);
    return started > 0 && finished >= started ? finished - started : null;
}

/**
 * Registers the SQL functions the stats triggers of a store not yet migrated (migrateMessageStatsSync()) call: a
 * connection that writes message rows of such a store needs them.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
export function defineMessageStatsFunctions(db) {
    db.defineFunction('st_kind', content => messageKind(content));
    db.defineFunction('st_words', content => countWords(parseContent(content)?.mes));
    db.defineFunction('st_gen_ms', content => generationMs(content));
    db.defineFunction('st_send_at', content => sendAtOf(content));
}

/**
 * Opens message-tree.sqlite with a raw better-sqlite3 constructor, with the stats functions already registered. Any
 * code outside message-tree-db.js that opens the tree file goes through this, read-only or not: on a store not yet
 * migrated, a connection without the functions has every message write refused by the old triggers ("no such
 * function: st_kind"). tests/message-tree-openers.test.js fails if a file under src/ opens the tree another way.
 * @param {typeof import('better-sqlite3')} Database
 * @param {string} file
 * @param {import('better-sqlite3').Options} [options]
 * @returns {import('better-sqlite3').Database}
 */
export function openNativeTreeDatabase(Database, file, options) {
    const db = new Database(file, options);
    defineMessageStatsFunctions(/** @type {any} */ ({ defineFunction: (name, fn) => db.function(name, { deterministic: true }, fn) }));
    return db;
}

/** Bumped when the table changes; a store on another version is rebuilt and recounted. */
const MESSAGE_STATS_VERSION = '1';
const VERSION_KEY = 'message_stats_version';
const FILL_AFTER_KEY = 'message_stats_fill_after';
const FILL_DONE_KEY = 'message_stats_filled';
export const TOTALS_OWNER = '';

const COUNTERS = ['user_msgs', 'char_msgs', 'user_words', 'char_words', 'swipes', 'gen_ms', 'gen_unknown'];

/**
 * A user message's send date in milliseconds, null when it doesn't have a readable one.
 * @param {unknown} content
 * @returns {number | null}
 */
function sendAtOf(content) {
    const at = parseTimestamp(parseContent(content)?.send_date);
    return at > 0 ? at : null;
}

const MESSAGE_STATS_SQL = `
    CREATE TABLE IF NOT EXISTS owner_message_stats (
        owner_id      TEXT PRIMARY KEY,
        ${COUNTERS.map(c => `${c} INTEGER NOT NULL DEFAULT 0`).join(',\n        ')},
        first_user_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_owner_message_stats_first_user_at ON owner_message_stats(first_user_at);
`;

/** The triggers that kept the counters before the write path did (countMessageWriteSync()). */
const DROP_OLD_TRIGGERS_SQL = `
    DROP TRIGGER IF EXISTS message_stats_insert;
    DROP TRIGGER IF EXISTS message_stats_delete;
    DROP TRIGGER IF EXISTS message_stats_content;
    DROP TRIGGER IF EXISTS message_stats_move;
`;

/**
 * Creates the stats table. A store on an older version gets it rebuilt and every owner recounted by the fill (a hard
 * cutover: the old counters are dropped).
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
export function migrateMessageStatsSync(db) {
    const version = /** @type {{ value: string } | undefined} */ (db.get('SELECT value FROM meta WHERE key = @key', { key: VERSION_KEY }));
    if (db.get('SELECT 1 AS present FROM sqlite_master WHERE type = \'trigger\' AND name LIKE \'message_stats_%\' LIMIT 1')) {
        db.exec(DROP_OLD_TRIGGERS_SQL);
    }
    if (version?.value !== MESSAGE_STATS_VERSION) {
        db.exec('DROP TABLE IF EXISTS owner_message_stats;');
        restartMessageStatsFillSync(db);
    }
    db.exec(MESSAGE_STATS_SQL);
    if (version?.value !== MESSAGE_STATS_VERSION) {
        setTreeMetaSync(db, VERSION_KEY, MESSAGE_STATS_VERSION);
    }
}

/**
 * @typedef {{ id: string, parent_id: string | null, owner_id: string, content: string }} StatsMessageRow
 */

/**
 * @typedef {object} OwnerChange One owner's counter change from one write.
 * @property {MessageStats} delta The counters' change; its first_user_at is the earliest send date added.
 * @property {number[]} removedSendAts The send dates of the user messages the write took away.
 */

/**
 * Whether `parentId` is a message other than the anchor: a character message counts only under one.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} parentId
 */
function isUnderMessageSync(db, parentId) {
    const parent = /** @type {{ parent_id: string | null } | undefined} */ (db.get('SELECT parent_id FROM messages WHERE id = @id', { id: parentId }));
    return parent !== undefined && parent.parent_id !== null;
}

/**
 * Whether `parentId` has a character message other than the ones in `exclude`, as the table is now.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} parentId
 * @param {Set<string>} exclude
 */
function hasCharChildSync(db, parentId, exclude) {
    for (const row of /** @type {Iterable<{ id: string, content: string }>} */ (db.iterate(
        'SELECT id, content FROM messages WHERE parent_id = @parentId', { parentId }))) {
        if (!exclude.has(row.id) && messageKind(row.content) === 'char') return true;
    }
    return false;
}

/**
 * Adds one row's counters to its owner's change, `sign` 1 for a row the write added, -1 for one it took away.
 * @param {Map<string, OwnerChange>} changes
 * @param {StatsMessageRow} row
 * @param {1 | -1} sign
 * @param {boolean} underMessage Whether the row's parent is a message other than the anchor.
 * @param {boolean} hasOtherChar Whether the row's parent has another character message.
 */
function addRowChange(changes, row, sign, underMessage, hasOtherChar) {
    if (row.parent_id === null) return;
    const kind = messageKind(row.content);
    if (kind === null || (kind === 'char' && !underMessage)) return;
    let change = changes.get(row.owner_id);
    if (!change) {
        change = { delta: emptyStats(), removedSendAts: [] };
        changes.set(row.owner_id, change);
    }
    const { delta } = change;
    const words = countWords(parseContent(row.content)?.mes);
    if (kind === 'user') {
        delta.user_msgs += sign;
        delta.user_words += sign * words;
        const at = sendAtOf(row.content);
        if (at !== null) {
            if (sign > 0) delta.first_user_at = delta.first_user_at === null ? at : Math.min(delta.first_user_at, at);
            else change.removedSendAts.push(at);
        }
        return;
    }
    delta.char_msgs += sign;
    delta.char_words += sign * words;
    if (hasOtherChar) delta.swipes += sign;
    const ms = generationMs(row.content);
    if (ms === null) delta.gen_unknown += sign;
    else delta.gen_ms += sign * ms;
}

/**
 * The earliest send date of an owner's counted user messages, read from its rows.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} ownerId
 * @returns {number | null}
 */
function readFirstUserAtSync(db, ownerId) {
    let first = null;
    for (const row of /** @type {Iterable<{ content: string }>} */ (db.iterate(
        'SELECT content FROM messages WHERE owner_id = @ownerId AND parent_id IS NOT NULL', { ownerId }))) {
        if (messageKind(row.content) !== 'user') continue;
        const at = sendAtOf(row.content);
        if (at !== null && (first === null || at < first)) first = at;
    }
    return first;
}

/**
 * Writes each owner's change into its row and the totals row. An owner whose earliest user message was taken away
 * has its first_user_at read again from its rows, and the totals' from the owners' rows.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {Map<string, OwnerChange>} changes
 */
function applyChangesSync(db, changes) {
    if (changes.size === 0) return;
    const totals = readRowSync(db, TOTALS_OWNER);
    const totalsBefore = totals.first_user_at;
    let totalsStale = false;
    for (const [ownerId, { delta, removedSendAts }] of changes) {
        const stats = readRowSync(db, ownerId);
        const before = stats.first_user_at;
        for (const c of COUNTERS) {
            stats[c] += delta[c];
            totals[c] += delta[c];
        }
        stats.first_user_at = minOf(before, delta.first_user_at);
        if (before !== null && removedSendAts.includes(before)) {
            stats.first_user_at = readFirstUserAtSync(db, ownerId);
            if (before === totalsBefore && stats.first_user_at !== before) totalsStale = true;
        }
        writeRowSync(db, ownerId, stats);
        totals.first_user_at = minOf(totals.first_user_at, delta.first_user_at);
    }
    if (totalsStale) {
        const first = /** @type {{ first_user_at: number } | undefined} */ (db.get(
            'SELECT first_user_at FROM owner_message_stats WHERE first_user_at IS NOT NULL AND owner_id <> @totals ORDER BY first_user_at LIMIT 1',
            { totals: TOTALS_OWNER }));
        totals.first_user_at = first?.first_user_at ?? null;
    }
    writeRowSync(db, TOTALS_OWNER, totals);
}

/**
 * @param {number | null} a
 * @param {number | null} b
 */
function minOf(a, b) {
    if (a === null) return b;
    if (b === null) return a;
    return Math.min(a, b);
}

/**
 * Counts one row the caller has just inserted, rewritten or moved, inside the caller's transaction. `before` is the
 * row as it was (null for an insert), `after` as it is now; the same id.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {StatsMessageRow | null} before
 * @param {StatsMessageRow} after
 */
export function countMessageWriteSync(db, before, after) {
    /** @type {Map<string, OwnerChange>} */
    const changes = new Map();
    const self = new Set([after.id]);
    for (const [row, sign] of /** @type {[StatsMessageRow | null, 1 | -1][]} */ ([[before, -1], [after, 1]])) {
        if (row === null || row.parent_id === null) continue;
        const kind = messageKind(row.content);
        if (kind === null) continue;
        const underMessage = kind === 'char' && isUnderMessageSync(db, row.parent_id);
        addRowChange(changes, row, sign, underMessage, underMessage && hasCharChildSync(db, row.parent_id, self));
    }
    applyChangesSync(db, changes);
}

/**
 * Deletes `rows` with `remove` and counts them out, inside the caller's transaction. Each row's place (its parent's
 * parent, its parent's other character messages) is read before the delete, as the counters held it.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {StatsMessageRow[]} rows
 * @param {() => number} remove Deletes the rows; returns how many it deleted, which must be all of them (else this
 *   throws, rolling the caller's transaction back).
 * @returns {number} What `remove` returned.
 */
export function deleteMessagesCountedSync(db, rows, remove) {
    const deleting = new Set(rows.map(r => r.id));
    /** @type {Map<string, boolean>} */
    const underMessage = new Map();
    /** @type {Map<string, number>} Per parent: character messages left after the delete, besides those deleted. */
    const charsKept = new Map();
    for (const row of rows) {
        if (row.parent_id === null || messageKind(row.content) !== 'char' || underMessage.has(row.parent_id)) continue;
        underMessage.set(row.parent_id, isUnderMessageSync(db, row.parent_id));
        charsKept.set(row.parent_id, hasCharChildSync(db, row.parent_id, deleting) ? 1 : 0);
    }
    const deleted = remove();
    if (deleted !== rows.length) throw new Error(`Deleted ${deleted} of ${rows.length} message rows; the stats count only whole deletes.`);
    /** @type {Map<string, OwnerChange>} */
    const changes = new Map();
    /** @type {Map<string, number>} Per parent: deleted character messages not yet counted out. */
    const charsLeftToCount = new Map();
    for (const row of rows) {
        if (row.parent_id !== null && messageKind(row.content) === 'char') charsLeftToCount.set(row.parent_id, (charsLeftToCount.get(row.parent_id) ?? 0) + 1);
    }
    for (const row of rows) {
        const parentId = row.parent_id;
        let hasOtherChar = false;
        if (parentId !== null && messageKind(row.content) === 'char') {
            const left = /** @type {number} */ (charsLeftToCount.get(parentId)) - 1;
            charsLeftToCount.set(parentId, left);
            hasOtherChar = left > 0 || (charsKept.get(parentId) ?? 0) > 0;
        }
        addRowChange(changes, row, -1, parentId !== null && (underMessage.get(parentId) ?? false), hasOtherChar);
    }
    applyChangesSync(db, changes);
    return deleted;
}

/**
 * @typedef {object} MessageStats
 * @property {number} user_msgs
 * @property {number} char_msgs Every character message, swipes included.
 * @property {number} user_words
 * @property {number} char_words
 * @property {number} swipes
 * @property {number} gen_ms Generation time summed over the character messages that say how long they took.
 * @property {number} gen_unknown Character messages that don't say how long they took.
 * @property {number | null} first_user_at The earliest user message's send date, null with none.
 */

/** @returns {MessageStats} */
function emptyStats() {
    return { user_msgs: 0, char_msgs: 0, user_words: 0, char_words: 0, swipes: 0, gen_ms: 0, gen_unknown: 0, first_user_at: null };
}

/**
 * An owner's stats counted from its rows. Reads every one of the owner's messages, so it is bounded by the owner.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} ownerId
 * @returns {MessageStats}
 */
export function countOwnerStatsSync(db, ownerId) {
    const stats = emptyStats();
    /** @type {Map<string, string | null>} */
    const parentOf = new Map();
    /** @type {{ parent_id: string, content: string }[]} */
    const rows = [];
    for (const row of /** @type {Iterable<{ id: string, parent_id: string | null, content: string }>} */ (db.iterate(
        'SELECT id, parent_id, content FROM messages WHERE owner_id = @ownerId', { ownerId }))) {
        parentOf.set(row.id, row.parent_id);
        if (row.parent_id !== null) rows.push({ parent_id: row.parent_id, content: row.content });
    }
    /** @type {Map<string, number>} */
    const charChildren = new Map();
    for (const row of rows) {
        const kind = messageKind(row.content);
        if (!kind) continue;
        // A greeting: a character message whose parent is the anchor.
        if (kind === 'char' && parentOf.get(row.parent_id) === null) continue;
        const words = countWords(parseContent(row.content)?.mes);
        if (kind === 'user') {
            stats.user_msgs++;
            stats.user_words += words;
            const at = parseTimestamp(parseContent(row.content)?.send_date);
            if (at > 0) stats.first_user_at = stats.first_user_at === null ? at : Math.min(stats.first_user_at, at);
        } else {
            stats.char_msgs++;
            stats.char_words += words;
            const ms = generationMs(row.content);
            if (ms === null) stats.gen_unknown++;
            else stats.gen_ms += ms;
            charChildren.set(row.parent_id, (charChildren.get(row.parent_id) ?? 0) + 1);
        }
    }
    for (const n of charChildren.values()) stats.swipes += Math.max(0, n - 1);
    return stats;
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} ownerId
 * @returns {MessageStats}
 */
function readRowSync(db, ownerId) {
    const row = /** @type {MessageStats | undefined} */ (db.get(
        `SELECT ${COUNTERS.join(', ')}, first_user_at FROM owner_message_stats WHERE owner_id = @ownerId`, { ownerId }));
    return row ? { ...row } : emptyStats();
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} ownerId
 * @param {MessageStats} stats
 */
function writeRowSync(db, ownerId, stats) {
    /** @type {Record<string, any>} */
    const values = { first_user_at: stats.first_user_at };
    for (const c of COUNTERS) values[c] = stats[c];
    writeRowIfChanged(db, 'owner_message_stats', { owner_id: ownerId }, values, { insert: true });
}

/**
 * Recounts the next `limit` owners after where the fill stopped, each in its own transaction: the owner's row is
 * replaced by its count from its rows, and the totals move by the difference. Writes committed before or during the
 * fill are already in the rows it counts; writes after it are counted by the write path.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {number} limit
 * @returns {{ owners: number, done: boolean }}
 */
export function fillMessageStatsBatchSync(db, limit) {
    if (messageStatsFilledSync(db)) return { owners: 0, done: true };
    const saved = /** @type {{ value: string } | undefined} */ (db.get('SELECT value FROM meta WHERE key = @key', { key: FILL_AFTER_KEY }));
    const after = saved?.value ?? null;
    const ownerIds = Array.from(/** @type {Iterable<{ owner_id: string }>} */ (db.iterate(
        `SELECT DISTINCT owner_id FROM messages WHERE parent_id IS NULL ${after === null ? '' : 'AND owner_id > @after'}
         ORDER BY owner_id LIMIT @limit`, after === null ? { limit } : { after, limit })), row => row.owner_id);

    for (const ownerId of ownerIds) {
        db.transaction(() => {
            const before = readRowSync(db, ownerId);
            const counted = countOwnerStatsSync(db, ownerId);
            writeRowSync(db, ownerId, counted);
            const totals = readRowSync(db, TOTALS_OWNER);
            for (const c of COUNTERS) totals[c] += counted[c] - before[c];
            if (counted.first_user_at !== null) {
                totals.first_user_at = totals.first_user_at === null ? counted.first_user_at : Math.min(totals.first_user_at, counted.first_user_at);
            }
            writeRowSync(db, TOTALS_OWNER, totals);
            setTreeMetaSync(db, FILL_AFTER_KEY, ownerId);
        });
    }
    const done = ownerIds.length < limit;
    if (done) {
        setTreeMetaSync(db, FILL_DONE_KEY, '1');
    }
    return { owners: ownerIds.length, done };
}

/**
 * Starts the recount over: every owner is counted again from its rows by the next fill.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
export function restartMessageStatsFillSync(db) {
    deleteTreeMetaSync(db, [FILL_AFTER_KEY, FILL_DONE_KEY]);
}

/**
 * Whether every owner has been counted from its rows since the counters were created or restarted.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @returns {boolean}
 */
export function messageStatsFilledSync(db) {
    return !!db.get('SELECT 1 AS ok FROM meta WHERE key = @key', { key: FILL_DONE_KEY });
}

/**
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} ownerId
 * @returns {MessageStats}
 */
export function readMessageStatsSync(db, ownerId) {
    return readRowSync(db, ownerId);
}
