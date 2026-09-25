import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
    getTagDefinitions, getEntityTagIdsForMany, getTagsHash,
    getChangesSince, getCurrentSeq, getCurrentTagNameChangeSeq, getTagNameChangesSince, streamCharacterIdsForTagIds, streamCharacterCardJsonBatches,
    getMetaValue, setMetaValue, getCharacterFavsByIds, getCardJsonByIds,
    characterChangeEmitter,
} from '../character-metadata-db.js';
import { processCharacter } from './characters.js';
import { buildSchema as buildTantivySchema, buildSearchQuery as buildTantivyQuery, runSearch as runTantivySearch, DATA_FIELD, FAV_FIELD, buildTagFilterQuery, buildExcludeIdsQuery, stringToSortKey } from './tantivy-search.js';
import { resolveSearchEngine } from './search-engine.js';
import { createIndexCoordinator } from './search-index-coordinator.js';
import { getConfigValue, mapWithConcurrency, color } from '../util.js';

// Mirrors fuzzySearchCharacters() (public/scripts/power-user.js) so ranking is consistent client/server.
const BM25_INDEXED_COLUMNS = ['name', 'resolved_tags', 'description', 'mes_example', 'scenario', 'personality', 'first_mes', 'creator_notes', 'creator', 'tags', 'alternate_greetings'];
const BM25_WEIGHTS = [20, 10, 3, 3, 2, 2, 2, 2, 1, 1, 1];

// Fast fields for native tantivy sorting (orderByField), avoiding a full-match-set SQLite round trip.
const TANTIVY_FAST_FIELDS = ['create_date', 'date_added', 'date_last_chat', 'chat_size', 'data_size'];

// name_sort_key: first 6 bytes of the lowercased name as a u64 sort key.
// fav_name_sort_key: bit 48 = inverted fav, bits 0-47 = name_sort_key. ASC gives favorites-first-then-alpha.
const TANTIVY_COLLATION_FIELDS = ['name_sort_key', 'fav_name_sort_key'];
const ALL_FAST_FIELDS = [...TANTIVY_FAST_FIELDS, ...TANTIVY_COLLATION_FIELDS];

const TANTIVY_FILTER_TEXT_FIELDS = [{ name: 'tag_ids', tokenizerName: 'whitespace' }];

const TAG_IDS_FIELD = 'tag_ids';

export const TANTIVY_SORT_FIELDS = new Set([...TANTIVY_FAST_FIELDS, 'name', 'fav']);

const SORT_FIELD_TO_TANTIVY_FIELD = {
    create_date: 'create_date',
    date_added: 'date_added',
    date_last_chat: 'date_last_chat',
    chat_size: 'chat_size',
    data_size: 'data_size',
    name: 'name_sort_key',
    fav: 'fav_name_sort_key',
};

export { SORT_FIELD_TO_TANTIVY_FIELD };

// Bump whenever characterToTantivyDoc()'s schema shape or field encoding changes; a mismatch forces a rebuild.
const TANTIVY_SCHEMA_VERSION = 4;

// `tag:`/`tags:` maps to both tag-ish fields since BM25_WEIGHTS treats resolved_tags and tags as the same concept.
const TANTIVY_FIELD_WEIGHTS = Object.fromEntries(BM25_INDEXED_COLUMNS.map((name, i) => [name, BM25_WEIGHTS[i]]));
const TANTIVY_FIELD_LABELS = {
    name: ['name'],
    tag: ['resolved_tags', 'tags'],
    tags: ['resolved_tags', 'tags'],
    desc: ['description'],
    description: ['description'],
    example: ['mes_example'],
    scenario: ['scenario'],
    personality: ['personality'],
    greeting: ['first_mes'],
    notes: ['creator_notes'],
    creator: ['creator'],
    from: ['creator'],
    by: ['creator'],
    author: ['creator'],
    alt: ['alternate_greetings'],
    alternate: ['alternate_greetings'],
};

const indexCoordinator = createIndexCoordinator();

