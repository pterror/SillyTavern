import { color } from '../util.js';
import { getBetterSqlite3 } from './native-sqlite.js';
import { guardNoOpWrites } from './sqlite-no-op-guard.js';

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
 * @type {{ kind: 'native' | 'wasm', openDatabase: (path: string, options?: SqliteOpenOptions) => SqliteEngineHandle } | null | undefined}
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
 * @property {(sql: string, params: object|any[]|undefined, max: number) => object[]} readBounded Reads every row into
 *   an array, reading at most max + 1 of them: throws if a row past max comes back, so a result cut short is never
 *   returned as if it were whole. max must be a non-negative integer. Callers that expect more than max rows page
 *   instead.
 * @property {(fn: () => void) => void} transaction Runs fn inside a single BEGIN/COMMIT, rolling back on throw.
 * @property {() => void} checkpoint Folds the WAL into the main file without waiting on any lock, and shrinks the WAL
 *   file when nothing is reading (native only; no-op on wasm).
 * @property {(name: string, fn: (...args: any[]) => any) => void} defineFunction Registers a scalar SQL function.
 * @property {() => void} close Native: checkpoints as checkpoint() does (unless opened `readonly`), then closes.
 *   On both engines, iterate() afterwards throws, so a streamRows()/streamWrite() interrupted by close() throws instead of ending early.
 */

/**
 * @typedef {object} SqliteOpenOptions
 * @property {number} [busyTimeoutMs] How long a statement waits on another connection's lock before failing busy.
 *   Default 15000.
 * @property {boolean} [retryOnBusy] false: run/insertMany/transaction throw the first busy error instead of
 *   retrying it. Default true.
 * @property {boolean} [readonly] Native engine only; the wasm engine ignores it. true: opens an existing file
 *   read-only (better-sqlite3 `readonly`, `fileMustExist`), sets no journal_mode, and close() doesn't checkpoint.
 *   Writes fail in SQLite (SQLITE_READONLY). Default false.
 */

/** Statements whose no-op guard didn't prepare, warned about once each. */
const unguardedWarned = new Set();

/**
 * Prepares `sql` with its no-op guard (sqlite-no-op-guard.js). If the guarded form doesn't prepare, the statement runs
 * as written, so the write still happens, and the statement is named once on the console.
 * @param {{ prepare: (sql: string) => any }} db
 * @param {string} sql
 */
function prepareGuarded(db, sql) {
    const guarded = guardNoOpWrites(sql);
    if (guarded === sql) return db.prepare(sql);
    try {
        return db.prepare(guarded);
    } catch (err) {
        if (!unguardedWarned.has(sql)) {
            unguardedWarned.add(sql);
            console.warn(color.yellow(`[sqlite] A write runs without its no-op guard (${err?.message ?? err}): ${sql.replace(/\s+/g, ' ').trim()}`));
        }
        return db.prepare(sql);
    }
}

const WRITE_WHILE_ITERATING_MESSAGE = 'write while iterate() is open';
const HANDLE_CLOSED_MESSAGE = 'database handle is closed';

/** WAL file size SQLite truncates back down to after a checkpoint (native only - wasm has no WAL). */
const JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

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

    /**
     * @param {string} sql
     * @param {object|any[]|undefined} params
     * @param {number} max
     */
    function readBounded(sql, params, max) {
        if (!Number.isSafeInteger(max) || max < 0) {
            throw new TypeError(`readBounded() needs max as a non-negative integer, got ${String(max)}`);
        }
        const rows = [];
        // Ending the loop early (the throw) finalizes the statement, so no read stays open.
        for (const row of iterate(sql, params)) {
            if (rows.length === max) {
                throw new Error(`readBounded(): more than ${max} rows for: ${sql}`);
            }
            rows.push(row);
        }
        return rows;
    }

    return { iterate, readBounded, assertNoOpenIterator };
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
export function isBusyError(err) {
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
    let blocked = false;
    try {
        return retryWhileBusy(fn, label, startedAt, () => { blocked = true; });
    } finally {
        // A failed attempt blocked in busy_timeout before it threw, so the wait runs from the call's start.
        if (blocked) busyWaitMs += Date.now() - startedAt;
    }
}

