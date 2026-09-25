import { color } from '../util.js';
import { getBetterSqlite3 } from './native-sqlite.js';

/**
 * Resolves which SQLite FTS5 engine backs the character/group search indexes: native better-sqlite3, falling
 * back to WebAssembly node-sqlite3-wasm (same SQLite/FTS5 engine, same ranking and `label:query` support, just
 * slower and no native compile step needed) when the native binding isn't usable.
 *
 * Two API differences the per-engine adapters below paper over:
 *   - Named params: better-sqlite3 accepts unprefixed keys (`{avatar}` binds `@avatar`); node-sqlite3-wasm
 *     requires the prefix in the key itself (`{'@avatar': ...}`).
 *   - WAL mode: better-sqlite3 supports it; node-sqlite3-wasm's WASM build silently no-ops on
 *     `PRAGMA journal_mode = WAL` and stays in rollback-journal mode.
 * @type {{ kind: 'native' | 'wasm', openDatabase: (path: string) => SqliteEngineHandle } | null | undefined}
 * undefined = not yet resolved, null = neither engine is usable
 */
let engine = undefined;

/**
 * @typedef {object} SqliteEngineHandle
 * @property {string} path The database file this handle was opened on.
 * @property {(sql: string) => void} exec
 * @property {(sql: string, rows: object[]) => void} insertMany Runs an INSERT once per row in a single transaction.
 * @property {(sql: string, param: string) => object[]} query
 * @property {(sql: string, params?: object|any[]) => {changes: number, lastInsertRowid: number|bigint}} run
 * @property {(sql: string, params?: object|any[]) => object|undefined} get
 * @property {(sql: string, params?: object|any[]) => object[]} all
 * @property {(sql: string, params?: object|any[]) => Generator<object, void, undefined>} iterate Streams rows from a
 *   fresh statement, finalized however the loop ends (break/return/throw). While one is open, run/insertMany/
 *   transaction/checkpoint/exec throw; get and nested iterate are allowed.
 * @property {(fn: () => void) => void} transaction Runs fn inside a single BEGIN/COMMIT, rolling back on throw.
 * @property {() => void} checkpoint Folds WAL into the main file (native only; no-op on wasm).
 * @property {(name: string, fn: (...args: any[]) => any) => void} defineFunction Registers a scalar SQL function.
 * @property {() => SqliteReadHandle} [openReader] Opens a read-only connection on `path`; the caller closes it.
 *   Native only: without WAL (wasm) an open reader would block this handle's writes.
 * @property {() => void} close
 */

/**
 * @typedef {object} SqliteReadHandle
 * @property {(sql: string, params?: object|any[]) => object|undefined} get
 * @property {(sql: string, params?: object|any[]) => Generator<object, void, undefined>} iterate
 * @property {() => void} close
 */

const WRITE_WHILE_ITERATING_MESSAGE = 'write while iterate() is open';

/**
 * Shared iterate() and the no-writes-while-iterating guard, so both engines behave identically.
 * @param {(sql: string, params?: object|any[]) => {rows: Iterable<object>, finalize: () => void}} openRows
 *   Prepares a fresh (uncached) statement and starts it; finalize releases it.
 */
function createRowStreaming(openRows) {
    let openIterators = 0;

    const assertNoOpenIterator = () => {
        if (openIterators > 0) {
            throw new Error(WRITE_WHILE_ITERATING_MESSAGE);
        }
    };

    // Generator body runs on the first next(), so nothing is prepared (or left unfinalized) for an iterator
    // that is never started.
    function* iterate(sql, params) {
        const { rows, finalize } = openRows(sql, params);
        openIterators++;
        try {
            for (const row of rows) {
                yield row;
            }
        } finally {
            openIterators--;
            finalize();
        }
    }

    return { iterate, assertNoOpenIterator };
}

/** node-sqlite3-wasm requires the bind-parameter prefix in the object key itself (`{'@avatar': ...}`). */
function prefixNamedParamsForWasm(params) {
    if (!params || Array.isArray(params)) {
        return params;
    }
    return Object.fromEntries(Object.entries(params).map(([key, value]) => [`@${key}`, value]));
}

/** better-sqlite3 defaults busy_timeout to 5s, too short for this app's bulk write passes (bootstrap, backfill, batch import). */
const BUSY_TIMEOUT_MS = 15000;

