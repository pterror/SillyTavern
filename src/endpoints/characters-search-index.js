import fs from 'node:fs';
import path from 'node:path';

import Fuse from 'fuse.js';

import { TAGS_FILE } from '../constants.js';
import { readTagsData } from './tags-data.js';
import { processCharacter } from './characters.js';
import { getBetterSqlite3 } from './native-sqlite.js';

/**
 * Fast full-content character search, backed by a persistent per-user SQLite FTS5 index (better-sqlite3) built
 * from *full* (non-shallow) character data - so the "search" sort mode can be paginated server-side without
 * losing ranking quality, and (this is the part that actually matters) without silently missing most of a
 * character's content the way the client's own fuzzySearchCharacters() (power-user.js) does when
 * `performance.lazyLoadCharacters` is on: in shallow mode the client's resident `characters` array never has
 * description/mes_example/scenario/personality/first_mes/creator_notes/alternate_greetings populated for any
 * character that hasn't been individually opened this session, so client-side search has effectively only been
 * searching name/tags for most of the library. This index is always built from full data server-side, so that
 * gap doesn't exist here regardless of the shallow-list setting.
 *
 * WHY SQLITE FTS5 AND NOT AN IN-MEMORY JS INDEX (the first version of this file used Fuse.js, in-process, the
 * same way the client does): Fuse's bitap scan takes multiple seconds *per query* at real-world library sizes
 * (measured: 8-17s/query against a 24k-character-card install) - not viable for search-as-you-type. Swapping to
 * an in-memory inverted-index engine (minisearch was tested) drops query time to ~15ms, which sounds like a
 * fix, but its memory cost doesn't - measured 47.6KB of Node heap per indexed card. That's fine at a few
 * thousand cards, but extrapolates to ~13GB of heap at 300k cards and into the tens-of-GB range past a million
 * - a hard ceiling for a resident library that self-hosted installs can and do grow to, not a tuning knob. A
 * pure-WASM SQLite build (no native compile step) was also tested as a way to dodge the native-dependency risk
 * below entirely, and it worked - but query latency came out ~1.5-2x slower than native, which wasn't
 * acceptable, so native better-sqlite3 is the one actually wired up here.
 *
 * SQLite FTS5 keeps the index on disk instead of the JS heap: measured build cost for the same 24k-card dataset
 * was ~6s (faster than the in-memory options, not slower), query latency 1-5ms, and the *Node process* memory
 * cost of building it was under 4MB regardless of dataset size, because the index lives in SQLite's own file
 * and page cache, not V8's heap. That's what makes this viable at library sizes an in-memory JS index can't
 * reach at all, not just "a bit better."
 *
 * The tradeoff for that is better-sqlite3 being this project's first native-compiled dependency (checked: zero
 * others exist in package.json). A missing prebuilt binary on some platform/arch/Node combo is a real
 * possibility, not hypothetical (confirmed via better-sqlite3's own issue tracker: gaps have shipped for new
 * Node majors and for musl/Alpine-based Linux, a common base for containerized installs) - see
 * native-sqlite.js's header for specifics. That's why every lookup through this module goes through
 * getBetterSqlite3() and falls back to the original in-process Fuse.js index (see
 * buildFuseFallbackIndex()/the fallback branch of searchCharacters() below) when the native module isn't
 * usable: search keeps working, just at the old slower-but-pure-JS speed, with a fix-it warning logged once.
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

/** @type {Map<string, { db: import('better-sqlite3').Database, signature: string }>} */
const sqliteIndexes = new Map();
/** @type {Map<string, { fuse: Fuse<object>, signature: string }>} */
const fuseIndexes = new Map();

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
 * @param {typeof import('better-sqlite3')} DatabaseCtor The loaded better-sqlite3 constructor
 * @returns {Promise<import('better-sqlite3').Database>} The freshly built, open database handle
 */
