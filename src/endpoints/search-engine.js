import { getTantivyModule } from './tantivy-engine.js';

/**
 * Resolves the character/group search engine: tantivy if its native binding loaded, 'unavailable' otherwise.
 * Platform coverage of @oxdev03/node-tantivy-binding 0.3.x is broad enough (13 targets including linux-arm64,
 * musl, freebsd, android, win32-arm64) that the SQLite FTS5 fallback chain this module used to maintain is no
 * longer needed.
 * @type {ResolvedSearchEngine | undefined} undefined = not yet resolved
 */
let resolved = undefined;

/**
 * @typedef {
 *   | { tier: 'tantivy', tantivy: typeof import('@oxdev03/node-tantivy-binding') }
 *   | { tier: 'unavailable' }
 * } ResolvedSearchEngine
 */

/**
 * @returns {Promise<ResolvedSearchEngine>}
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

    resolved = { tier: 'unavailable' };
    return resolved;
}