// Prefers the metadata store's change-log seq over a directory stat() (can't miss a same-mtime edit);
// falls back to mtime only if the metadata store is unavailable.
async function getFreshnessSignature(directories) {
    const tagsHash = await getTagsHash(directories);
    const seq = await getCurrentSeq(directories);
    if (seq === null) {
        const charDirMtime = fs.statSync(directories.characters).mtimeMs;
        return `mtime:${charDirMtime}:${tagsHash}`;
    }
    return `rev:${seq}:${tagsHash}`;
}

// Bounds peak memory during (re)build regardless of library size.
const INDEX_BUILD_BATCH_SIZE = 500;

// Mirrors characters.js's DEFAULT_PAGE_LIMIT.
const DEFAULT_TANTIVY_MAX_ROWS = 500;

const TANTIVY_INDEX_SEQ_META_KEY = 'tantivy_char_index_seq';
const TANTIVY_INDEX_TAG_NAME_CHANGE_SEQ_META_KEY = 'tantivy_char_index_tag_name_change_seq';
const TANTIVY_INDEX_SCHEMA_VERSION_META_KEY = 'tantivy_char_index_schema_version';

const CHECKPOINT_EVERY_N_BATCHES = 20;

const INDEX_BUILD_READ_CONCURRENCY = getConfigValue('performance.characterIndexBuildConcurrency', 64, 'number');

// Fetches tags for the given avatars up front so this costs two batched reads total, not one per character.
async function makeTagNamesResolver(directories, avatars) {
    const [definitions, assignments] = await Promise.all([
        getTagDefinitions(directories),
        getEntityTagIdsForMany(directories, avatars),
    ]);
    const tagsById = new Map((definitions ?? []).map(tag => [tag.id, tag]));
    return (avatar) => (assignments?.[avatar] ?? [])
        .map(id => tagsById.get(id)?.name)
        .filter(Boolean)
        .join(' ');
}

// The db's `fav` column is authoritative once a row is tracked; falls back to the card's embedded
// `data.extensions.fav` for a character the metadata store hasn't picked up yet.
async function makeFavResolver(directories, avatars) {
    const favById = await getCharacterFavsByIds(directories, avatars);
    return (character) => Object.prototype.hasOwnProperty.call(favById, character.avatar)
        ? favById[character.avatar]
        : Boolean(character.data?.extensions?.fav);
}

async function makeTagIdsResolver(directories, avatars) {
    const assignments = await getEntityTagIdsForMany(directories, avatars);
    return (avatar) => (assignments?.[avatar] ?? []).join(' ');
}

// This binding has no explicit index-handle-close API.
const NOOP_CLOSE = () => { };

function characterToTantivyDoc(tantivy, schema, character, tagNamesFor, favFor, tagIdsFor) {
    return tantivy.Document.fromDict({
        name: character.data?.name ?? '',
        resolved_tags: tagNamesFor(character.avatar),
        description: character.data?.description ?? '',
        mes_example: character.data?.mes_example ?? '',
        scenario: character.data?.scenario ?? '',
        personality: character.data?.personality ?? '',
        first_mes: character.data?.first_mes ?? '',
        creator_notes: character.data?.creator_notes ?? '',
        creator: character.data?.creator ?? '',
        tags: Array.isArray(character.data?.tags) ? character.data.tags.join(' ') : '',
        alternate_greetings: Array.isArray(character.data?.alternate_greetings) ? character.data.alternate_greetings.join(' ') : '',
        create_date: Math.max(0, Date.parse(character.create_date) || character.date_added || 0),
        date_added: Math.max(0, Number(character.date_added) || 0),
        date_last_chat: Math.max(0, Number(character.date_last_chat) || 0),
        chat_size: Math.max(0, Number(character.chat_size) || 0),
        data_size: Math.max(0, Number(character.data_size) || 0),
        name_sort_key: stringToSortKey(character.data?.name ?? ''),
        fav_name_sort_key: (favFor(character) ? 0 : 1) * (2 ** 48) + stringToSortKey(character.data?.name ?? '', 6),
        tag_ids: tagIdsFor(character.avatar),
        [DATA_FIELD]: character.avatar,
        [FAV_FIELD]: favFor(character),
    }, schema);
}

