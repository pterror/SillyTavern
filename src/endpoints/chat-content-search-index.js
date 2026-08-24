import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import {
    getIndexedMessageCount, setIndexedMessageCount, getMetaValue, setMetaValue,
    getLatestRev, getChangesSince, getChatRow,
} from '../chat-metadata-db.js';
import { buildSearchQuery as buildTantivyQuery, runSearch as runTantivySearch } from './tantivy-search.js';
import { getTantivyModule } from './tantivy-engine.js';
import { createIndexCoordinator } from './search-index-coordinator.js';
import { tryParse, color, formatBytes } from '../util.js';

/**
 * A per-user, per-message tantivy full-text index over chat content - the real content-search half of owner
 * tracker #5 (chat-metadata-db.js's per-chat metadata store is the other half, and the hard prerequisite this
 * module's incremental catch-up reads from). Reuses this fork's existing tantivy infrastructure directly
 * (tantivy-engine.js's engine resolution, tantivy-search.js's query-building/search helpers,
 * search-index-coordinator.js's stale-serve/background-catchup/coalescing behavior) rather than reimplementing
 * any of it - see search-index-coordinator.js's own header for why that matters (the 18+ second concurrent-
 * rebuild-race incident it exists to prevent applies here exactly as much as it does to character search).
 *
 * GRANULARITY: one tantivy document PER MESSAGE, not per chat - a deliberate, already-settled tradeoff (owner
 * decision), not re-litigated here. The alternative (one doc per chat, matching characters-search-index.js's own
 * shape) has no partial-document update in tantivy (confirmed by that module's own header - "a changed doc costs
 * the same as a new one"), which for a CHAT means re-embedding its entire text into tantivy on every single
 * message sent - an unbounded, ever-growing cost as a chat gets longer, for install with real chats in the
 * thousands of messages. Per-message docs mean an ordinary send only ever needs one small `addDocument` for the
 * new message, never a re-embed of everything before it - see applyIncrementalChanges() below for exactly how.
 * The real cost this trades for: resolving a page of message hits back to their parent chats for display (see
 * resolveHitsToChats() below) and a larger total document count across the whole corpus - both accepted as the
 * better trade given how chats actually grow over time (unboundedly, append-heavy) vs. characters (edited
 * rarely, in full, by a human).
 *
 * INCREMENTAL CATCH-UP, APPEND-ONLY FAST PATH: driven by chat-metadata-db.js's `changes` table (getChangesSince())
 * exactly the way applyIncrementalTantivyChanges() (characters-search-index.js) drives its own catch-up off
 * character-metadata-db.js's change log - same shape, different store. For each chat that changed, this compares
 * its current message_count (chat-metadata-db.js's cached row - no file read needed for the count itself) against
 * `indexed_message_count` (this module's own per-chat watermark, chat-metadata-db.js's getIndexedMessageCount()/
 * setIndexedMessageCount()): if the chat only grew, only the NEW tail messages (index >= the watermark) get
 * `addDocument`-ed - the whole point. If the watermark says "never indexed" or the chat's message count went
 * DOWN (an edit that removed messages, a branch swap, anything that isn't a clean append), this falls back to a
 * full per-chat reindex (delete every existing doc for that chat_id, re-add every current message) - the same
 * "when in doubt, do the more expensive but correct thing" posture characters-search-index.js already uses for
 * its own incremental-vs-full-rebuild fork.
 *
 * A REAL, DELIBERATE GAP IN THIS MODEL, FLAGGED RATHER THAN SILENTLY ACCEPTED: a mid-chat edit that does NOT
 * change the message count (a swipe/regenerate that replaces the text of an existing message without adding or
 * removing one) is invisible to the append-only fast path - the watermark comparison sees no count change and
 * skips reindexing entirely, so the OLD text of that message stays searchable and the new text never becomes so,
 * until something else (a later real append, or an explicit rebuild) touches that chat again. This mirrors the
 * same class of tradeoff character-metadata-db.js's own write-path-hooks-plus-backstop design accepts elsewhere,
 * but unlike that module, THIS module has no reconciler backstop (chat-metadata-db.js was deliberately scoped
 * without one - see that module's own header) to eventually self-correct it. Accepted for this build given the
 * task's own framing (message-level granularity was chosen specifically to optimize the append-heavy common
 * case), but a real correctness gap for the swipe/regenerate case specifically, not a hypothetical one - a
 * future pass could close it by also comparing each chat's own `rev` (chat-metadata-db.js already has one) against
 * a per-chat "reindexed as of this rev" watermark and forcing a full reindex whenever rev moved but count didn't,
 * trading the append-only fast path's win back on exactly the chats where a same-count edit actually happened.
 *
 * NO SQLITE FTS5 FALLBACK TIER (unlike the character/group search chain's tantivy-then-native-then-wasm chain) -
 * a deliberate scope narrowing for this build, not an oversight: this module is tantivy-only, and reports itself
 * unavailable if tantivy can't load on this install. chats.js's caller already has a correct, if slower, fallback
 * for that case: the pre-existing full-file readline scan /api/chats/search's query branch used before this
 * module existed - so "tantivy unavailable" degrades to "exactly the old behavior," not "content search broken."
 * Building a second SQLite-FTS5-per-message tier was judged not worth the added surface for this pass; flagging
 * it here as a real, visible scope choice rather than a silent gap.
 */

