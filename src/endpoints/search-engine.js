import { getTantivyModule } from './tantivy-engine.js';
import { getSqliteEngine } from './sqlite-engine.js';

/**
 * Resolves the full character/group search engine fallback chain: tantivy (fastest, see tantivy-engine.js) first,
 * falling back to the existing SQLite FTS5 chain (native better-sqlite3, then WebAssembly node-sqlite3-wasm - see
 * sqlite-engine.js) if tantivy's native binding can't load on this install, and finally 'unavailable' if nothing
 * usable is left. A working-but-slower tier beats no search - the same reasoning sqlite-engine.js already applies
 * one level down between its own native and wasm tiers.
 *
 * This module doesn't build or query anything itself - characters-search-index.js and groups-search-index.js
 * branch on `.tier` and call the tantivy- or sqlite-specific build/query functions accordingly, since the two
 * engines have genuinely different data models (a tantivy Index/Schema vs. a SQLite FTS5 virtual table) that
 * don't share an implementation, only the same shared search-index-coordinator.js rebuild/staleness logic.
 * @type {ResolvedSearchEngine | undefined} undefined = not yet resolved
 */
let resolved = undefined;

/**
 * @typedef {
 *   | { tier: 'tantivy', tantivy: typeof import('@oxdev03/node-tantivy-binding') }
 *   | { tier: 'native' | 'wasm', sqlite: { kind: 'native' | 'wasm', openDatabase: (path: string) => import('./sqlite-engine.js').SqliteEngineHandle } }
 *   | { tier: 'unavailable' }
 * } ResolvedSearchEngine
 */

/**
 * @returns {Promise<ResolvedSearchEngine>} The resolved engine tier, memoized process-wide (each underlying
 * getTantivyModule()/getSqliteEngine() call is already memoized itself - this just avoids re-running the
 * tier-selection logic, and the console diagnostics those calls print, on every single search request).
 */
export async function resolveSearchEngine() {
    if (resolved !== undefined) {
        return resolved;
    }

    const tantivy = await getTantivyModule();
    if (tantivy) {
        resolved = { tier: 'tantivy', tantivy };
        return resolved;
    }

    const sqlite = await getSqliteEngine();
    if (sqlite) {
        resolved = { tier: sqlite.kind, sqlite };
        return resolved;
    }

    resolved = { tier: 'unavailable' };
    return resolved;
}