function tantivyIndexDir(directories) {
    return path.join(directories.root, 'search-index', 'characters-tantivy');
}

// Sibling of tantivyIndexDir() on the same filesystem, so swapTantivyIndexIntoPlace() can rename atomically.
function tantivyIndexTempDir(directories) {
    return path.join(directories.root, 'search-index', `characters-tantivy.rebuild-${crypto.randomUUID()}`);
}

// Cleans up rebuild-*/old-* temp dirs left behind by a build that crashed before its swap ran.
function cleanupStaleTantivyRebuildTempDirs(directories) {
    const dbDir = path.join(directories.root, 'search-index');
    if (!fs.existsSync(dbDir)) {
        return;
    }
    for (const entry of fs.readdirSync(dbDir)) {
        if (entry.startsWith('characters-tantivy.rebuild-') || entry.startsWith('characters-tantivy.old-')) {
            fs.rmSync(path.join(dbDir, entry), { recursive: true, force: true });
        }
    }
}

// Atomically swaps a fully-built tempDir index into place at indexDir (two renames: old aside, new in, old
// removed) so a build that crashes partway never leaves indexDir missing or half-written.
function swapTantivyIndexIntoPlace(indexDir, tempDir) {
    if (fs.existsSync(indexDir)) {
        const oldDir = `${indexDir}.old-${crypto.randomUUID()}`;
        fs.renameSync(indexDir, oldDir);
        fs.renameSync(tempDir, indexDir);
        fs.rmSync(oldDir, { recursive: true, force: true });
    } else {
        fs.renameSync(tempDir, indexDir);
    }
}

// Must be called on indexDir right after swapTantivyIndexIntoPlace(): an Index still pointing at the
// renamed-away tempDir silently no-ops on later writes instead of erroring.
function reopenTantivyIndexAt(tantivy, dir) {
    const index = tantivy.Index.open(dir);
    return { index, schema: index.schema };
}

function createEmptyTantivyIndexAt(tantivy, dir) {
    fs.mkdirSync(dir, { recursive: true });
    const schema = buildTantivySchema(tantivy, BM25_INDEXED_COLUMNS, ALL_FAST_FIELDS, TANTIVY_FILTER_TEXT_FIELDS);
    const index = new tantivy.Index(schema, dir, false);
    return { index, schema };
}

// Fresh build: streams every characters row into a brand-new index in a temp dir, then swaps it into place.
// The watermarks are read before the stream starts, so the next incremental catch-up picks up whatever changed
// during it. Returns null when the metadata store is unavailable: it is the only source of truth, so there is
// no index.
async function rebuildTantivyIndexFromScratch(directories, tantivy) {
    const lastSeq = await getCurrentSeq(directories);
    const lastTagNameChangeSeq = await getCurrentTagNameChangeSeq(directories);
    if (lastSeq === null || lastTagNameChangeSeq === null) {
        return null;
    }

    const dbDir = path.join(directories.root, 'search-index');
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }
    cleanupStaleTantivyRebuildTempDirs(directories);

    const indexDir = tantivyIndexDir(directories);
    const tempDir = tantivyIndexTempDir(directories);
    const { index, schema } = createEmptyTantivyIndexAt(tantivy, tempDir);
    const writer = index.writer();
    try {
        let batchIndex = 0;
        // Each streamed batch is one unit: its card_json came with it, and its tag/fav lookups cover exactly it.
        for await (const rows of streamCharacterCardJsonBatches(directories)) {
            await addCharacterBatch(directories, tantivy, schema, writer, rows.map(row => row.id), new Map(rows.map(row => [row.id, row.card_json])));
            batchIndex++;
            if (batchIndex % CHECKPOINT_EVERY_N_BATCHES === 0) {
                writer.commit();
            }
        }
        writer.commit();
        index.reload();
    } finally {
        // commit() alone does not release the writer's on-disk lock; waitMergingThreads() does.
        writer.waitMergingThreads();
    }

    swapTantivyIndexIntoPlace(indexDir, tempDir);
    const reopened = reopenTantivyIndexAt(tantivy, indexDir);

    await setMetaValue(directories, TANTIVY_INDEX_SEQ_META_KEY, String(lastSeq));
    await setMetaValue(directories, TANTIVY_INDEX_TAG_NAME_CHANGE_SEQ_META_KEY, String(lastTagNameChangeSeq));
    await setMetaValue(directories, TANTIVY_INDEX_SCHEMA_VERSION_META_KEY, String(TANTIVY_SCHEMA_VERSION));

    return { ...reopened, close: NOOP_CLOSE, lastSeq, lastTagNameChangeSeq };
}

