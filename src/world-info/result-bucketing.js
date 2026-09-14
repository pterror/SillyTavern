/**
 * Server-side port of the TAIL of public/scripts/world-info.js's checkWorldInfo() (roughly lines
 * 5275-5347 as of the port): the bucketing step that turns the flat set of activated world-info
 * entries (produced by activateWorldInfoEntries(), see ./activation.js) into the categorized,
 * positioned strings/arrays the prompt-assembly pipeline actually consumes. This is the piece that
 * feeds getWorldInfoPrompt()'s own return shape (public/scripts/world-info.js:~901-924); this
 * module mirrors that function's field names exactly (worldInfoBefore/worldInfoAfter/
 * worldInfoExamples/worldInfoDepth/anBefore/anAfter/outletEntries) so a future caller assembling
 * the full getWorldInfoPrompt()-equivalent can spread this module's result straight into the final
 * object, plus `worldInfoString: worldInfoBefore + worldInfoAfter`.
 *
 * Deliberately NOT ported here (each is a substantial separate mechanism, documented so a future
 * pass knows exactly what's missing, not guessing):
 * - `getRegexedString()` (public/scripts/extensions/regex/engine.js) - the client resolves each
 *   entry's final content through the user's regex scripts (with a WORLD_INFO placement and a
 *   depth override for atDepth entries) before bucketing it. This is a substantial separate
 *   regex-scripts subsystem with no server port yet (same documented gap as src/core-chat-build.js's
 *   `resolvedMessage` param). JUDGMENT CALL: this module takes an injected, synchronous
 *   `resolveContent(entry) => string` callback instead (the client's own getRegexedString call is
 *   synchronous, so a sync callback matches). Callers with no regex subsystem available can pass
 *   `resolveContent: (entry) => entry.content` to use the entry's content verbatim, or pre-resolve
 *   `.content` on each entry beforehand and pass through the same identity function - either way,
 *   this module never reaches into a regex engine itself.
 * - The author's-note combination step (client ~5352-5356: combining ANTopEntries/the live
 *   authors-note text/ANBottomEntries via `context.setExtensionPrompt()`) - that reads/writes the
 *   live `extension_prompts` side-table, which isn't wired server-side yet (same documented gap as
 *   src/story-string-assembly.js's `beforeScenarioAnchor`/`afterScenarioAnchor` params). This module
 *   just returns `anBefore`/`anAfter` as plain string arrays (matching getWorldInfoPrompt()'s own
 *   field names) for a future caller to combine with src/authors-note.js's already-resolved note
 *   text itself.
 * - `timedEffects.setTimedEffects()` / `buffer.resetExternalEffects()` / `timedEffects.cleanUp()`
 *   (client ~5358-5360) - internal timed-effects (sticky/cooldown/delay) bookkeeping. Verified this
 *   is ALREADY handled inside activateWorldInfoEntries() itself (./activation.js calls
 *   `timedEffects.setTimedEffects(activatedEntries)` and `timedEffects.cleanUp()` immediately before
 *   its own return) - calling it again here would be redundant/wrong.
 * - `getSortedEntries()` (resolving which lorebooks/entries are candidates in the first place) -
 *   that's activateWorldInfoEntries()'s own `entries` input parameter's concern.
 *
 * @typedef {object} WIActivatedEntry
 * @property {string} uid
 * @property {string} world
 * @property {string} content
 * @property {number} order
 * @property {number} position One of world_info_position
 * @property {number} [depth] Raw depth value (only meaningful for position === atDepth)
 * @property {number} [role] One of extension_prompt_roles (only meaningful for position === atDepth)
 * @property {string} [outletName] Only meaningful for position === outlet
 *
 * @typedef {object} WIExampleEntry
 * @property {number} position One of wi_anchor_position
 * @property {string} content
 *
 * @typedef {object} WIDepthEntry
 * @property {number} [depth] Raw `entry.depth` of whichever entry FIRST created this bucket (not
 *   the DEFAULT_DEPTH-defaulted value used to find/merge matching entries - see below)
 * @property {string[]} entries
 * @property {number} role One of extension_prompt_roles
 *
 * @typedef {object} WIBucketingResult
 * @property {string} worldInfoBefore
 * @property {string} worldInfoAfter
 * @property {WIExampleEntry[]} worldInfoExamples
 * @property {WIDepthEntry[]} worldInfoDepth
 * @property {string[]} anBefore
 * @property {string[]} anAfter
 * @property {Record<string, string[]>} outletEntries
 */

