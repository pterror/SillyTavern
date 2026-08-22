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
 * @property {(sql: string, params?: object|any[]) => {changes: number, lastInsertRowid: number|bigint}} run
 * Runs a single parameterized statement (INSERT/UPDATE/DELETE) and returns how many rows it touched plus the
 * rowid of the last inserted row (meaningful for an `INTEGER PRIMARY KEY AUTOINCREMENT` table like this
 * module's callers use for a monotonic change-log revision counter). `params` may be a plain object (named
 * parameters, `@x`/`:x`/`$x` in the SQL) or an array (positional `?` parameters) - see this module's header for
 * why named-parameter keys need per-engine handling.
 * @property {(sql: string, params?: object|any[]) => object|undefined} get Runs a parameterized statement and
 * returns the first result row, or `undefined` if there were none.
 * @property {(sql: string, params?: object|any[]) => object[]} all Runs a parameterized statement and returns
 * every result row.
 * @property {(fn: () => void) => void} transaction Runs `fn` (which should call this handle's own run/get/all/
 * exec methods, synchronously - both engines execute statements synchronously, see search-index-coordinator.js's
 * header for why that matters) inside a single BEGIN/COMMIT, rolling back if `fn` throws.
 * @property {() => void} checkpoint Folds the WAL file back into the main database file where supported
 * (native only - see this module's header comment on why the wasm engine's checkpoint is a no-op)
 * @property {() => void} close Closes the underlying database connection
 */

/**
 * node-sqlite3-wasm, unlike better-sqlite3, requires the bind-parameter prefix character to be part of the
 * object key itself (`{'@avatar': ...}` rather than `{avatar: ...}`) - see this module's header comment. Native
 * accepts a plain object or array unmodified; only the wasm adapter needs this applied, and only for
 * object-shaped (named) params - an array of positional params needs no prefixing on either engine.
 * @param {object|any[]|undefined} params
 * @returns {object|any[]|undefined}
 */
function prefixNamedParamsForWasm(params) {
    if (!params || Array.isArray(params)) {
        return params;
    }
    return Object.fromEntries(Object.entries(params).map(([key, value]) => [`@${key}`, value]));
}

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

    // Prepared-statement cache, keyed by SQL text. db.prepare() isn't free - it parses the SQL and compiles it to
    // VDBE bytecode - and a caller that runs the same SQL text repeatedly with different params on every call
    // (any hot loop using run()/get()/all(), e.g. character-metadata-db.js's writeRowSync() during a large
    // bootstrap/reconcile pass) was re-paying that compile cost every single time instead of once. A better-
    // sqlite3 Statement is safe to reuse across calls - each .run()/.get()/.all() rebinds its own params - so
    // caching is just the "prepare once, execute many" shape insertMany() below already used for its one
    // hardcoded statement, generalized to every SQL string this handle sees.
    const stmtCache = new Map();
    const prepare = (sql) => {
        let stmt = stmtCache.get(sql);
        if (!stmt) {
            stmt = db.prepare(sql);
            stmtCache.set(sql, stmt);
        }
        return stmt;
    };

    return {
        exec: (sql) => db.exec(sql),
        insertMany: (sql, rows) => {
            const stmt = prepare(sql);
            db.transaction((items) => {
                for (const item of items) {
                    stmt.run(item);
                }
            })(rows);
        },
        query: (sql, param) => prepare(sql).all(param),
        run: (sql, params) => prepare(sql).run(params ?? {}),
        get: (sql, params) => prepare(sql).get(params ?? {}),
        all: (sql, params) => prepare(sql).all(params ?? {}),
        transaction: (fn) => db.transaction(fn)(),
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

    // Prepared-statement cache, keyed by SQL text - same "prepare once, reuse across calls" reasoning as
    // openNativeDatabase()'s cache above (see that comment). Unlike better-sqlite3, node-sqlite3-wasm statements
    // need an explicit stmt.finalize() to release their native-side resources; a cached statement is finalized
    // only when this handle's close() runs, not after each individual call - insertMany() below used to finalize
    // its statement at the end of every call, which was safe only because it never cached anything, but caching
    // the *same* statement object elsewhere means it must survive past a single insertMany() call.
    const stmtCache = new Map();
    const prepare = (sql) => {
        let stmt = stmtCache.get(sql);
        if (!stmt) {
            stmt = db.prepare(sql);
            stmtCache.set(sql, stmt);
        }
        return stmt;
    };

    return {
        exec: (sql) => db.exec(sql),
        insertMany: (sql, rows) => {
            const stmt = prepare(sql);
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
            }
        },
        query: (sql, param) => prepare(sql).all(param),
        run: (sql, params) => prepare(sql).run(prefixNamedParamsForWasm(params) ?? {}),
        get: (sql, params) => prepare(sql).get(prefixNamedParamsForWasm(params) ?? {}),
        all: (sql, params) => prepare(sql).all(prefixNamedParamsForWasm(params) ?? {}),
        // No native transaction() API on this engine (see this module's header on WAL support being the other
        // native-only feature) - a plain BEGIN/COMMIT/ROLLBACK around a synchronous fn() is equivalent, same
        // pattern insertMany() above already uses.
        transaction: (fn) => {
            db.exec('BEGIN');
            try {
                fn();
                db.exec('COMMIT');
            } catch (err) {
                db.exec('ROLLBACK');
                throw err;
            }
        },
        checkpoint: () => { /* no-op: this engine's WASM-compiled SQLite doesn't support WAL mode at all */ },
        close: () => {
            for (const stmt of stmtCache.values()) {
                stmt.finalize();
            }
            stmtCache.clear();
            db.close();
        },
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