// Delete-then-add for every touched id, including updates: tantivy has no update-in-place.
// Reads the change log one page at a time and commits each page before reading the next; onPageCommitted, if
// given, gets that page's watermark(s) right after its commit.
// Returns null if incremental maintenance isn't possible (store unavailable, or change log truncated
// past its watermark) - caller must fall back to a full rebuild.
async function applyIncrementalTantivyChanges(directories, tantivy, index, schema, sinceSeq, sinceTagNameChangeSeq, onPageCommitted = async () => { }) {
    if (await getCurrentSeq(directories) === null) {
        return null;
    }

    let writer = null;
    const getWriter = () => writer ?? (writer = index.writer());

    try {
        let lastSeq = Number.isFinite(sinceSeq) ? sinceSeq : 0;
        for (;;) {
            const page = await getChangesSince(directories, lastSeq, { limit: INDEX_BUILD_BATCH_SIZE });
            if (!page || page.truncated) {
                return null;
            }
            if (page.changes.length > 0) {
                const w = getWriter();
                // Delete-by-term up front for every touched id; upserts need their old doc gone too.
                for (const { id } of page.changes) {
                    w.deleteDocumentsByTerm(DATA_FIELD, id);
                }
                await addCharacterDocs(directories, tantivy, schema, w, page.changes.filter(({ op }) => op !== 'delete').map(({ id }) => id));
                w.commit();
            }
            lastSeq = page.seq;
            await onPageCommitted({ lastSeq });
            if (!page.hasMore) break;
        }

        // A tag rename doesn't produce a `changes` row for the characters carrying it, so it's tracked separately.
        let lastTagNameChangeSeq = Number.isFinite(sinceTagNameChangeSeq) ? sinceTagNameChangeSeq : 0;
        for (;;) {
            const page = await getTagNameChangesSince(directories, lastTagNameChangeSeq, { limit: INDEX_BUILD_BATCH_SIZE });
            if (!page || page.truncated) {
                return null;
            }
            if (page.tagIds.length > 0) {
                for await (const affectedIds of streamCharacterIdsForTagIds(directories, page.tagIds)) {
                    const w = getWriter();
                    for (const id of affectedIds) {
                        w.deleteDocumentsByTerm(DATA_FIELD, id);
                    }
                    await addCharacterDocs(directories, tantivy, schema, w, affectedIds);
                }
                writer?.commit();
            }
            lastTagNameChangeSeq = page.seq;
            await onPageCommitted({ lastTagNameChangeSeq });
            if (!page.hasMore) break;
        }

        return { lastSeq, lastTagNameChangeSeq };
    } finally {
        if (writer) {
            index.reload();
            // commit() alone does not release the writer's on-disk lock; waitMergingThreads() does.
            writer.waitMergingThreads();
        }
    }
}

// Adds a doc per id, INDEX_BUILD_BATCH_SIZE ids at a time, reading each batch's card_json by id.
async function addCharacterDocs(directories, tantivy, schema, writer, ids) {
    for (let i = 0; i < ids.length; i += INDEX_BUILD_BATCH_SIZE) {
        const batchIds = ids.slice(i, i + INDEX_BUILD_BATCH_SIZE);
        await addCharacterBatch(directories, tantivy, schema, writer, batchIds, await getCardJsonByIds(directories, batchIds));
    }
}

