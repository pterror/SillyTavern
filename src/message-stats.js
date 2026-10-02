/**
 * Per-owner message statistics, derived from the message tree: the stored messages are the only source. Triggers on
 * `messages` keep `owner_message_stats` current inside the writing statement's own transaction, through SQL functions
 * that read a row's content; `fillMessageStatsBatch()` recounts owners from their rows. Row `''` holds the user's totals.
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

/** @type {{ content: string | null, parsed: any }} The triggers call several functions on one row's content. */
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
 * Registers the SQL functions the stats triggers call. Every connection that writes message rows needs them.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
export function defineMessageStatsFunctions(db) {
    db.defineFunction('st_kind', content => messageKind(content));
    db.defineFunction('st_words', content => countWords(parseContent(content)?.mes));
    db.defineFunction('st_gen_ms', content => generationMs(content));
    db.defineFunction('st_send_at', (content) => {
        const at = parseTimestamp(parseContent(content)?.send_date);
        return at > 0 ? at : null;
    });
}

/** Bumped when the table or triggers change; a store on another version is rebuilt and recounted. */
const MESSAGE_STATS_VERSION = '1';
const VERSION_KEY = 'message_stats_version';
const FILL_AFTER_KEY = 'message_stats_fill_after';
const FILL_DONE_KEY = 'message_stats_filled';
export const TOTALS_OWNER = '';

const COUNTERS = ['user_msgs', 'char_msgs', 'user_words', 'char_words', 'swipes', 'gen_ms', 'gen_unknown'];

/**
 * One row's change to an owner's counters, as an upsert. `sign` is 1 to add the row, -1 to take it away; the row's
 * sibling check runs against the table as it is when the trigger fires.
 * @param {string} owner SQL for the owner id.
 * @param {string} row The trigger row's alias: NEW or OLD.
 * @param {1 | -1} sign
 */
function applyRowSql(owner, row, sign) {
    const k = `st_kind(${row}.content)`;
    const counts = `${row}.parent_id IS NOT NULL AND (${k} = 'user' OR (${k} = 'char' AND (SELECT parent_id FROM messages WHERE id = ${row}.parent_id) IS NOT NULL))`;
    const otherChar = `EXISTS (SELECT 1 FROM messages s WHERE s.parent_id = ${row}.parent_id AND s.id <> ${row}.id AND st_kind(s.content) = 'char')`;
    return `INSERT INTO owner_message_stats (owner_id, ${COUNTERS.join(', ')}, first_user_at)
        SELECT ${owner},
            ${sign} * (${k} = 'user'),
            ${sign} * (${k} = 'char'),
            ${sign} * (CASE WHEN ${k} = 'user' THEN st_words(${row}.content) ELSE 0 END),
            ${sign} * (CASE WHEN ${k} = 'char' THEN st_words(${row}.content) ELSE 0 END),
            ${sign} * (CASE WHEN ${k} = 'char' AND ${otherChar} THEN 1 ELSE 0 END),
            ${sign} * (CASE WHEN ${k} = 'char' THEN COALESCE(st_gen_ms(${row}.content), 0) ELSE 0 END),
            ${sign} * (CASE WHEN ${k} = 'char' AND st_gen_ms(${row}.content) IS NULL THEN 1 ELSE 0 END),
            ${sign > 0 ? `CASE WHEN ${k} = 'user' THEN st_send_at(${row}.content) END` : 'NULL'}
        WHERE ${counts}
        ON CONFLICT(owner_id) DO UPDATE SET
            ${COUNTERS.map(c => `${c} = ${c} + excluded.${c}`).join(', ')},
            first_user_at = CASE WHEN excluded.first_user_at IS NULL THEN first_user_at
                WHEN first_user_at IS NULL THEN excluded.first_user_at
                ELSE MIN(first_user_at, excluded.first_user_at) END;`;
}

/**
 * @param {string} row
 * @param {1 | -1} sign
 */
