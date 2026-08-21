import { color } from '../util.js';
import { getBetterSqlite3 } from './native-sqlite.js';

/**
 * Resolves which SQLite FTS5 engine actually backs the character/group search indexes
 * (characters-search-index.js, groups-search-index.js), trying native better-sqlite3 first and falling back to
 * the WebAssembly-compiled node-sqlite3-wasm when the native binding isn't usable on this install.
 *
 * WHY A SECOND TIER INSTEAD OF JUST FALLING BACK TO THE OLD FUSE.JS INDEX (which is what this module replaces -
 * see native-sqlite.js's own header, still accurate for *why native can fail*, and still used as-is by
 * start.sh's rebuild probe): Fuse.js is a genuinely different search algorithm, not just a slower version of the
 * same one - different ranking, and (once `label:query` syntax was added, see search-query.js) no way to honor a
 * `tag:foo`-style filter at all, since that's FTS5-specific column-filter syntax with no Fuse equivalent. A
 * fallback that silently changes *what a search means*, not just how fast it runs, is a worse failure mode than
 * "slower but identical." node-sqlite3-wasm runs the same SQLite/FTS5 engine as better-sqlite3, just compiled to
 * WebAssembly instead of a native addon - confirmed by direct testing (not assumed) that its bundled SQLite
 * build supports `CREATE VIRTUAL TABLE ... USING fts5`, `bm25()`, and the `{col1 col2}:term` column-group filter
 * syntax search-query.js relies on, identically to better-sqlite3. That means the wasm tier produces the exact
 * same ranking and the exact same `label:query` support as native - the only real difference is query latency,
 * and it needs no native compile step (no C/C++ toolchain, no Python), so it works on setups native can't reach
 * at all, like musl-based Linux (Alpine) container images.
 *
 * Two real API differences between the engines, confirmed by direct testing rather than assumed from either
 * library's docs, that this module's per-engine adapters exist specifically to paper over:
 *   - Named bind parameters: better-sqlite3 strips the `@`/`:`/`$` prefix when matching an object key (so
 *     `@avatar` binds from `{ avatar: ... }`), but node-sqlite3-wasm requires the prefix to be part of the key
 *     itself (`{ '@avatar': ... }`) - passing an unprefixed key throws "Unknown binding parameter".
 *   - WAL mode: better-sqlite3 supports `PRAGMA journal_mode = WAL` (which is why buildSqliteIndex() in the
 *     search-index modules checkpoints it after the big build transaction - see that function's own comment).
 *     node-sqlite3-wasm's WASM-compiled SQLite does not - `PRAGMA journal_mode = WAL` silently no-ops and the
 *     database stays in the default rollback-journal mode (confirmed: the pragma read back afterward still
 *     reports 'delete'). This is expected for a WASM build without shared-memory mmap access, not a bug to work
 *     around - the adapter below just skips the WAL pragma and treats checkpointing as a no-op for this engine.
 *
 * If *neither* engine loads, that means the Node install itself is broken in some fairly fundamental way (no
 * native compile toolchain AND the pure-WASM fallback - which ships a prebuilt binary and needs no compile step
 * at all - also failed to import). At that point there's no sensible degraded-but-working search left to fall
 * back to, so getSqliteEngine() returns null and callers (searchCharacters()/searchGroups()) report search as
 * unavailable rather than pretending some other, worse implementation is a real fallback tier.
 * @type {{ kind: 'native' | 'wasm', openDatabase: (path: string) => SqliteEngineHandle } | null | undefined}
 * undefined = not yet resolved, null = neither engine is usable
 */
let engine = undefined;

/**
 * @typedef {object} SqliteEngineHandle
 * @property {(sql: string) => void} exec Runs a SQL statement with no return value (DDL, PRAGMA, etc.)
 * @property {(sql: string, rows: object[]) => void} insertMany Runs an `INSERT` statement once per row, all
 * inside a single transaction, with each row's keys bound as named parameters
 * @property {(sql: string, param: string) => object[]} query Runs a SQL statement with a single positional `?`
 * parameter and returns every result row
 * @property {() => void} checkpoint Folds the WAL file back into the main database file where supported
 * (native only - see this module's header comment on why the wasm engine's checkpoint is a no-op)
 * @property {() => void} close Closes the underlying database connection
 */

