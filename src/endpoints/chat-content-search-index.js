import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import {
    getIndexedMessageCount, setIndexedMessageCount, getMetaValue, setMetaValue,
    getLatestSeq, getChangesSince, getChatRow,
} from '../chat-metadata-db.js';
import { buildSearchQuery as buildTantivyQuery, runSearch as runTantivySearch } from './tantivy-search.js';
import { getTantivyModule } from './tantivy-engine.js';
import { createIndexCoordinator } from './search-index-coordinator.js';
import { tryParse, color, formatBytes } from '../util.js';

/**
 * A per-user, per-message tantivy full-text index over chat content.
 *
 * One tantivy document per message, not per chat: tantivy has no partial-document update, so per-chat docs
 * would mean re-embedding a chat's entire text on every message sent. Per-message docs mean an ordinary send
 * only needs one small addDocument - see applyIncrementalChanges() below.
 *
 * Incremental catch-up compares each changed chat's message_count against its indexed_message_count watermark:
 * grew -> append-only (only new tail messages added); shrank or never indexed -> full per-chat reindex.
 *
 * Known gap: a same-message-count edit (a swipe/regenerate) is invisible to the append-only path - the old text
 * stays searchable until something else touches that chat again. No reconciler backstop exists to self-correct
 * this (unlike character-metadata-db.js). Could be closed by also tracking each chat's change_seq.
 *
 * Tantivy-only, no SQLite FTS5 fallback tier - chats.js's caller falls back to a full-file readline scan when
 * tantivy is unavailable.
 */

/** Stored field holding the small JSON payload needed to resolve a hit back to its parent chat and message. */
const DATA_FIELD = 'data';

const SEARCHABLE_FIELD_NAME = 'text';
const FIELD_WEIGHTS = { [SEARCHABLE_FIELD_NAME]: 1 };
const FIELD_LABELS = {};

const CHECKPOINT_EVERY_N_CHATS = 100;

/** Sized larger than a chat-list page since many hits collapse into the same chat in resolveHitsToChats(). */
const DEFAULT_MESSAGE_MAX_ROWS = 2000;

const TANTIVY_SEQ_META_KEY = 'chat_content_index_seq';

const NOOP_CLOSE = () => { /* no explicit close API on this binding's Index */ };

/** @type {ReturnType<typeof createIndexCoordinator>} */
const indexCoordinator = createIndexCoordinator();

function buildMessageSchema(tantivy) {
    const builder = new tantivy.SchemaBuilder();
    builder.addTextField(SEARCHABLE_FIELD_NAME, { stored: false, tokenizerName: 'default', indexOption: 'position' });
    // raw-tokenized + stored: exact-match only, never splits into search tokens, also the delete-by-term key.
    builder.addTextField(DATA_FIELD, { stored: true, tokenizerName: 'raw', indexOption: 'basic' });
    // Separate indexed field (not just inside `data`) so deleteDocumentsByTerm() can target one chat directly.
    builder.addTextField('chat_id', { stored: true, tokenizerName: 'raw', indexOption: 'basic' });
    return builder.build();
}

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

function tantivyIndexDir(directories) {
    return path.join(directories.root, 'search-index', 'chat-content-tantivy');
}

/**
 * Parses a `.jsonl` chat file into its raw header + message items (index 0 is the header row). Not reusing
 * chats.js's getChatInfo() (shaped for just the last message) and not importing chats.js at all - it already
 * imports this module, so the arrow can't point back. A line that fails to parse is skipped, not fatal.
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

/** chat file path -> owning group id, for every group in one pass. Bounded by group count, not chat count.
 * @returns {Map<string, string>} */
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
            // Skip an unreadable/corrupt group file.
        }
    }
    return map;
}

/** Derives characterOrGroupId for a chat file purely from its path shape, plus the group owner map for group
 * chats - chat-metadata-db.js doesn't track ownership itself.
 * @returns {string | null} */