function applyRowBothSql(row, sign) {
    return applyRowSql(`${row}.owner_id`, row, sign) + '\n' + applyRowSql(`'${TOTALS_OWNER}'`, row, sign);
}

const MESSAGE_STATS_SQL = `
    CREATE TABLE IF NOT EXISTS owner_message_stats (
        owner_id      TEXT PRIMARY KEY,
        ${COUNTERS.map(c => `${c} INTEGER NOT NULL DEFAULT 0`).join(',\n        ')},
        first_user_at INTEGER
    );
    CREATE TRIGGER IF NOT EXISTS message_stats_insert AFTER INSERT ON messages BEGIN
        ${applyRowBothSql('NEW', 1)}
    END;
    CREATE TRIGGER IF NOT EXISTS message_stats_delete AFTER DELETE ON messages BEGIN
        ${applyRowBothSql('OLD', -1)}
    END;
    CREATE TRIGGER IF NOT EXISTS message_stats_content AFTER UPDATE OF content ON messages
    WHEN OLD.content IS NOT NEW.content BEGIN
        ${applyRowBothSql('OLD', -1)}
        ${applyRowBothSql('NEW', 1)}
    END;
    CREATE TRIGGER IF NOT EXISTS message_stats_move AFTER UPDATE OF parent_id ON messages
    WHEN OLD.parent_id IS NOT NEW.parent_id BEGIN
        ${applyRowBothSql('OLD', -1)}
        ${applyRowBothSql('NEW', 1)}
    END;
`;

/**
 * Creates the stats table and its triggers. A store on an older version gets them rebuilt and every owner recounted
 * by the fill (a hard cutover: the old counters are dropped).
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
export function migrateMessageStatsSync(db) {
    const version = /** @type {{ value: string } | undefined} */ (db.get('SELECT value FROM meta WHERE key = @key', { key: VERSION_KEY }));
    if (version?.value !== MESSAGE_STATS_VERSION) {
        db.exec(`
            DROP TRIGGER IF EXISTS message_stats_insert;
            DROP TRIGGER IF EXISTS message_stats_delete;
            DROP TRIGGER IF EXISTS message_stats_content;
            DROP TRIGGER IF EXISTS message_stats_move;
            DROP TABLE IF EXISTS owner_message_stats;
        `);
        restartMessageStatsFillSync(db);
    }
    db.exec(MESSAGE_STATS_SQL);
    if (version?.value !== MESSAGE_STATS_VERSION) {
        db.run('INSERT INTO meta (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            { key: VERSION_KEY, value: MESSAGE_STATS_VERSION });
    }
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
    db.run(`INSERT INTO owner_message_stats (owner_id, ${COUNTERS.join(', ')}, first_user_at)
        VALUES (@ownerId, ${COUNTERS.map(c => `@${c}`).join(', ')}, @first_user_at)
        ON CONFLICT(owner_id) DO UPDATE SET ${COUNTERS.map(c => `${c} = excluded.${c}`).join(', ')}, first_user_at = excluded.first_user_at`,
    { ownerId, ...stats });
}

/**
 * Recounts the next `limit` owners after where the fill stopped, each in its own transaction: the owner's row is
 * replaced by its count from its rows, and the totals move by the difference. Writes committed before or during the
 * fill are already in the rows it counts; writes after it are kept by the triggers.
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
            db.run('INSERT INTO meta (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
                { key: FILL_AFTER_KEY, value: ownerId });
        });
    }
    const done = ownerIds.length < limit;
    if (done) {
        db.run('INSERT INTO meta (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            { key: FILL_DONE_KEY, value: '1' });
    }
    return { owners: ownerIds.length, done };
}

/**
 * Starts the recount over: every owner is counted again from its rows by the next fill.
 * @param {import('./endpoints/sqlite-engine.js').SqliteEngineHandle} db
 */
export function restartMessageStatsFillSync(db) {
    db.run('DELETE FROM meta WHERE key IN (@after, @done)', { after: FILL_AFTER_KEY, done: FILL_DONE_KEY });
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
