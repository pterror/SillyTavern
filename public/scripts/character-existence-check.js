/**
 * Shared wrapper around `characterRepository.exists()` for the design doc's §4.2 "existence checks that are
 * destructive when they answer wrong" cluster. Every §4.2 call site (tag-backup restore, tag/tag_map pruning,
 * the world-info character-filter cleanup, ...) needs the exact same failure contract: a network error must
 * never be read as "none of these exist" - that's what makes each of those sites destructive in the first
 * place - so it's pulled out once here rather than duplicated per call site.
 *
 * Kept intentionally tiny and dependency-light (only `character-repository.js`) so it's easy to unit test
 * without dragging in the jQuery/DOM-heavy modules that pull it in (tags.js, world-info.js) - see
 * tests/character-existence-check.test.js.
 */

import { characterRepository } from './character-repository.js';

/**
 * @param {string[]} ids
 * @returns {Promise<Record<string, boolean>|null>} every requested id present as a key on success; `null` if
 * the check itself failed (network error, etc) - callers MUST treat `null` as "could not verify", never as an
 * existence answer (design doc §4.2: "a failed or partial existence check must abort the mutation, never fall
 * through to 'delete it'" - the abort behaviour itself lives with each call site, since only the call site
 * knows what the destructive action is and what "abort" means for it).
 */
export async function checkCharactersExistOrNull(ids) {
    if (ids.length === 0) return {};
    try {
        return await characterRepository.exists(ids);
    } catch (error) {
        console.error('Character existence check failed, treating as unverifiable (not as nonexistent):', error);
        return null;
    }
}