function resolveOwnerId(directories, filePath, groupOwnerMap) {
    const dir = path.dirname(filePath);
    if (dir === directories.groupChats) {
        return groupOwnerMap.get(filePath) ?? null;
    }
    // dir === directories.chats itself is a root/ownerless chat, handled by the final null.
    if (dir !== directories.chats && dir.startsWith(directories.chats + path.sep)) {
        return `${path.basename(dir)}.png`;
    }
    return null;
}

/**
 * Full reindex of one chat: deletes every existing tantivy doc for it, re-reads the whole file, and re-adds one
 * doc per message. Used for a never-indexed chat, or one whose message count went down since last catch-up.
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
 * Append-only fast path: reads the chat file (unavoidable - chat-metadata-db.js doesn't carry full message
 * text), but only addDocuments the messages at index >= previousCount.
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

/** (Re)builds the persistent on-disk tantivy message index for a user's entire chat corpus from scratch -
 * the initial-build / explicit-repair path, walking every chat file (character + group + root). */
async function buildFullIndex(directories, tantivy) {
    const lastSeq = await getLatestSeq(directories);

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

    await setMetaValue(directories, TANTIVY_SEQ_META_KEY, String(lastSeq));
    return { index, schema, close: NOOP_CLOSE, lastSeq };
}

/**
 * Applies every chat change since `sinceSeq` to an already-open index/writer, in place - the incremental
 * counterpart to buildFullIndex() above, mirroring applyIncrementalTantivyChanges() (characters-search-index.js)
 * in structure but branching per-chat between the append-only fast path and a full per-chat reindex (see this
 * module's header for exactly when each applies).
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @param {import('@oxdev03/node-tantivy-binding').Index} index
 * @param {import('@oxdev03/node-tantivy-binding').Schema} schema
 * @param {number | null} sinceSeq
 * @returns {Promise<{ lastSeq: number } | null>} `null` if incremental maintenance isn't possible (metadata store
 * unavailable) - the caller must fall back to buildFullIndex() in that case.
 */
async function applyIncrementalChanges(directories, tantivy, index, schema, sinceSeq) {
    const currentSeq = await getLatestSeq(directories);
    const changes = await getChangesSince(directories, Number.isFinite(sinceSeq) ? sinceSeq : 0);

    if (changes.length === 0) {
        return { lastSeq: currentSeq };
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

    return { lastSeq: currentSeq };
}

/**
 * Opens the persisted on-disk index as-is, no catch-up - search-index-coordinator.js's `openStale` hook for this
 * index, same cold-start-incident rationale as openPersistedTantivyIndexStale() (characters-search-index.js): a
 * boot-time bulk import leaves a large catch-up backlog, and this lets the FIRST search after that serve
 * whatever was last persisted immediately while the real catch-up runs in the background, instead of blocking.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {typeof import('@oxdev03/node-tantivy-binding')} tantivy
 * @returns {Promise<{ index: import('@oxdev03/node-tantivy-binding').Index, schema: import('@oxdev03/node-tantivy-binding').Schema, close: () => void, lastSeq: number } | null>}
 */
async function openPersistedIndexStale(directories, tantivy) {
    const indexDir = tantivyIndexDir(directories);
    const persistedSeq = await getMetaValue(directories, TANTIVY_SEQ_META_KEY);
    if (persistedSeq === null) return null;
    try {
        if (!tantivy.Index.exists(indexDir)) return null;
        const index = tantivy.Index.open(indexDir);
        return { index, schema: index.schema, close: NOOP_CLOSE, lastSeq: Number(persistedSeq) };
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
        const updated = await applyIncrementalChanges(directories, tantivy, previous.index, previous.schema, previous.lastSeq);
        if (updated) {
            await setMetaValue(directories, TANTIVY_SEQ_META_KEY, String(updated.lastSeq));
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

    const signature = String(await getLatestSeq(directories));
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
    const signature = String(await getLatestSeq(directories));
    await indexCoordinator.forceRebuild(handle, signature, () => buildFullIndex(directories, tantivy));
    return { ok: true, backend: 'tantivy' };
}
