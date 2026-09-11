import { getTantivyModule } from './tantivy-engine.js';

/**
 * Resolves the character/group search engine: tantivy if its native binding loaded, 'unavailable' otherwise.
 * @type {ResolvedSearchEngine | undefined} undefined = not yet resolved
 */
let resolved = undefined;

/**
 * @typedef {
 *   | { tier: 'tantivy', tantivy: typeof import('@oxdev03/node-tantivy-binding') }
 *   | { tier: 'unavailable' }
 * } ResolvedSearchEngine
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