/**
 * Exported (alongside openWasmDatabase()) so tests can exercise the adapters directly against a real database,
 * independent of which engine getSqliteEngine() actually resolves to on the machine running the test.
 * @param {typeof import('better-sqlite3')} DatabaseCtor
 * @param {string} path
 * @returns {SqliteEngineHandle}
 */
export function openNativeDatabase(DatabaseCtor, path) {
    const db = new DatabaseCtor(path);
    db.pragma('journal_mode = WAL');
    return {
        exec: (sql) => db.exec(sql),
        insertMany: (sql, rows) => {
            const stmt = db.prepare(sql);
            db.transaction((items) => {
                for (const item of items) {
                    stmt.run(item);
                }
            })(rows);
        },
        query: (sql, param) => db.prepare(sql).all(param),
        checkpoint: () => db.pragma('wal_checkpoint(TRUNCATE)'),
        close: () => db.close(),
    };
}

/**
 * @param {import('node-sqlite3-wasm').Database} WasmDatabaseCtor
 * @param {string} path
 * @returns {SqliteEngineHandle}
 */
export function openWasmDatabase(WasmDatabaseCtor, path) {
    const db = new WasmDatabaseCtor(path);
    return {
        exec: (sql) => db.exec(sql),
        insertMany: (sql, rows) => {
            const stmt = db.prepare(sql);
            db.exec('BEGIN');
            try {
                for (const item of rows) {
                    // node-sqlite3-wasm, unlike better-sqlite3, requires the bind-parameter prefix character to
                    // be part of the object key itself - see this module's header comment.
                    const prefixed = Object.fromEntries(Object.entries(item).map(([key, value]) => [`@${key}`, value]));
                    stmt.run(prefixed);
                }
                db.exec('COMMIT');
            } catch (err) {
                db.exec('ROLLBACK');
                throw err;
            } finally {
                stmt.finalize();
            }
        },
        query: (sql, param) => db.prepare(sql).all(param),
        checkpoint: () => { /* no-op: this engine's WASM-compiled SQLite doesn't support WAL mode at all */ },
        close: () => db.close(),
    };
}

/**
 * @returns {Promise<typeof import('node-sqlite3-wasm').Database | null>} The node-sqlite3-wasm Database
 * constructor, or null if it isn't usable (already logged a warning in that case)
 */
async function tryLoadWasmEngine() {
    try {
        const module = await import('node-sqlite3-wasm');
        const Ctor = module.default.Database;
        // Same reasoning as native-sqlite.js's own probe: actually construct a database rather than trusting
        // that the import alone succeeding means the WASM runtime initialized cleanly.
        new Ctor(':memory:').close();
        return Ctor;
    } catch (err) {
        console.error(color.red('[search] node-sqlite3-wasm (the WebAssembly SQLite search fallback) also failed to load:'));
        console.error(color.red(`[search]   ${err.message}`));
        return null;
    }
}

/**
 * @returns {Promise<{ kind: 'native' | 'wasm', openDatabase: (path: string) => SqliteEngineHandle } | null>}
 * The resolved SQLite engine, or null if neither the native nor the WASM backend is usable on this install
 * (already logged a diagnostic in that case).
 */
export async function getSqliteEngine() {
    if (engine !== undefined) {
        return engine;
    }

    const NativeCtor = await getBetterSqlite3();
    if (NativeCtor) {
        engine = { kind: 'native', openDatabase: (path) => openNativeDatabase(NativeCtor, path) };
        return engine;
    }

    // getBetterSqlite3() already printed the native-binding fix-it warning (native-sqlite.js) - this only adds
    // to that story, it doesn't repeat it.
    console.error(color.yellow('[search] Trying the WebAssembly SQLite search backend (node-sqlite3-wasm) instead - same ranking and label:query support as native, just slower.'));
    const WasmCtor = await tryLoadWasmEngine();
    if (WasmCtor) {
        engine = { kind: 'wasm', openDatabase: (path) => openWasmDatabase(WasmCtor, path) };
        return engine;
    }

    console.error(color.red('[search] No usable SQLite search backend on this install - character/group search is unavailable until this is fixed.'));
    engine = null;
    return null;
}
