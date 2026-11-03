/**
 * @typedef {object} WIActivatedEntry
 * @property {string} uid
 * @property {string} world
 * @property {string} content
 * @property {number} order
 * @property {number} position
 * @property {number} [depth]
 * @property {number} [role]
 * @property {string} [outletName]
 * @typedef {object} WIExampleEntry
 * @property {number} position
 * @property {string} content
 * @typedef {object} WIDepthEntry
 * @property {number} [depth]
 * @property {string[]} entries
 * @property {number} role
 * @typedef {object} WIBucketingResult
 * @property {string} worldInfoBefore
 * @property {string} worldInfoAfter
 * @property {string[]} worldInfoBeforeEntries
 * @property {string[]} worldInfoAfterEntries
 * @property {WIExampleEntry[]} worldInfoExamples
 * @property {WIDepthEntry[]} worldInfoDepth
 * @property {string[]} anBefore
 * @property {string[]} anAfter
 * @property {Record<string, string[]>} outletEntries
 */

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

export const extension_prompt_roles = {
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
};

const DEFAULT_DEPTH = 4;

/**
 * @param {WIActivatedEntry[]} activatedEntries
 * @param {object} [options]
 * @param {(entry: WIActivatedEntry) => string} [options.resolveContent]
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
        worldInfoBeforeEntries: WIBeforeEntries,
        worldInfoAfterEntries: WIAfterEntries,
        worldInfoExamples: EMEntries,
        worldInfoDepth: WIDepthEntries,
        anBefore: ANTopEntries,
        anAfter: ANBottomEntries,
        outletEntries: WIOutletEntries,
    };
}