async function buildSqliteIndex(directories, DatabaseCtor) {
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

    const db = new DatabaseCtor(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(`
        CREATE VIRTUAL TABLE cards USING fts5(
            avatar UNINDEXED,
            data UNINDEXED,
            ${BM25_INDEXED_COLUMNS.join(', ')}
        );
    `);

    const characters = await readAllCharacters(directories);
    const tagNamesFor = makeTagNamesResolver(directories);

    const insert = db.prepare(`
        INSERT INTO cards (avatar, data, ${BM25_INDEXED_COLUMNS.join(', ')})
        VALUES (@avatar, @data, @name, @resolved_tags, @description, @mes_example, @scenario, @personality, @first_mes, @creator_notes, @creator, @tags, @alternate_greetings)
    `);
    const insertMany = db.transaction((chars) => {
        for (const character of chars) {
            insert.run({
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
            });
        }
    });
    insertMany(characters);

    // The whole build above is one big transaction, so nothing gets checkpointed back into the main db file
    // until this runs - without it, the WAL file sits at roughly the same size as everything just written
    // (confirmed: ~1.7GB WAL alongside a ~1.7GB db file for this install's real 24k-card library) and stays
    // that large for as long as this connection stays open, since SQLite's default page-count-based
    // auto-checkpoint doesn't fire mid-transaction. TRUNCATE folds the WAL back in and shrinks it to ~0 bytes,
    // so steady-state disk usage reflects the actual index size instead of roughly double it.
    db.pragma('wal_checkpoint(TRUNCATE)');

    return db;
}

/**
 * Turns a raw user search string into an FTS5 MATCH query: each whitespace-separated word becomes a
 * prefix-matched term (so "vamp" matches "vampire" while typing), and multiple words are combined with an
 * explicit AND.
 *
 * AND (not OR) was chosen deliberately for the multi-word case: a search for "vampire romance" over character
 * cards reads as "a vampire character that's also a romance", a specific compound description, not "anything
 * about vampires OR anything about romance". Measured against the real dataset this index was designed for,
 * OR-combining "vampire romance" matched 11,101 of 24,171 cards (worthless as a filter - it matches almost the
 * whole library), while AND-combining matched 315 - a result set someone typing that phrase could actually use.
 *
 * Known tradeoff: FTS5 prefix matching handles partial words (typing-in-progress) but not misspellings - it
 * doesn't have Fuse's fuzzy/typo tolerance. The Fuse.js fallback path below still has that if it's ever active.
 * @param {string} searchTerm Raw user input
 * @returns {string | null} An FTS5 MATCH query string, or null if there's nothing to search for
 */
function buildFtsQuery(searchTerm) {
    const tokens = searchTerm.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
        return null;
    }
    return tokens.map(token => `"${token.replace(/"/g, '""')}"*`).join(' AND ');
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} searchTerm
 * @returns {{ item: object, score: number }[]} Results sorted best-first (ascending bm25 score - lower is
 * better, same convention Fuse.js and the rest of this codebase's search results already use)
 */
function querySqliteIndex(db, searchTerm) {
    const ftsQuery = buildFtsQuery(searchTerm);
    if (!ftsQuery) {
        return [];
    }
    const weightsArg = BM25_WEIGHTS.join(', ');
    const stmt = db.prepare(`SELECT avatar, data, bm25(cards, ${weightsArg}) as score FROM cards WHERE cards MATCH ? ORDER BY score`);
    return stmt.all(ftsQuery).map(row => ({ item: JSON.parse(row.data), score: row.score }));
}

/**
 * Fallback path used only when better-sqlite3 isn't usable on this install (see native-sqlite.js) - identical
 * in shape and options to this file's original Fuse.js-only implementation, kept so search degrades to
 * "slower but works" instead of breaking outright.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @returns {Promise<Fuse<object>>}
 */
async function buildFuseFallbackIndex(directories) {
    const characters = await readAllCharacters(directories);
    const tagNamesFor = makeTagNamesResolver(directories);

    const keys = [
        { name: 'data.name', weight: 20 },
        { name: '#tags', weight: 10, getFn: (character) => tagNamesFor(character.avatar) },
        { name: 'data.description', weight: 3 },
        { name: 'data.mes_example', weight: 3 },
        { name: 'data.scenario', weight: 2 },
        { name: 'data.personality', weight: 2 },
        { name: 'data.first_mes', weight: 2 },
        { name: 'data.creator_notes', weight: 2 },
        { name: 'data.creator', weight: 1 },
        { name: 'data.tags', weight: 1 },
        { name: 'data.alternate_greetings', weight: 1 },
    ];

    return new Fuse(characters, {
        keys,
        includeScore: true,
        ignoreLocation: true,
        useExtendedSearch: true,
        threshold: 0.2,
    });
}

/**
 * Fuzzy-searches a user's characters, rebuilding the persistent index first if it's missing or stale. Tries
 * the fast SQLite FTS5 backend first, falling back to Fuse.js if better-sqlite3 isn't usable on this install.
 * @param {string} handle User handle
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} searchTerm Search term
 * @returns {Promise<{ item: object, score: number }[]>} Results sorted best-first (ascending score)
 */
export async function searchCharacters(handle, directories, searchTerm) {
    const signature = getFreshnessSignature(directories);
    const DatabaseCtor = await getBetterSqlite3();

    if (DatabaseCtor) {
        let entry = sqliteIndexes.get(handle);
        if (!entry || entry.signature !== signature) {
            entry?.db?.close();
            const db = await buildSqliteIndex(directories, DatabaseCtor);
            entry = { db, signature };
            sqliteIndexes.set(handle, entry);
        }
        return querySqliteIndex(entry.db, searchTerm);
    }

    let entry = fuseIndexes.get(handle);
    if (!entry || entry.signature !== signature) {
        const fuse = await buildFuseFallbackIndex(directories);
        entry = { fuse, signature };
        fuseIndexes.set(handle, entry);
    }
    return entry.fuse.search(searchTerm);
}