/** The stored field holding the small JSON payload needed to resolve a hit back to its parent chat and message -
 * see resolveHitsToChats() below. Reuses tantivy-search.js's runSearch(), which reads exactly this field name. */
const DATA_FIELD = 'data';

const SEARCHABLE_FIELD_NAME = 'text';
const FIELD_WEIGHTS = { [SEARCHABLE_FIELD_NAME]: 1 };
const FIELD_LABELS = {};

/** Mirrors characters-search-index.js's own batching constants/rationale exactly (OOM-avoidance via periodic
 * writer.commit() during a full corpus build) - see that module's own doc comments on both. */
const CHECKPOINT_EVERY_N_CHATS = 100;

/** Caps how many message hits a single search fetches from tantivy before resolution - same "bound the fetch,
 * not just the final page" reasoning DEFAULT_TANTIVY_MAX_ROWS documents in characters-search-index.js. Sized
 * larger than a chat-list page because many hits can resolve to the same handful of chats (resolveHitsToChats()
 * collapses them), so the resolved chat count after collapsing is usually far smaller than this. */
const DEFAULT_MESSAGE_MAX_ROWS = 2000;

const TANTIVY_REV_META_KEY = 'chat_content_index_rev';

const NOOP_CLOSE = () => { /* no explicit close API on this binding's Index */ };

/** @type {ReturnType<typeof createIndexCoordinator>} */
const indexCoordinator = createIndexCoordinator();

/**
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @returns {import('@oxdev03/node-tantivy-binding').Schema}
 */
function buildMessageSchema(tantivy) {
    const builder = new tantivy.SchemaBuilder();
    builder.addTextField(SEARCHABLE_FIELD_NAME, { stored: false, tokenizerName: 'default', indexOption: 'position' });
    // `data` is `raw`-tokenized + stored, same DATA_FIELD contract tantivy-search.js documents (its own header)
    // and characters-search-index.js relies on: exact-match indexed (never split into search tokens, so it can
    // never collide with the real text search above) AND the delete-by-term key for this doc. Holds a small JSON
    // payload (chatId/messageIndex/date/isUser/characterOrGroupId), not the message text itself.
    builder.addTextField(DATA_FIELD, { stored: true, tokenizerName: 'raw', indexOption: 'basic' });
    // A real, separate indexed (not just stored-inside-`data`) field so a future caller can scope a search to one
    // chat file directly via a term query, without needing to parse every hit's JSON payload first to find out -
    // deleteDocumentsByTerm() (this module's own delete-by-chat step, see below) also uses this field, not `data`,
    // specifically so deleting "every doc for this chat" doesn't require re-deriving a value that has to exactly
    // match what was indexed (a plain, unambiguous field beats matching a substring of a JSON blob for that).
    builder.addTextField('chat_id', { stored: true, tokenizerName: 'raw', indexOption: 'basic' });
    return builder.build();
}

