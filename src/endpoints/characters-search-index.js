import fs from 'node:fs';
import path from 'node:path';

import { TAGS_FILE } from '../constants.js';
import { readTagsData } from './tags-data.js';
import { processCharacter } from './characters.js';
import { getSqliteEngine } from './sqlite-engine.js';
import { buildFtsQuery } from './search-query.js';

/**
 * Fast full-content character search, backed by a persistent per-user SQLite FTS5 index built from *full*
 * (non-shallow) character data - so the "search" sort mode can be paginated server-side without losing ranking
 * quality, and (this is the part that actually matters) without silently missing most of a character's content
 * the way the client's own fuzzySearchCharacters() (power-user.js) does when `performance.lazyLoadCharacters`
 * is on: in shallow mode the client's resident `characters` array never has description/mes_example/scenario/
 * personality/first_mes/creator_notes/alternate_greetings populated for any character that hasn't been
 * individually opened this session, so client-side search has effectively only been searching name/tags for
 * most of the library. This index is always built from full data server-side, so that gap doesn't exist here
 * regardless of the shallow-list setting.
 *
 * WHY SQLITE FTS5 AND NOT AN IN-MEMORY JS INDEX (the first version of this file used Fuse.js, in-process, the
 * same way the client does): Fuse's bitap scan takes multiple seconds *per query* at real-world library sizes
 * (measured: 8-17s/query against a 24k-character-card install) - not viable for search-as-you-type. Swapping to
 * an in-memory inverted-index engine (minisearch was tested) drops query time to ~15ms, which sounds like a
 * fix, but its memory cost doesn't - measured 47.6KB of Node heap per indexed card. That's fine at a few
 * thousand cards, but extrapolates to ~13GB of heap at 300k cards and into the tens-of-GB range past a million
 * - a hard ceiling for a resident library that self-hosted installs can and do grow to, not a tuning knob.
 *
 * SQLite FTS5 keeps the index on disk instead of the JS heap: measured build cost for the same 24k-card dataset
 * was ~6s (faster than the in-memory options, not slower), query latency 1-5ms on the native engine, and the
 * *Node process* memory cost of building it was under 4MB regardless of dataset size, because the index lives
 * in SQLite's own file and page cache, not V8's heap. That's what makes this viable at library sizes an
 * in-memory JS index can't reach at all, not just "a bit better."
 *
 * The engine actually used (native better-sqlite3 vs the WebAssembly node-sqlite3-wasm fallback) is resolved by
 * sqlite-engine.js - see that module's header for the full native-vs-wasm rationale, and native-sqlite.js's own
 * header for why the native binding specifically can fail on some installs. Both engines run the exact same
 * SQLite/FTS5 code and produce identical ranking and `label:query` behavior (search-query.js); the wasm tier is
 * just slower, not different. If neither engine is usable at all, searchCharacters() below reports search as
 * unavailable rather than silently degrading to a different, worse search algorithm.
 *
 * Freshness (for both backends) is checked cheaply (two stat() calls - the characters directory and tags.json)
 * on every search rather than via push-based invalidation hooks on every character-mutating route:
 * characters.js has ~9 routes that touch character files (create/rename/edit/edit-avatar/edit-attribute/
 * merge-attributes/delete/import/duplicate), and this module needs to import processCharacter() *from*
 * characters.js - having characters.js import an invalidate() call back from here would be the exact
 * characters.js<->other-module circular import shape that already caused a real TDZ crash earlier this session
 * (see the tags.js fix). A directory's mtime changes on any add/remove/rename, and write-file-atomic's
 * rename-over-target means an in-place edit changes it too - so comparing "has the characters dir (or
 * tags.json) changed since we indexed" catches every mutation path automatically, with no route-by-route hook
 * list to keep in sync and no import cycle. On staleness the SQLite index is rebuilt from scratch (not updated
 * incrementally row-by-row) - FTS5 absolutely supports incremental INSERT/UPDATE/DELETE, but wiring that up
 * per-route would reintroduce the same circular-import problem this stat-based check avoids, for a marginal
 * win given a full rebuild is already a ~6s one-time cost at real-world scale, not the multi-second-*per-query*
 * cost this module exists to eliminate.
 */