// Adds a doc per id as one unit: tag/fav lookups cover exactly these ids. An id with no card_json has no row -
// it was deleted after the change being applied - so it isn't indexed.
async function addCharacterBatch(directories, tantivy, schema, writer, batchIds, cardJsonById) {
    const ids = batchIds.filter(id => cardJsonById.has(id));
    if (ids.length === 0) return;
    const tagNamesFor = await makeTagNamesResolver(directories, ids);
    const favFor = await makeFavResolver(directories, ids);
    const tagIdsFor = await makeTagIdsResolver(directories, ids);
    const characters = await mapWithConcurrency(ids, INDEX_BUILD_READ_CONCURRENCY, async (id) => {
        try {
            return await processCharacter(id, directories, { shallow: false, cardJson: cardJsonById.get(id) });
        } catch {
            // File gone or corrupt - leave it deleted rather than throwing the whole pass away.
            return null;
        }
    });
    for (const character of characters) {
        if (!character?.name) continue;
        writer.addDocument(characterToTantivyDoc(tantivy, schema, character, tagNamesFor, favFor, tagIdsFor));
    }
}

// Opens the persisted index as-is (no catch-up, no watermark write) so a first request can serve whatever
// was last committed while the real catch-up runs in the background instead of blocking.
// Returns null if nothing usable is persisted; caller falls back to a full build.
async function openPersistedTantivyIndexStale(directories, tantivy) {
    const indexDir = tantivyIndexDir(directories);
    const persistedSeq = await getMetaValue(directories, TANTIVY_INDEX_SEQ_META_KEY);
    if (persistedSeq === null) {
        return null;
    }
    try {
        if (!tantivy.Index.exists(indexDir)) {
            return null;
        }
        const index = tantivy.Index.open(indexDir);
        const schema = index.schema;

        const persistedSchemaVersion = await getMetaValue(directories, TANTIVY_INDEX_SCHEMA_VERSION_META_KEY);
        // A persisted index built under a different schema version can't be trusted.
        if (Number(persistedSchemaVersion) !== TANTIVY_SCHEMA_VERSION) {
            return null;
        }

        const persistedTagNameChangeSeq = await getMetaValue(directories, TANTIVY_INDEX_TAG_NAME_CHANGE_SEQ_META_KEY);
        return { index, schema, close: NOOP_CLOSE, lastSeq: Number(persistedSeq), lastTagNameChangeSeq: persistedTagNameChangeSeq !== null ? Number(persistedTagNameChangeSeq) : null };
    } catch (err) {
        console.error(color.red('[search] failed to reopen the persisted character tantivy index, falling back to a full rebuild:'));
        console.error(color.red(`[search]   ${err.message}`));
        return null;
    }
}

// Updates an already-open handle in place when possible, else falls back to a full rebuild.
// Returns null when the metadata store is unavailable.
async function loadOrUpdateTantivyIndex(directories, tantivy, previous) {
    if (await getCurrentSeq(directories) === null) {
        return null;
    }

    if (previous?.index) {
        const updated = await applyIncrementalTantivyChanges(directories, tantivy, previous.index, previous.schema, previous.lastSeq, previous.lastTagNameChangeSeq ?? null, async ({ lastSeq, lastTagNameChangeSeq }) => {
            if (lastSeq !== undefined) {
                await setMetaValue(directories, TANTIVY_INDEX_SEQ_META_KEY, String(lastSeq));
            }
            if (lastTagNameChangeSeq !== undefined) {
                await setMetaValue(directories, TANTIVY_INDEX_TAG_NAME_CHANGE_SEQ_META_KEY, String(lastTagNameChangeSeq));
            }
        });
        if (updated) {
            await setMetaValue(directories, TANTIVY_INDEX_SCHEMA_VERSION_META_KEY, String(TANTIVY_SCHEMA_VERSION));
            return { ...previous, ...updated };
        }
    }

    return rebuildTantivyIndexFromScratch(directories, tantivy);
}

