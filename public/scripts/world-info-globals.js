/**
 * @typedef {object} WorldInfoGlobals
 * @property {number} world_info_depth
 * @property {number} world_info_min_activations
 * @property {number} world_info_min_activations_depth_max
 * @property {number} world_info_budget
 * @property {boolean} world_info_include_names
 * @property {boolean} world_info_recursive
 * @property {boolean} world_info_overflow_alert
 * @property {boolean} world_info_case_sensitive
 * @property {boolean} world_info_match_whole_words
 * @property {number} world_info_character_strategy
 * @property {number} world_info_budget_cap
 * @property {boolean} world_info_use_group_scoring
 * @property {number} world_info_max_recursion_steps
 */

/** @type {Readonly<WorldInfoGlobals>} */
export const WORLD_INFO_GLOBAL_DEFAULTS = Object.freeze({
    world_info_depth: 2,
    world_info_min_activations: 0,
    world_info_min_activations_depth_max: 0,
    world_info_budget: 25,
    world_info_include_names: true,
    world_info_recursive: false,
    world_info_overflow_alert: false,
    world_info_case_sensitive: false,
    world_info_match_whole_words: false,
    world_info_character_strategy: 1,
    world_info_budget_cap: 0,
    world_info_use_group_scoring: false,
    world_info_max_recursion_steps: 0,
});

/**
 * @param {Record<string, unknown> | null | undefined} stored
 * @returns {Readonly<WorldInfoGlobals>}
 */
export function worldInfoGlobalsOf(stored) {
    /** @type {Record<string, number | boolean>} */
    const out = {};
    for (const [key, fallback] of Object.entries(WORLD_INFO_GLOBAL_DEFAULTS)) {
        const value = stored?.[key];
        if (value === undefined || value === null) {
            out[key] = fallback;
        } else if (typeof fallback === 'boolean') {
            out[key] = Boolean(value);
        } else {
            const number = Number(value);
            out[key] = Number.isFinite(number) ? number : fallback;
        }
    }
    if (Number(out.world_info_budget) > 100) out.world_info_budget = WORLD_INFO_GLOBAL_DEFAULTS.world_info_budget;
    return Object.freeze(/** @type {WorldInfoGlobals} */ (/** @type {unknown} */ (out)));
}