// Column order/weights mirror fuzzySearchCharacters() in public/scripts/power-user.js (and this file's
// original Fuse-based version) so a result ranks similarly to what the same term produced there.
const BM25_INDEXED_COLUMNS = ['name', 'resolved_tags', 'description', 'mes_example', 'scenario', 'personality', 'first_mes', 'creator_notes', 'creator', 'tags', 'alternate_greetings'];
const BM25_WEIGHTS = [20, 10, 3, 3, 2, 2, 2, 2, 1, 1, 1];

// `label:value` search syntax (see search-query.js) - maps a friendly label to the real FTS5 column-filter
// expression it becomes. `tag:`/`tags:` searches BOTH tag-ish columns via FTS5's `{col1 col2}:` group syntax,
// since BM25_WEIGHTS above already treats resolved_tags (tags.json names) and tags (raw embedded card data) as
// the same "does this character have this tag" concept - a label filter should honor that, not just pick one.
const FIELD_LABELS = {
    name: 'name',
    tag: '{resolved_tags tags}',
    tags: '{resolved_tags tags}',
    desc: 'description',
    description: 'description',
    example: 'mes_example',
    scenario: 'scenario',
    personality: 'personality',
    greeting: 'first_mes',
    notes: 'creator_notes',
    creator: 'creator',
    alt: 'alternate_greetings',
    alternate: 'alternate_greetings',
};

/** @type {Map<string, { db: import('./sqlite-engine.js').SqliteEngineHandle, signature: string }>} */
const sqliteIndexes = new Map();

/**
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {string} A cheap fingerprint that changes whenever a character or tags.json is added/removed/edited
 */
function getFreshnessSignature(directories) {
    const charDirMtime = fs.statSync(directories.characters).mtimeMs;
    const pathToTags = path.join(directories.root, TAGS_FILE);
    const tagsMtime = fs.existsSync(pathToTags) ? fs.statSync(pathToTags).mtimeMs : 0;
    return `${charDirMtime}:${tagsMtime}`;
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {Promise<object[]>} Full (non-shallow) character objects
 */
async function readAllCharacters(directories) {
    const files = fs.readdirSync(directories.characters);
    const pngFiles = files.filter(file => file.endsWith('.png'));
    const processingPromises = pngFiles.map(file => processCharacter(file, directories, { shallow: false }));
    return (await Promise.all(processingPromises)).filter(c => c.name);
}

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @returns {(avatar: string) => string} Resolves a character's tag names (space-joined) from tags.json, the
 * same `#tags` concept the client's fuzzySearchCharacters() resolves from its in-memory tag_map.
 */
function makeTagNamesResolver(directories) {
    const { tags, tag_map } = readTagsData(directories);
    const tagsById = new Map(tags.map(tag => [tag.id, tag]));
    return (avatar) => (tag_map[avatar] ?? [])
        .map(id => tagsById.get(id)?.name)
        .filter(Boolean)
        .join(' ');
}

/**
 * (Re)builds the persistent on-disk SQLite FTS5 index for a user's characters.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {{ kind: 'native' | 'wasm', openDatabase: (path: string) => import('./sqlite-engine.js').SqliteEngineHandle }} engine
 * The resolved SQLite engine (sqlite-engine.js)
 * @returns {Promise<import('./sqlite-engine.js').SqliteEngineHandle>} The freshly built, open database handle
 */
async function buildSqliteIndex(directories, engine) {
    const dbDir = path.join(directories.root, 'search-index');
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }
    const dbPath = path.join(dbDir, 'characters.db');

    for (const suffix of ['', '-wal', '-shm']) {
        const filePath = dbPath + suffix;
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }

    const db = engine.openDatabase(dbPath);
    db.exec(`
        CREATE VIRTUAL TABLE cards USING fts5(
            avatar UNINDEXED,
            data UNINDEXED,
            ${BM25_INDEXED_COLUMNS.join(', ')}
        );
    `);

    const characters = await readAllCharacters(directories);
    const tagNamesFor = makeTagNamesResolver(directories);

    db.insertMany(
        `INSERT INTO cards (avatar, data, ${BM25_INDEXED_COLUMNS.join(', ')})
         VALUES (@avatar, @data, @name, @resolved_tags, @description, @mes_example, @scenario, @personality, @first_mes, @creator_notes, @creator, @tags, @alternate_greetings)`,
        characters.map(character => ({
            avatar: character.avatar,
            data: JSON.stringify(character),
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
        })),
    );

    // The whole build above is one big transaction, so nothing gets checkpointed back into the main db file
    // until this runs (native engine only - see sqlite-engine.js on why the wasm engine's checkpoint is a
    // no-op) - without it, the WAL file sits at roughly the same size as everything just written (confirmed:
    // ~1.7GB WAL alongside a ~1.7GB db file for this install's real 24k-card library) and stays that large for
    // as long as this connection stays open, since SQLite's default page-count-based auto-checkpoint doesn't
    // fire mid-transaction. TRUNCATE folds the WAL back in and shrinks it to ~0 bytes, so steady-state disk
    // usage reflects the actual index size instead of roughly double it.
    db.checkpoint();

    return db;
}

