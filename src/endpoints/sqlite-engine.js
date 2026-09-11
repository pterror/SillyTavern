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
 * @property {(sql: string) => void} exec
 * @property {(sql: string, rows: object[]) => void} insertMany Runs an INSERT once per row in a single transaction.
 * @property {(sql: string, param: string) => object[]} query
 * @property {(sql: string, params?: object|any[]) => {changes: number, lastInsertRowid: number|bigint}} run
 * @property {(sql: string, params?: object|any[]) => object|undefined} get
 * @property {(sql: string, params?: object|any[]) => object[]} all
 * @property {(fn: () => void) => void} transaction Runs fn inside a single BEGIN/COMMIT, rolling back on throw.
 * @property {() => void} checkpoint Folds WAL into the main file (native only; no-op on wasm).
 * @property {(name: string, fn: (...args: any[]) => any) => void} defineFunction Registers a scalar SQL function.
 * @property {() => void} close
 */

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

    return {
        exec: (sql) => db.exec(sql),
        insertMany: (sql, rows) => {
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
        run: (sql, params) => runWithBusyRetry(() => prepare(sql).run(params ?? {}), 'run'),
        get: (sql, params) => prepare(sql).get(params ?? {}),
        all: (sql, params) => prepare(sql).all(params ?? {}),
        // .immediate, not deferred: takes the write lock up front so a read-then-write transaction never needs
        // to upgrade mid-transaction and hit SQLITE_BUSY_SNAPSHOT (which the busy handler doesn't cover).
        transaction: (fn) => runWithBusyRetry(() => db.transaction(fn).immediate(), 'transaction'),
        checkpoint: () => db.pragma('wal_checkpoint(TRUNCATE)'),
        // deterministic: true is safe - every registered function in this codebase is a pure hash.
        defineFunction: (name, fn) => { db.function(name, { deterministic: true }, fn); },
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

    return {
        exec: (sql) => db.exec(sql),
        insertMany: (sql, rows) => {
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
        run: (sql, params) => runWithBusyRetry(() => prepare(sql).run(prefixNamedParamsForWasm(params) ?? {}), 'run'),
        get: (sql, params) => prepare(sql).get(prefixNamedParamsForWasm(params) ?? {}),
        all: (sql, params) => prepare(sql).all(prefixNamedParamsForWasm(params) ?? {}),
        // No native transaction() API on this engine - BEGIN IMMEDIATE/COMMIT/ROLLBACK is equivalent.
        transaction: (fn) => runWithBusyRetry(() => {
            db.exec('BEGIN IMMEDIATE');
            try {
                fn();
                db.exec('COMMIT');
            } catch (err) {
                db.exec('ROLLBACK');
                throw err;
            }
        }, 'transaction'),
        checkpoint: () => { /* no-op: this engine's WASM-compiled SQLite doesn't support WAL mode at all */ },
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