// getIndex() serves a stale index immediately and rebuilds in the background (see search-index-coordinator.js);
// characterChangeEmitter is the only push channel the client has for "results you already have may be stale
// now" (public/script.js's setupCharacterChangeStream()/getCharacters()), so it's re-emitted once that rebuild
// actually lands, not just when the underlying metadata changed.
function loadOrUpdateTantivyIndexAndNotify(directories, tantivy, previous) {
    return loadOrUpdateTantivyIndex(directories, tantivy, previous).then(result => {
        characterChangeEmitter.emit('change');
        return result;
    });
}

// `backend: 'unavailable'` distinguishes "nothing usable could be loaded" from a genuine no-match.
// `tags` is ANDed into the query the same way searchCharacterIdsSorted() already does it, via
// buildTagFilterQuery()/TAG_IDS_FIELD - so a tags-narrowed search-sorted request's ranked id list only ever
// contains ids that would also pass buildWhereClause()'s tags filter, and callers can page it directly with no
// separate DB-side re-check. `world` has no equivalent: no field for it exists in the tantivy schema
// (buildSchema()'s fast/filter field lists), so it isn't applied here - see this change's commit message.
async function runIdSearch(handle, directories, searchTerm, maxRows, favOnly, tags) {
    const signature = await getFreshnessSignature(directories);
    const engine = await resolveSearchEngine();

    if (engine.tier === 'unavailable') {
        return { hits: [], total: 0, backend: 'unavailable' };
    }

    const tantivyIndex = await indexCoordinator.getIndex(
        handle, signature,
        (previous) => loadOrUpdateTantivyIndexAndNotify(directories, engine.tantivy, previous),
        () => openPersistedTantivyIndexStale(directories, engine.tantivy),
    );
    if (!tantivyIndex) {
        return { hits: [], total: 0, backend: 'unavailable' };
    }
    let query = buildTantivyQuery(engine.tantivy, tantivyIndex.schema, searchTerm, TANTIVY_FIELD_WEIGHTS, TANTIVY_FIELD_LABELS, { favOnly });
    if (!query) {
        return { hits: [], total: 0, backend: 'tantivy' };
    }
    if (tags && (tags.include?.length > 0 || tags.exclude?.length > 0)) {
        const tagQuery = buildTagFilterQuery(engine.tantivy, tantivyIndex.schema, tags, TAG_IDS_FIELD);
        if (tagQuery) {
            query = engine.tantivy.Query.booleanQuery([
                { occur: engine.tantivy.Occur.Must, query },
                { occur: engine.tantivy.Occur.Must, query: tagQuery },
            ]);
        }
    }
    const boundedMaxRows = Number.isFinite(maxRows) && maxRows > 0 ? maxRows : undefined;
    const { results, total } = runTantivySearch(tantivyIndex.index, query, boundedMaxRows);
    return { hits: results.map(r => ({ id: r.raw, score: r.score })), total, backend: 'tantivy' };
}

// A matched id that can no longer be resolved (deleted, or corrupt) is silently dropped.
export async function searchCharacters(handle, directories, searchTerm, maxRows, favOnly, tags) {
    const { hits, total, backend } = await runIdSearch(handle, directories, searchTerm, maxRows, favOnly, tags);
    if (hits.length === 0) {
        return { results: [], total, backend };
    }

    const resolved = await mapWithConcurrency(hits, INDEX_BUILD_READ_CONCURRENCY, async (hit) => {
        try {
            const character = await processCharacter(hit.id, directories, { shallow: false });
            return character?.name ? { item: character, score: hit.score } : null;
        } catch {
            return null;
        }
    });

    return { results: resolved.filter(Boolean), total, backend };
}

// Id-only counterpart to searchCharacters() - no per-hit disk read, for a caller that resolves rows itself.
export async function searchCharacterIds(handle, directories, searchTerm, maxRows, favOnly, tags) {
    const { hits, total, backend } = await runIdSearch(handle, directories, searchTerm, maxRows, favOnly, tags);
    return { ids: hits.map(hit => hit.id), scoresById: new Map(hits.map(hit => [hit.id, hit.score])), total, backend };
}