// Mirrored from public/scripts/world-info.js (world_info_position, wi_anchor_position, DEFAULT_DEPTH)
export const world_info_position = {
    before: 0,
    after: 1,
    ANTop: 2,
    ANBottom: 3,
    atDepth: 4,
    EMTop: 5,
    EMBottom: 6,
    outlet: 7,
};

export const wi_anchor_position = {
    before: 0,
    after: 1,
};

// Mirrored from public/scripts/world-info.js / src/authors-note.js (extension_prompt_roles)
export const extension_prompt_roles = {
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
};

const DEFAULT_DEPTH = 4;

/**
 * Buckets a flat array of activated world-info entries (as returned by
 * activateWorldInfoEntries()'s `activatedEntries`) into the categorized, positioned
 * strings/arrays the prompt-assembly pipeline needs.
 *
 * Entries are processed in descending-`.order` order but bucketed via `.unshift()`, which
 * re-reverses them back to ascending order within each bucket - this matches the client exactly
 * (see module doc comment) and must be preserved.
 *
 * @param {WIActivatedEntry[]} activatedEntries
 * @param {object} [options]
 * @param {(entry: WIActivatedEntry) => string} [options.resolveContent] Resolves an entry's final
 *   content (e.g. via a regex-scripts engine). Defaults to `(entry) => entry.content`, i.e. using
 *   the entry's content as-is - pass this explicitly if callers have already pre-resolved `.content`.
 * @returns {WIBucketingResult}
 */
export function bucketActivatedEntries(activatedEntries, { resolveContent = (entry) => entry.content } = {}) {
    const WIBeforeEntries = [];
    const WIAfterEntries = [];
    const EMEntries = [];
    const ANTopEntries = [];
    const ANBottomEntries = [];
    const WIDepthEntries = [];
    /** @type {Record<string, string[]>} */
    const WIOutletEntries = {};

    const sortFn = (a, b) => b.order - a.order;

    [...activatedEntries].sort(sortFn).forEach((entry) => {
        const content = resolveContent(entry);

        if (!content) {
            return;
        }

        switch (entry.position) {
            case world_info_position.before:
                WIBeforeEntries.unshift(content);
                break;
            case world_info_position.after:
                WIAfterEntries.unshift(content);
                break;
            case world_info_position.EMTop:
                EMEntries.unshift({ position: wi_anchor_position.before, content });
                break;
            case world_info_position.EMBottom:
                EMEntries.unshift({ position: wi_anchor_position.after, content });
                break;
            case world_info_position.ANTop:
                ANTopEntries.unshift(content);
                break;
            case world_info_position.ANBottom:
                ANBottomEntries.unshift(content);
                break;
            case world_info_position.atDepth: {
                const existingDepthIndex = WIDepthEntries.findIndex((e) => e.depth === (entry.depth ?? DEFAULT_DEPTH) && e.role === (entry.role ?? extension_prompt_roles.SYSTEM));
                if (existingDepthIndex !== -1) {
                    WIDepthEntries[existingDepthIndex].entries.unshift(content);
                } else {
                    // Note: the stored `.depth` here is the RAW entry.depth (no DEFAULT_DEPTH
                    // fallback), even though the fallback IS used above to find/merge matches.
                    // This is the client's actual behavior (public/scripts/world-info.js
                    // ~5321-5328) - preserved faithfully, not "fixed".
                    WIDepthEntries.push({
                        depth: entry.depth,
                        entries: [content],
                        role: entry.role ?? extension_prompt_roles.SYSTEM,
                    });
                }
                break;
            }
            case world_info_position.outlet: {
                if (!entry.outletName) {
                    console.warn(`[WI] Entry ${entry.uid} has position 'outlet' but no outlet name. Skipping.`);
                    break;
                }
                if (Array.isArray(WIOutletEntries[entry.outletName])) {
                    WIOutletEntries[entry.outletName].push(content);
                } else {
                    WIOutletEntries[entry.outletName] = [content];
                }
                break;
            }
            default:
                break;
        }
    });

    const worldInfoBefore = WIBeforeEntries.length ? WIBeforeEntries.join('\n') : '';
    const worldInfoAfter = WIAfterEntries.length ? WIAfterEntries.join('\n') : '';

    return {
        worldInfoBefore,
        worldInfoAfter,
        worldInfoExamples: EMEntries,
        worldInfoDepth: WIDepthEntries,
        anBefore: ANTopEntries,
        anAfter: ANBottomEntries,
        outletEntries: WIOutletEntries,
    };
}