/** Bounds on the retry loop below - see runWithBusyRetry(). */
const BUSY_RETRY_MAX_ATTEMPTS = 6;
const BUSY_RETRY_BASE_DELAY_MS = 20;
const BUSY_RETRY_TOTAL_BUDGET_MS = 20000;

/** Matched on both code and message: better-sqlite3 exposes a `code` string, node-sqlite3-wasm only the message text. */
function isBusyError(err) {
    const code = String(err?.code ?? '');
    const message = String(err?.message ?? '');
    return code.startsWith('SQLITE_BUSY')
        || code === 'SQLITE_LOCKED'
        || /database is locked|database table is locked|database is busy/i.test(message);
}

/** Blocks the event loop; synchronous because the whole SqliteEngineHandle surface is synchronous. */
function sleepSync(ms) {
    if (ms <= 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Retries fn with exponential backoff while it fails on a locked database; other errors propagate immediately.
 *
 * `busy_timeout` doesn't cover `SQLITE_BUSY_SNAPSHOT`: a DEFERRED transaction that reads then tries to upgrade
 * to a write hits this immediately and unretryably if another connection committed in between (the busy handler
 * isn't invoked for it). Transactions below use BEGIN IMMEDIATE to avoid the upgrade; this retry covers the
 * residual races.
 *
 * fn must touch nothing outside this database - a rolled-back transaction is safe to rerun, but outside side
 * effects would be applied more than once.
 * @param {string} label Used only in the log line.
 */
function runWithBusyRetry(fn, label) {
    const startedAt = Date.now();
    let lastError;
    for (let attempt = 0; attempt < BUSY_RETRY_MAX_ATTEMPTS; attempt++) {
        try {
            return fn();
        } catch (err) {
            if (!isBusyError(err)) throw err;
            lastError = err;
            const elapsed = Date.now() - startedAt;
            if (elapsed >= BUSY_RETRY_TOTAL_BUDGET_MS || attempt === BUSY_RETRY_MAX_ATTEMPTS - 1) break;
            // Jitter avoids colliding writers backing off in lockstep.
            const delay = Math.min(BUSY_RETRY_BASE_DELAY_MS * (2 ** attempt), 1000);
            sleepSync(delay + Math.floor(Math.random() * delay));
        }
    }
    console.error(`[sqlite-engine] ${label} still blocked by a database lock after ${BUSY_RETRY_MAX_ATTEMPTS} attempts over ${Date.now() - startedAt}ms - giving up and rethrowing.`);
    throw lastError;
}

/**
 * @param {typeof import('better-sqlite3')} DatabaseCtor
 * @param {string} path
 * @returns {SqliteEngineHandle}
 */
export function openNativeDatabase(DatabaseCtor, path) {
    const db = new DatabaseCtor(path);
    db.pragma('journal_mode = WAL');
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);

    // Prepared-statement cache keyed by SQL text - avoids recompiling the same SQL on every call in hot loops.
    const stmtCache = new Map();
    const prepare = (sql) => {
        let stmt = stmtCache.get(sql);
        if (!stmt) {
            stmt = db.prepare(sql);
            stmtCache.set(sql, stmt);
        }
        return stmt;
    };

    const { iterate, assertNoOpenIterator } = createRowStreaming((sql, params) => {
        const rows = db.prepare(sql).iterate(params ?? {});
        return { rows, finalize: () => { rows.return(); } };
    });

    return {
        path,
        exec: (sql) => { assertNoOpenIterator(); db.exec(sql); },
        insertMany: (sql, rows) => {
            assertNoOpenIterator();
            const stmt = prepare(sql);
            // .immediate() and the retry wrapper, for the same reasons as transaction() below.
            const tx = db.transaction((items) => {
                for (const item of items) {
                    stmt.run(item);
                }
            }).immediate;
            runWithBusyRetry(() => tx(rows), 'insertMany');
        },
        query: (sql, param) => prepare(sql).all(param),
        // Reads (query/get/all) are deliberately NOT retried: in WAL mode a reader never blocks on a writer,
        // so a read that fails this way has a different cause and should surface rather than be slept over.
        run: (sql, params) => { assertNoOpenIterator(); return runWithBusyRetry(() => prepare(sql).run(params ?? {}), 'run'); },
        get: (sql, params) => prepare(sql).get(params ?? {}),
        all: (sql, params) => prepare(sql).all(params ?? {}),
        iterate,
        // .immediate, not deferred: takes the write lock up front so a read-then-write transaction never needs
        // to upgrade mid-transaction and hit SQLITE_BUSY_SNAPSHOT (which the busy handler doesn't cover).
        transaction: (fn) => { assertNoOpenIterator(); return runWithBusyRetry(() => db.transaction(fn).immediate(), 'transaction'); },
        checkpoint: () => { assertNoOpenIterator(); db.pragma('wal_checkpoint(TRUNCATE)'); },
        // deterministic: true is safe - every registered function in this codebase is a pure hash.
        defineFunction: (name, fn) => { db.function(name, { deterministic: true }, fn); },
        openReader: () => openNativeReadDatabase(DatabaseCtor, path),
        close: () => db.close(),
    };
}

/**
 * A second, read-only connection to a WAL database opened by openNativeDatabase(). Under WAL it reads from its own
 * snapshot without blocking the main connection's writes, so a loop can stream here and write there. Functions
 * registered with defineFunction() on the main connection are not available here.
 * @param {typeof import('better-sqlite3')} DatabaseCtor
 * @param {string} path
 * @returns {SqliteReadHandle}
 */
export function openNativeReadDatabase(DatabaseCtor, path) {
    const db = new DatabaseCtor(path, { readonly: true });
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);

    const stmtCache = new Map();
    const prepare = (sql) => {
        let stmt = stmtCache.get(sql);
        if (!stmt) {
            stmt = db.prepare(sql);
            stmtCache.set(sql, stmt);
        }
        return stmt;
    };

    const { iterate } = createRowStreaming((sql, params) => {
        const rows = db.prepare(sql).iterate(params ?? {});
        return { rows, finalize: () => { rows.return(); } };
    });

    return {
        get: (sql, params) => prepare(sql).get(params ?? {}),
        iterate,
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
    // No WAL on this engine, so it serializes on the whole database file - more prone to lock contention.
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);

    // Prepared-statement cache keyed by SQL text. Unlike better-sqlite3, statements need explicit finalize() -
    // cached ones are finalized on close(), not after each call.
    const stmtCache = new Map();
    const prepare = (sql) => {
        let stmt = stmtCache.get(sql);
        if (!stmt) {
            stmt = db.prepare(sql);
            stmtCache.set(sql, stmt);
        }
        return stmt;
    };

    const { iterate, assertNoOpenIterator } = createRowStreaming((sql, params) => {
        const stmt = db.prepare(sql);
        try {
            return { rows: stmt.iterate(prefixNamedParamsForWasm(params) ?? {}), finalize: () => stmt.finalize() };
        } catch (err) {
            stmt.finalize();
            throw err;
        }
    });

    return {
        path,
        exec: (sql) => { assertNoOpenIterator(); db.exec(sql); },
        insertMany: (sql, rows) => {
            assertNoOpenIterator();
            const stmt = prepare(sql);
            runWithBusyRetry(() => {
                // BEGIN IMMEDIATE, matching the native adapter.
                db.exec('BEGIN IMMEDIATE');
                try {
                    for (const item of rows) {
                        const prefixed = Object.fromEntries(Object.entries(item).map(([key, value]) => [`@${key}`, value]));
                        stmt.run(prefixed);
                    }
                    db.exec('COMMIT');
                } catch (err) {
                    db.exec('ROLLBACK');
                    throw err;
                }
            }, 'insertMany');
        },
        query: (sql, param) => prepare(sql).all(param),
        // Reads are not retried here either - same reasoning as the native adapter above.
        run: (sql, params) => { assertNoOpenIterator(); return runWithBusyRetry(() => prepare(sql).run(prefixNamedParamsForWasm(params) ?? {}), 'run'); },
        // node-sqlite3-wasm returns null for no row; the handle contract is undefined.
        get: (sql, params) => prepare(sql).get(prefixNamedParamsForWasm(params) ?? {}) ?? undefined,
        all: (sql, params) => prepare(sql).all(prefixNamedParamsForWasm(params) ?? {}),
        iterate,
        // No native transaction() API on this engine - BEGIN IMMEDIATE/COMMIT/ROLLBACK is equivalent.
        transaction: (fn) => {
            assertNoOpenIterator();
            runWithBusyRetry(() => {
                db.exec('BEGIN IMMEDIATE');
                try {
                    fn();
                    db.exec('COMMIT');
                } catch (err) {
                    db.exec('ROLLBACK');
                    throw err;
                }
            }, 'transaction');
        },
        // Otherwise a no-op: this engine's WASM-compiled SQLite doesn't support WAL mode at all.
        checkpoint: () => { assertNoOpenIterator(); },
        defineFunction: (name, fn) => { db.function(name, fn, { deterministic: true }); },
        close: () => {
            for (const stmt of stmtCache.values()) {
                stmt.finalize();
            }
            stmtCache.clear();
            db.close();
        },
    };
}

const STREAM_WRITE_BATCH_SIZE = 1000;
/** Rows per read connection on native: an open reader pins the WAL, so it is reopened this often to let checkpoints run. */
const STREAM_WRITE_NATIVE_CHUNK_SIZE = 100000;

/**
 * Reads rows and writes per batch without an unbounded read and without writing while an iterate() is open on
 * the same connection. onBatch(rows) runs once per batch (at most 1000 rows) inside a transaction on `handle`.
 *
 * readSql must select keyColumn, keep only `(@after IS NULL OR <keyColumn> > @after)`, `ORDER BY <keyColumn>`
 * and end with `LIMIT @limit`; keyColumn must be unique. The helper binds `after` (null first, then the last
 * keyColumn value read) and `limit`:
 *   - with handle.openReader (native/WAL): one read connection per 100000-row chunk, limit = 100000;
 *   - without it (wasm): keyset pages on `handle` itself, limit = 1000.
 * The next chunk/page is read only if the previous one came back full.
 * @param {SqliteEngineHandle} handle
 * @param {{ readSql: string, params?: object, keyColumn: string, onBatch: (rows: object[]) => void }} options
 */
export function streamWrite(handle, { readSql, params, keyColumn, onBatch }) {
    if (handle.openReader) {
        let after = null;
        for (;;) {
            let chunkRows = 0;
            const reader = handle.openReader();
            try {
                let batch = [];
                for (const row of reader.iterate(readSql, { ...params, after, limit: STREAM_WRITE_NATIVE_CHUNK_SIZE })) {
                    chunkRows++;
                    after = row[keyColumn];
                    batch.push(row);
                    if (batch.length === STREAM_WRITE_BATCH_SIZE) {
                        const rows = batch;
                        handle.transaction(() => onBatch(rows));
                        batch = [];
                    }
                }
                if (batch.length > 0) {
                    handle.transaction(() => onBatch(batch));
                }
            } finally {
                reader.close();
            }
            if (chunkRows < STREAM_WRITE_NATIVE_CHUNK_SIZE) {
                return;
            }
        }
    }

    let after = null;
    for (;;) {
        const rows = Array.from(handle.iterate(readSql, { ...params, after, limit: STREAM_WRITE_BATCH_SIZE }));
        if (rows.length > 0) {
            handle.transaction(() => onBatch(rows));
        }
        if (rows.length < STREAM_WRITE_BATCH_SIZE) {
            return;
        }
        after = rows[rows.length - 1][keyColumn];
    }
}

/** Returns the node-sqlite3-wasm Database constructor, or null if unusable (warning already logged). */
async function tryLoadWasmEngine() {
    try {
        const module = await import('node-sqlite3-wasm');
        const Ctor = module.default.Database;
        // Actually construct a database, not just import the module, to confirm the WASM runtime works.
        new Ctor(':memory:').close();
        return Ctor;
    } catch (err) {
        console.error(color.red('[search] node-sqlite3-wasm (the WebAssembly SQLite search fallback) also failed to load:'));
        console.error(color.red(`[search]   ${err.message}`));
        return null;
    }
}

/** Resolved SQLite engine, or null if neither backend is usable (already logged in that case). */
export async function getSqliteEngine() {
    if (engine !== undefined) {
        return engine;
    }

    const NativeCtor = await getBetterSqlite3();
    if (NativeCtor) {
        engine = { kind: 'native', openDatabase: (path) => openNativeDatabase(NativeCtor, path) };
        return engine;
    }

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