/**
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {import('@oxdev03/node-tantivy-binding').Schema} schema
 * @param {object} fields
 * @param {string} fields.chatId The chat file's own path (chat-metadata-db.js's primary key) - the delete-by-term
 * key for this doc, and how resolveHitsToChats() below groups hits back to their parent chat.
 * @param {string|null} fields.characterOrGroupId Avatar filename for a character chat, group id for a group
 * chat, or null for a root/ownerless chat - see resolveOwnerIds() below for how this gets derived.
 * @param {number} fields.messageIndex 0-based index of this message within its chat (matches chat-metadata-db.js's
 * message_count convention: message_count is the count of these, chatData[0] is the non-message header).
 * @param {string|null} fields.date The message's own `send_date`, stringified as-is (no reparsing - chat message
 * send_date isn't a single guaranteed format across every import path, so this is stored for display/sort
 * purposes exactly as the chat file has it, not normalized).
 * @param {boolean} fields.isUser
 * @param {string} fields.text The message's own `mes` text - the only field actually tokenized for search.
 * @returns {import('@oxdev03/node-tantivy-binding').Document}
 */
function messageToTantivyDoc(tantivy, schema, fields) {
    return tantivy.Document.fromDict({
        [SEARCHABLE_FIELD_NAME]: fields.text ?? '',
        chat_id: fields.chatId,
        [DATA_FIELD]: JSON.stringify({
            chatId: fields.chatId,
            characterOrGroupId: fields.characterOrGroupId,
            messageIndex: fields.messageIndex,
            date: fields.date,
            isUser: !!fields.isUser,
        }),
    }, schema);
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {string}
 */
function tantivyIndexDir(directories) {
    return path.join(directories.root, 'search-index', 'chat-content-tantivy');
}

/**
 * Parses a `.jsonl` chat file into its raw header + message items - the one place this module actually reads a
 * chat file off disk (both the full-reindex path and the append-only tail-read path below go through this; the
 * append-only path just discards everything before the tail it needs). Deliberately NOT reusing chats.js's
 * getChatInfo() (that function is shaped for "just the last message", this module needs every message) and NOT
 * importing anything from chats.js at all - same one-way-import-arrow reasoning chat-metadata-db.js's own header
 * documents (chats.js already imports THIS module to wire up search, so the arrow can't point back).
 * @param {string} filePath
 * @returns {Promise<object[]>} Every line, JSON-parsed, in file order (index 0 is the header row, same convention
 * trySaveChat()'s in-memory chatData array uses) - a line that fails to parse is skipped, not fatal.
 */
async function readChatFile(filePath) {
    return new Promise((resolve, reject) => {
        const items = [];
        const fileStream = fs.createReadStream(filePath);
        fileStream.on('error', (err) => err.code === 'ENOENT' ? resolve([]) : reject(err));
        const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
        rl.on('error', (err) => err.code === 'ENOENT' ? resolve([]) : reject(err));
        rl.on('line', (line) => {
            const parsed = tryParse(line);
            if (parsed) items.push(parsed);
        });
        rl.on('close', () => resolve(items));
    });
}

/**
 * Builds a chat-id (file path) -> owning group id map for every group in one pass - used to resolve
 * `characterOrGroupId` for group chats without a per-chat lookup (see this module's header). Bounded by group
 * count, not chat count, so it's cheap to build once per index build/catch-up pass regardless of corpus size.
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {Map<string, string>} chat file path -> group id
 */
function buildGroupChatOwnerMap(directories) {
    /** @type {Map<string, string>} */
    const map = new Map();
    if (!fs.existsSync(directories.groups)) {
        return map;
    }
    const groupFiles = fs.readdirSync(directories.groups).filter(f => f.endsWith('.json'));
    for (const groupFile of groupFiles) {
        try {
            const group = JSON.parse(fs.readFileSync(path.join(directories.groups, groupFile), 'utf8'));
            if (!Array.isArray(group.chats) || !group.id) continue;
            for (const chatId of group.chats) {
                map.set(path.join(directories.groupChats, `${chatId}.jsonl`), String(group.id));
            }
        } catch {
            // Skip an unreadable/corrupt group file - same tolerance chats.js's /search route already applies.
        }
    }
    return map;
}

/**
 * Derives `characterOrGroupId` for a chat file purely from its path shape plus (for a group chat only) the
 * owner map buildGroupChatOwnerMap() built - no per-chat metadata-store lookup needed, since chat-metadata-db.js
 * deliberately doesn't track ownership (see that module's own header).
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} filePath
 * @param {Map<string, string>} groupOwnerMap
 * @returns {string | null}
 */
function resolveOwnerId(directories, filePath, groupOwnerMap) {
    const dir = path.dirname(filePath);
    if (dir === directories.groupChats) {
        return groupOwnerMap.get(filePath) ?? null;
    }
    // A character's own chat subdirectory (directories.chats/<avatarName>/<file>.jsonl) - anything directly in
    // directories.chats itself (dir === directories.chats) is a root/ownerless chat, handled by the final `null`.
    if (dir !== directories.chats && dir.startsWith(directories.chats + path.sep)) {
        return `${path.basename(dir)}.png`;
    }
    return null;
}

/**
 * Full reindex of one chat: deletes every existing tantivy doc for it, re-reads the whole file, and re-adds one
 * doc per message. Used for a chat that's never been indexed, or whose message count went down since the last
 * catch-up (see this module's header on why a count decrease can't safely use the append-only path).
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {import('@oxdev03/node-tantivy-binding').Schema} schema
 * @param {import('@oxdev03/node-tantivy-binding').IndexWriter} writer
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} filePath
 * @param {Map<string, string>} groupOwnerMap
 * @returns {Promise<number>} The new indexed_message_count to persist
 */
async function reindexChatFully(tantivy, schema, writer, directories, filePath, groupOwnerMap) {
    writer.deleteDocumentsByTerm('chat_id', filePath);
    const items = await readChatFile(filePath);
    if (items.length <= 1) {
        return 0;
    }
    const ownerId = resolveOwnerId(directories, filePath, groupOwnerMap);
    const messages = items.slice(1);
    messages.forEach((message, messageIndex) => {
        if (!message || message.is_system) return;
        writer.addDocument(messageToTantivyDoc(tantivy, schema, {
            chatId: filePath,
            characterOrGroupId: ownerId,
            messageIndex,
            date: message.send_date != null ? String(message.send_date) : null,
            isUser: !!message.is_user,
            text: message.mes ?? '',
        }));
    });
    return messages.length;
}

/**
 * Append-only fast path: reads the chat file (unavoidable - the new tail messages' actual text has to come from
 * somewhere, and chat-metadata-db.js deliberately doesn't carry full message text - see that module's header),
 * but only `addDocument`s the messages at index >= `previousCount`, skipping the tantivy-indexing work (not the
 * file read) for everything already indexed. This is the cost this module's whole per-message-granularity design
 * exists to avoid paying on every single message sent - see this module's own header.
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {import('@oxdev03/node-tantivy-binding').Schema} schema
 * @param {import('@oxdev03/node-tantivy-binding').IndexWriter} writer
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} filePath
 * @param {number} previousCount
 * @param {Map<string, string>} groupOwnerMap
 * @returns {Promise<number>} The new indexed_message_count to persist
 */
async function reindexChatAppendOnly(tantivy, schema, writer, directories, filePath, previousCount, groupOwnerMap) {
    const items = await readChatFile(filePath);
    if (items.length <= 1) {
        return 0;
    }
    const ownerId = resolveOwnerId(directories, filePath, groupOwnerMap);
    const messages = items.slice(1);
    for (let messageIndex = previousCount; messageIndex < messages.length; messageIndex++) {
        const message = messages[messageIndex];
        if (!message || message.is_system) continue;
        writer.addDocument(messageToTantivyDoc(tantivy, schema, {
            chatId: filePath,
            characterOrGroupId: ownerId,
            messageIndex,
            date: message.send_date != null ? String(message.send_date) : null,
            isUser: !!message.is_user,
            text: message.mes ?? '',
        }));
    }
    return messages.length;
}

/**
 * (Re)builds the persistent on-disk tantivy message index for a user's ENTIRE chat corpus from scratch - the
 * initial-build / explicit-repair path, mirroring buildTantivyIndex() (characters-search-index.js) but walking
 * every chat file (character + group + root) instead of every character card.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @returns {Promise<{ index: import('@oxdev03/node-tantivy-binding').Index, schema: import('@oxdev03/node-tantivy-binding').Schema, close: () => void, lastRev: number }>}
 */
async function buildFullIndex(directories, tantivy) {
    const lastRev = await getLatestRev(directories);

    const dbDir = path.join(directories.root, 'search-index');
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    const indexDir = tantivyIndexDir(directories);
    fs.rmSync(indexDir, { recursive: true, force: true });
    fs.mkdirSync(indexDir, { recursive: true });

    const schema = buildMessageSchema(tantivy);
    const index = new tantivy.Index(schema, indexDir, false);
    const writer = index.writer();
    const groupOwnerMap = buildGroupChatOwnerMap(directories);

    /** @type {string[]} */
    const allChatFiles = [];
    if (fs.existsSync(directories.chats)) {
        for (const entry of fs.readdirSync(directories.chats, { withFileTypes: true })) {
            if (entry.isFile() && entry.name.endsWith('.jsonl')) {
                allChatFiles.push(path.join(directories.chats, entry.name));
            } else if (entry.isDirectory()) {
                const subDir = path.join(directories.chats, entry.name);
                for (const file of fs.readdirSync(subDir)) {
                    if (file.endsWith('.jsonl')) allChatFiles.push(path.join(subDir, file));
                }
            }
        }
    }
    if (fs.existsSync(directories.groupChats)) {
        for (const file of fs.readdirSync(directories.groupChats)) {
            if (file.endsWith('.jsonl')) allChatFiles.push(path.join(directories.groupChats, file));
        }
    }

    let chatIndex = 0;
    for (const filePath of allChatFiles) {
        const newCount = await reindexChatFully(tantivy, schema, writer, directories, filePath, groupOwnerMap);
        await setIndexedMessageCount(directories, filePath, newCount);

        chatIndex++;
        if (chatIndex % CHECKPOINT_EVERY_N_CHATS === 0) {
            writer.commit();
        }
    }

    writer.commit();
    index.reload();
    // Releases this writer's on-disk lock deterministically before any later caller (an incremental catch-up
    // against this same handle, or a background rebuild racing in via the coordinator) requests a new one - see
    // buildTantivyIndex()'s matching comment in characters-search-index.js for the confirmed LockBusy failure
    // mode this call avoids.
    writer.waitMergingThreads();

    await setMetaValue(directories, TANTIVY_REV_META_KEY, String(lastRev));
    return { index, schema, close: NOOP_CLOSE, lastRev };
}

/**
 * Applies every chat change since `sinceRev` to an already-open index/writer, in place - the incremental
 * counterpart to buildFullIndex() above, mirroring applyIncrementalTantivyChanges() (characters-search-index.js)
 * in structure but branching per-chat between the append-only fast path and a full per-chat reindex (see this
 * module's header for exactly when each applies).
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {import('@oxdev03/node-tantivy-binding').Index} index
 * @param {import('@oxdev03/node-tantivy-binding').Schema} schema
 * @param {number | null} sinceRev
 * @returns {Promise<{ lastRev: number } | null>} `null` if incremental maintenance isn't possible (metadata store
 * unavailable) - the caller must fall back to buildFullIndex() in that case.
 */
async function applyIncrementalChanges(directories, tantivy, index, schema, sinceRev) {
    const currentRev = await getLatestRev(directories);
    const changes = await getChangesSince(directories, Number.isFinite(sinceRev) ? sinceRev : 0);

    if (changes.length === 0) {
        return { lastRev: currentRev };
    }

    /** @type {Map<string, 'upsert'|'delete'>} */
    const toProcess = new Map(changes.map(c => [c.file_path, c.op]));
    const groupOwnerMap = buildGroupChatOwnerMap(directories);
    const writer = index.writer();

    for (const [filePath, op] of toProcess) {
        if (op === 'delete') {
            writer.deleteDocumentsByTerm('chat_id', filePath);
            continue;
        }

        const row = await getChatRow(directories, filePath);
        if (!row) {
            // The row is gone (raced a delete that landed after this change was logged but before this catch-up
            // ran) - nothing to index, and any stale docs for it will be cleaned up by that delete's own change
            // once this loop reaches it (Map dedup above already keeps only the LATEST op per file, so a
            // delete-after-upsert in the same batch is handled correctly; a delete in a LATER batch is handled
            // next time this function runs).
            continue;
        }

        const previousCount = await getIndexedMessageCount(directories, filePath);
        let newCount;
        if (previousCount < 0 || row.message_count < previousCount) {
            newCount = await reindexChatFully(tantivy, schema, writer, directories, filePath, groupOwnerMap);
        } else if (row.message_count > previousCount) {
            newCount = await reindexChatAppendOnly(tantivy, schema, writer, directories, filePath, previousCount, groupOwnerMap);
        } else {
            // No message-count change - see this module's header on the same-count-edit gap this leaves open.
            continue;
        }
        await setIndexedMessageCount(directories, filePath, newCount);
    }

    writer.commit();
    index.reload();
    writer.waitMergingThreads();

    return { lastRev: currentRev };
}

/**
 * Opens the persisted on-disk index as-is, no catch-up - search-index-coordinator.js's `openStale` hook for this
 * index, same cold-start-incident rationale as openPersistedTantivyIndexStale() (characters-search-index.js): a
 * boot-time bulk import leaves a large catch-up backlog, and this lets the FIRST search after that serve
 * whatever was last persisted immediately while the real catch-up runs in the background, instead of blocking.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @returns {Promise<{ index: import('@oxdev03/node-tantivy-binding').Index, schema: import('@oxdev03/node-tantivy-binding').Schema, close: () => void, lastRev: number } | null>}
 */
async function openPersistedIndexStale(directories, tantivy) {
    const indexDir = tantivyIndexDir(directories);
    const persistedRev = await getMetaValue(directories, TANTIVY_REV_META_KEY);
    if (persistedRev === null) return null;
    try {
        if (!tantivy.Index.exists(indexDir)) return null;
        const index = tantivy.Index.open(indexDir);
        return { index, schema: index.schema, close: NOOP_CLOSE, lastRev: Number(persistedRev) };
    } catch (err) {
        console.error(color.red('[search] failed to reopen the persisted chat content tantivy index, falling back to a full rebuild:'));
        console.error(color.red(`[search]   ${err.message}`));
        return null;
    }
}

/**
 * The `build` callback handed to indexCoordinator.getIndex() - updates an already-open handle incrementally when
 * possible, falls back to a full rebuild otherwise. Same role loadOrUpdateTantivyIndex() plays in
 * characters-search-index.js.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {Awaited<ReturnType<typeof buildFullIndex>> | undefined} previous
 * @returns {Promise<Awaited<ReturnType<typeof buildFullIndex>>>}
 */
async function loadOrUpdateIndex(directories, tantivy, previous) {
    if (previous?.index) {
        const updated = await applyIncrementalChanges(directories, tantivy, previous.index, previous.schema, previous.lastRev);
        if (updated) {
            await setMetaValue(directories, TANTIVY_REV_META_KEY, String(updated.lastRev));
            return { ...previous, ...updated };
        }
    }
    return buildFullIndex(directories, tantivy);
}

/**
 * Groups tantivy message hits back to their parent chats - the resolution step every per-message-granularity
 * index needs (same "search returns ids, resolve separately" pattern searchCharacterIds()'s callers already use
 * in characters-search-index.js/characters.js, just grouping instead of a 1:1 id resolve). Each parent chat's
 * ChatInfo comes straight from chat-metadata-db.js's own cache (getChatRow()) - no file read here, since that
 * store already has everything /api/chats/search's response shape needs (message_count/last_mes/preview/size).
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {{ raw: string, score: number }[]} hits Tantivy hits, `raw` being DATA_FIELD's JSON payload
 * @returns {Promise<{ file_name: string, file_size: string|undefined, message_count: number, last_mes: string|null, preview_message: string, best_score: number, match_count: number }[]>}
 * Best-score-first, one entry per distinct chat (a chat with multiple matching messages collapses to one entry,
 * keeping its single best-scoring hit's score and a count of how many of its messages matched).
 */
export async function resolveHitsToChats(directories, hits) {
    /** @type {Map<string, { bestScore: number, matchCount: number }>} */
    const byChat = new Map();
    for (const hit of hits) {
        const payload = tryParse(hit.raw);
        if (!payload?.chatId) continue;
        const existing = byChat.get(payload.chatId);
        if (!existing) {
            byChat.set(payload.chatId, { bestScore: hit.score, matchCount: 1 });
        } else {
            existing.matchCount++;
            if (hit.score < existing.bestScore) existing.bestScore = hit.score;
        }
    }

    const entries = [...byChat.entries()].sort((a, b) => a[1].bestScore - b[1].bestScore);

    const results = [];
    for (const [filePath, { bestScore, matchCount }] of entries) {
        const row = await getChatRow(directories, filePath);
        if (!row) continue;
        results.push({
            file_path: filePath,
            file_name: row.file_name.replace(/\.jsonl$/, ''),
            // The client (public/script.js's displayChats()) renders this directly into the chat-list row
            // ("(12.3 KB, 5 messages)") - has to be the same human-readable formatted string every other
            // /api/chats/search result already carries (getOrComputeChatInfo()/getChatInfo() both format via
            // this same formatBytes()), not the raw byte count chat-metadata-db.js's row stores it as.
            file_size: formatBytes(row.file_size),
            message_count: row.message_count,
            last_mes: row.last_mes,
            preview_message: row.preview ?? '',
            best_score: bestScore,
            match_count: matchCount,
        });
    }
    return results;
}

/**
 * Full-text-searches a user's chat message content and resolves hits back to their parent chats - the main entry
 * point chats.js wires `/api/chats/search`'s query branch to. Returns `{ backend: 'unavailable' }` (empty
 * results) if tantivy can't load on this install - see this module's header on why chats.js's caller keeps its
 * pre-existing full-file-scan fallback for exactly that case, rather than this module needing a second engine
 * tier itself.
 * @param {string} handle
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} searchTerm
 * @param {number} [maxRows]
 * @returns {Promise<{ results: Awaited<ReturnType<typeof resolveHitsToChats>>, backend: 'tantivy' | 'unavailable' }>}
 */
export async function searchChatMessages(handle, directories, searchTerm, maxRows = DEFAULT_MESSAGE_MAX_ROWS) {
    const tantivy = await getTantivyModule();
    if (!tantivy) {
        return { results: [], backend: 'unavailable' };
    }

    const signature = String(await getLatestRev(directories));
    const index = await indexCoordinator.getIndex(
        handle, signature,
        (previous) => loadOrUpdateIndex(directories, tantivy, previous),
        () => openPersistedIndexStale(directories, tantivy),
    );

    const query = buildTantivyQuery(tantivy, index.schema, searchTerm, FIELD_WEIGHTS, FIELD_LABELS);
    if (!query) {
        return { results: [], backend: 'tantivy' };
    }

    const { results: hits } = runTantivySearch(index.index, query, maxRows);
    const results = await resolveHitsToChats(directories, hits);
    return { results, backend: 'tantivy' };
}

/**
 * Forces an immediate, blocking, full rebuild - the explicit repair path, same role rebuildCharacterSearchIndex()
 * plays for character search.
 * @param {string} handle
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {Promise<{ ok: boolean, backend: 'tantivy' | 'unavailable' }>}
 */
export async function rebuildChatContentIndex(handle, directories) {
    const tantivy = await getTantivyModule();
    if (!tantivy) {
        return { ok: false, backend: 'unavailable' };
    }
    const signature = String(await getLatestRev(directories));
    await indexCoordinator.forceRebuild(handle, signature, () => buildFullIndex(directories, tantivy));
    return { ok: true, backend: 'tantivy' };
}