let busyWaitMs = 0;

/** Wall ms this thread's runWithBusyRetry() calls have spent on a lock: each call that hit a busy error counts
 * from its start until it succeeded or gave up. Cumulative; callers diff it around the work they time. */
export function getBusyWaitMs() {
    return busyWaitMs;
}

function retryWhileBusy(fn, label, startedAt, onBusy) {
    let lastError;
    let attempts = 0;
    for (let attempt = 0; attempt < BUSY_RETRY_MAX_ATTEMPTS; attempt++) {
        attempts++;
        try {
            return fn();
        } catch (err) {
            if (!isBusyError(err)) throw err;
            onBusy();
            lastError = err;
            const elapsed = Date.now() - startedAt;
            if (elapsed >= BUSY_RETRY_TOTAL_BUDGET_MS || attempt === BUSY_RETRY_MAX_ATTEMPTS - 1) break;
            // Jitter avoids colliding writers backing off in lockstep.
            const delay = Math.min(BUSY_RETRY_BASE_DELAY_MS * (2 ** attempt), 1000);
            sleepSync(delay + Math.floor(Math.random() * delay));
        }
    }
    console.error(`[sqlite-engine] ${label} still blocked by a database lock after ${attempts} attempts over ${Date.now() - startedAt}ms - giving up and rethrowing.`);
    throw lastError;
}

/**
 * @param {boolean} retryOnBusy
 * @returns {<T>(fn: () => T, label: string) => T}
 */
function busyRetryFor(retryOnBusy) {
    return retryOnBusy ? runWithBusyRetry : (fn) => fn();
}

/**
 * @param {typeof import('better-sqlite3')} DatabaseCtor
 * @param {string} path
 * @param {SqliteOpenOptions} [options]
 * @returns {SqliteEngineHandle}
 */
export function openNativeDatabase(DatabaseCtor, path, { busyTimeoutMs = BUSY_TIMEOUT_MS, retryOnBusy = true, readonly = false } = {}) {
    const withBusyRetry = busyRetryFor(retryOnBusy);
    const db = readonly ? new DatabaseCtor(path, { readonly: true, fileMustExist: true }) : new DatabaseCtor(path);
    if (!readonly) {
        db.pragma('journal_mode = WAL');
    }
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    db.pragma(`journal_size_limit = ${JOURNAL_SIZE_LIMIT_BYTES}`);

    let closed = false;

    // Prepared-statement cache keyed by SQL text - avoids recompiling the same SQL on every call in hot loops.
    const stmtCache = new Map();
    const prepare = (sql) => {
        let stmt = stmtCache.get(sql);
        if (!stmt) {
            stmt = prepareGuarded(db, sql);
            stmtCache.set(sql, stmt);
        }
        return stmt;
    };

    const { iterate, readBounded, assertNoOpenIterator } = createRowStreaming((sql, params) => {
        if (closed) {
            throw new Error(HANDLE_CLOSED_MESSAGE);
        }
        const rows = db.prepare(sql).iterate(params ?? {});
        return { rows, finalize: () => { rows.return(); } };
    });

    // A TRUNCATE checkpoint holds the write lock while it waits for every reader to finish, so with the normal busy
    // timeout one open read stalled every writer (every request's write included) for up to busyTimeoutMs. This never
    // waits: PASSIVE folds in what it can without locking anyone out, then TRUNCATE runs only if it can start right
    // away, shrinking the file when nothing is reading and doing nothing otherwise.
    const checkpointWithoutWaiting = () => {
        db.pragma('wal_checkpoint(PASSIVE)');
        db.pragma('busy_timeout = 0');
        try {
            db.pragma('wal_checkpoint(TRUNCATE)');
        } catch (err) {
            if (!isBusyError(err)) throw err;
        } finally {
            db.pragma(`busy_timeout = ${busyTimeoutMs}`);
        }
    };

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
            withBusyRetry(() => tx(rows), 'insertMany');
        },
        query: (sql, param) => prepare(sql).all(param),
        // Reads (query/get/all) are deliberately NOT retried: in WAL mode a reader never blocks on a writer,
        // so a read that fails this way has a different cause and should surface rather than be slept over.
        run: (sql, params) => { assertNoOpenIterator(); return withBusyRetry(() => prepare(sql).run(params ?? {}), 'run'); },
        get: (sql, params) => prepare(sql).get(params ?? {}),
        all: (sql, params) => prepare(sql).all(params ?? {}),
        iterate,
        readBounded,
        // .immediate, not deferred: takes the write lock up front so a read-then-write transaction never needs
        // to upgrade mid-transaction and hit SQLITE_BUSY_SNAPSHOT (which the busy handler doesn't cover).
        transaction: (fn) => { assertNoOpenIterator(); return withBusyRetry(() => db.transaction(fn).immediate(), 'transaction'); },
        checkpoint: () => { assertNoOpenIterator(); checkpointWithoutWaiting(); },
        // deterministic: true is safe - every registered function in this codebase is a pure hash.
        defineFunction: (name, fn) => { db.function(name, { deterministic: true }, fn); },
        // An ordinary close never shrinks the WAL file; the checkpoint does when nothing else is reading
        // (best-effort, never waiting). A read-only handle doesn't checkpoint.
        close: () => {
            closed = true;
            if (!readonly) {
                try { checkpointWithoutWaiting(); } catch { /* best-effort */ }
            }
            db.close();
        },
    };
}