// Returns null when sortField has no fast-field equivalent; caller uses the SQL sort path for those.
export async function searchCharacterIdsSorted(handle, directories, searchTerm, sortField, sortOrder, offset, pageSize, favOnly, { tags, excludeIds } = {}) {
    if (!TANTIVY_SORT_FIELDS.has(sortField)) return null;

    const tantivySortField = SORT_FIELD_TO_TANTIVY_FIELD[sortField];
    if (!tantivySortField) return null;

    const signature = await getFreshnessSignature(directories);
    const engine = await resolveSearchEngine();
    if (engine.tier === 'unavailable') return { ids: [], total: 0, backend: 'unavailable' };

    const tantivyIndex = await indexCoordinator.getIndex(
        handle, signature,
        (previous) => loadOrUpdateTantivyIndexAndNotify(directories, engine.tantivy, previous),
        () => openPersistedTantivyIndexStale(directories, engine.tantivy),
    );
    if (!tantivyIndex) return { ids: [], total: 0, backend: 'unavailable' };

    const query = buildTantivyQuery(engine.tantivy, tantivyIndex.schema, searchTerm, TANTIVY_FIELD_WEIGHTS, TANTIVY_FIELD_LABELS, { favOnly });
    if (!query) return { ids: [], total: 0, backend: 'tantivy' };

    // fav_name_sort_key is encoded so ascending order gives favorites-first-then-alpha, unconditionally.
    const effectiveOrder = sortField === 'fav' ? 'asc' : sortOrder;

    let fullQuery = query;

    if (tags && (tags.include?.length > 0 || tags.exclude?.length > 0)) {
        const tagQuery = buildTagFilterQuery(engine.tantivy, tantivyIndex.schema, tags, TAG_IDS_FIELD);
        if (tagQuery) {
            fullQuery = engine.tantivy.Query.booleanQuery([
                { occur: engine.tantivy.Occur.Must, query: fullQuery },
                { occur: engine.tantivy.Occur.Must, query: tagQuery },
            ]);
        }
    }

    if (Array.isArray(excludeIds) && excludeIds.length > 0) {
        const excludeQuery = buildExcludeIdsQuery(engine.tantivy, tantivyIndex.schema, excludeIds);
        fullQuery = engine.tantivy.Query.booleanQuery([
            { occur: engine.tantivy.Occur.Must, query: fullQuery },
            { occur: engine.tantivy.Occur.MustNot, query: excludeQuery },
        ]);
    }

    // count:false: combining an exact count with a fast-field-sorted, offset-paginated collector is far more
    // expensive than either alone, so total comes from a separate plain-relevance count-only search below.
    const { results } = runTantivySearch(tantivyIndex.index, fullQuery, pageSize, {
        orderByField: tantivySortField,
        order: effectiveOrder,
        offset,
        count: false,
    });
    const { total } = runTantivySearch(tantivyIndex.index, fullQuery, 1);
    return { ids: results.map(r => r.raw), total, backend: 'tantivy' };
}

// Explicit repair endpoint: forces a full rebuild regardless of freshness signature. Not needed for
// correctness - loadOrUpdateTantivyIndex() already falls back to a full rebuild when incremental
// maintenance can't proceed - this is for forcing one without waiting for the next staleness check.
export async function rebuildCharacterSearchIndex(handle, directories) {
    const engine = await resolveSearchEngine();
    if (engine.tier === 'unavailable') {
        return { ok: false, backend: 'unavailable' };
    }

    const signature = await getFreshnessSignature(directories);
    const rebuilt = await indexCoordinator.forceRebuild(handle, signature, () => rebuildTantivyIndexFromScratch(directories, engine.tantivy));
    if (!rebuilt) {
        return { ok: false, backend: 'unavailable' };
    }
    return { ok: true, backend: 'tantivy' };
}