/**
 * The AND-by-default rationale for multi-word queries is documented in search-query.js; the specific numbers it
 * was measured against: a search for "vampire romance" OR-combined matched 11,101 of 24,171 cards (worthless as
 * a filter), AND-combined matched 315 (a result set someone could actually use). Known tradeoff: FTS5 prefix
 * matching (buildFtsQuery(), search-query.js) handles partial words (typing-in-progress) but not misspellings.
 * @param {import('./sqlite-engine.js').SqliteEngineHandle} db
 * @param {string} searchTerm
 * @returns {{ item: object, score: number }[]} Results sorted best-first (ascending bm25 score - lower is
 * better, same convention the rest of this codebase's search results already use)
 */
function querySqliteIndex(db, searchTerm) {
    const ftsQuery = buildFtsQuery(searchTerm, FIELD_LABELS);
    if (!ftsQuery) {
        return [];
    }
    const weightsArg = BM25_WEIGHTS.join(', ');
    return db.query(`SELECT avatar, data, bm25(cards, ${weightsArg}) as score FROM cards WHERE cards MATCH ? ORDER BY score`, ftsQuery)
        .map(row => ({ item: JSON.parse(row.data), score: row.score }));
}

/**
 * Fuzzy-searches a user's characters, rebuilding the persistent index first if it's missing or stale. Resolves
 * a SQLite FTS5 engine via getSqliteEngine() (sqlite-engine.js) - native better-sqlite3 first, falling back to
 * the WebAssembly node-sqlite3-wasm build if the native binding isn't usable on this install.
 *
 * The returned `backend` field lets callers (see the /api/characters/all handler in characters.js) tell the
 * client which engine actually served a given search - the client surfaces that as a visible indicator when
 * it's not 'native', since the wasm tier is measurably slower (though behaviorally identical - same ranking,
 * same `label:query` support), and 'unavailable' means search produced no results because nothing usable could
 * be loaded, not because the query didn't match anything. Nothing about a degraded-but-still-200-OK response
 * would otherwise reveal any of that to whoever's looking at an empty or slow result list.
 * @param {string} handle User handle
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} searchTerm Search term
 * @returns {Promise<{ results: { item: object, score: number }[], backend: 'native' | 'wasm' | 'unavailable' }>}
 * Results sorted best-first (ascending score), and which engine produced them.
 */
export async function searchCharacters(handle, directories, searchTerm) {
    const signature = getFreshnessSignature(directories);
    const engine = await getSqliteEngine();

    if (!engine) {
        return { results: [], backend: 'unavailable' };
    }

    let entry = sqliteIndexes.get(handle);
    if (!entry || entry.signature !== signature) {
        entry?.db?.close();
        const db = await buildSqliteIndex(directories, engine);
        entry = { db, signature };
        sqliteIndexes.set(handle, entry);
    }
    return { results: querySqliteIndex(entry.db, searchTerm), backend: engine.kind };
}