/**
 * @param {import('node-sqlite3-wasm').Database} WasmDatabaseCtor
 * @param {string} path
 * @param {SqliteOpenOptions} [options]
 * @returns {SqliteEngineHandle}
 */
export function openWasmDatabase(WasmDatabaseCtor, path, { busyTimeoutMs = BUSY_TIMEOUT_MS, retryOnBusy = true } = {}) {
    const withBusyRetry = busyRetryFor(retryOnBusy);
    const db = new WasmDatabaseCtor(path);
    // No WAL on this engine, so it serializes on the whole database file - more prone to lock contention.
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);

    let closed = false;

    // Prepared-statement cache keyed by SQL text. Unlike better-sqlite3, statements need explicit finalize() -
    // cached ones are finalized on close(), not after each call.
    const stmtCache = new Map();
    const prepare = (sql) => {
        let stmt = stmtCache.get(sql);
        if (!stmt) {
            stmt = prepareGuarded(db, sql);
            stmtCache.set(sql, stmt);
        }
        return stmt;
    };

    const { iterate, readBounded, assertNoOpenIterator } = createRowStreaming((sql, params) => {
        if (closed) {
            throw new Error(HANDLE_CLOSED_MESSAGE);
        }
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
            withBusyRetry(() => {
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
        run: (sql, params) => { assertNoOpenIterator(); return withBusyRetry(() => prepare(sql).run(prefixNamedParamsForWasm(params) ?? {}), 'run'); },
        // node-sqlite3-wasm returns null for no row; the handle contract is undefined.
        get: (sql, params) => prepare(sql).get(prefixNamedParamsForWasm(params) ?? {}) ?? undefined,
        all: (sql, params) => prepare(sql).all(prefixNamedParamsForWasm(params) ?? {}),
        iterate,
        readBounded,
        // No native transaction() API on this engine - BEGIN IMMEDIATE/COMMIT/ROLLBACK is equivalent.
        transaction: (fn) => {
            assertNoOpenIterator();
            withBusyRetry(() => {
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
            closed = true;
            for (const stmt of stmtCache.values()) {
                stmt.finalize();
            }
            stmtCache.clear();
            db.close();
        },
    };
}

const STREAM_WRITE_BATCH_SIZE = 1000;

/**
 * Reads rows and writes per batch without an unbounded read and without a read open while writing (a read held
 * open across writes keeps the WAL from restarting, so it grows for as long as the pass runs). onBatch(rows) runs
 * once per batch (at most 1000 rows) inside a transaction on `handle`.
 *
 * Each batch is one keyset page read on `handle`, its statement finished before onBatch runs. firstPageSql reads the
 * first page and nextPageSql every later one. Both must select keyColumn, `ORDER BY <keyColumn>` and end with
 * `LIMIT @limit`; keyColumn must be unique. nextPageSql's key condition must be `<keyColumn> > @after` alone, with no
 * OR around it and no sentinel standing in for @after: SQLite can't seek on the OR, so every page would re-read from
 * the start, and a sentinel skips any key equal to or below it. firstPageSql is bound with firstPageParams plus
 * `limit` (1000); nextPageSql with nextPageParams plus `limit` and `after` (the last keyColumn value read). Each params
 * object must hold exactly the other parameters its SQL uses, since wasm rejects one the SQL doesn't. The next page is
 * read only if the previous one came back full.
 * @param {SqliteEngineHandle} handle
 * @param {{ firstPageSql: string, firstPageParams: object, nextPageSql: string, nextPageParams: object, keyColumn: string, onBatch: (rows: object[]) => void }} options
 */
export function streamWrite(handle, { firstPageSql, firstPageParams, nextPageSql, nextPageParams, keyColumn, onBatch }) {
    let sql = firstPageSql;
    let params = { ...firstPageParams, limit: STREAM_WRITE_BATCH_SIZE };
    for (;;) {
        const rows = Array.from(handle.iterate(sql, params));
        if (rows.length > 0) {
            handle.transaction(() => onBatch(rows));
        }
        if (rows.length < STREAM_WRITE_BATCH_SIZE) {
            return;
        }
        sql = nextPageSql;
        params = { ...nextPageParams, after: rows[rows.length - 1][keyColumn], limit: STREAM_WRITE_BATCH_SIZE };
    }
}

/**
 * Async stream of row batches (each at most 1000 rows, in keyColumn order) that callers may `await` and write
 * between: each batch is one keyset page read on `handle` with its statement finished before it is yielded, so
 * no read is open while the consumer is suspended. Same options contract and paging as streamWrite().
 * @param {SqliteEngineHandle} handle
 * @param {{ firstPageSql: string, firstPageParams: object, nextPageSql: string, nextPageParams: object, keyColumn: string }} options
 * @returns {AsyncGenerator<object[], void, undefined>}
 */
export async function* streamRows(handle, { firstPageSql, firstPageParams, nextPageSql, nextPageParams, keyColumn }) {
    let sql = firstPageSql;
    let params = { ...firstPageParams, limit: STREAM_WRITE_BATCH_SIZE };
    for (;;) {
        const rows = Array.from(handle.iterate(sql, params));
        if (rows.length > 0) {
            yield rows;
        }
        if (rows.length < STREAM_WRITE_BATCH_SIZE) {
            return;
        }
        sql = nextPageSql;
        params = { ...nextPageParams, after: rows[rows.length - 1][keyColumn], limit: STREAM_WRITE_BATCH_SIZE };
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
        engine = { kind: 'native', openDatabase: (path, options) => openNativeDatabase(NativeCtor, path, options) };
        return engine;
    }

    console.error(color.yellow('[search] Trying the WebAssembly SQLite search backend (node-sqlite3-wasm) instead - same ranking and label:query support as native, just slower.'));
    const WasmCtor = await tryLoadWasmEngine();
    if (WasmCtor) {
        engine = { kind: 'wasm', openDatabase: (path, options) => openWasmDatabase(WasmCtor, path, options) };
        return engine;
    }

    console.error(color.red('[search] No usable SQLite search backend on this install - character/group search is unavailable until this is fixed.'));
    engine = null;
    return null;
}
