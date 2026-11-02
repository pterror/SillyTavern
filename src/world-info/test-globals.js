import { activateWorldInfoEntries } from './activation.js';
import { worldInfoGlobalsOf } from '../../public/scripts/world-info-globals.js';

/** @type {import('./key-matching.js').MatchDefaults} */
export const LOOSE = Object.freeze({ caseSensitive: false, matchWholeWords: false });

/**
 * @param {Partial<import('../../public/scripts/world-info-globals.js').WorldInfoGlobals>} [overrides]
 */
export function globalsWith(overrides = {}) {
    const given = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
    return worldInfoGlobalsOf({ world_info_depth: 0, world_info_recursive: true, ...given });
}

/**
 * @param {import('./activation.js').WIEntry[]} entries
 * @param {string[]} chat
 * @param {Record<string, any>} options
 */
export function activate(entries, chat, options) {
    const {
        budgetPercent, budgetCap, depth, recursive, maxRecursionStepsSetting, useGroupScoring,
        minActivations, minActivationsDepthMax, caseSensitive, matchWholeWords, ...rest
    } = options;
    return activateWorldInfoEntries(entries, chat, {
        ...rest,
        maxContext: rest.maxContext,
        countTokens: rest.countTokens,
        globals: globalsWith({
            world_info_budget: budgetPercent,
            world_info_budget_cap: budgetCap,
            world_info_depth: depth,
            world_info_recursive: recursive,
            world_info_max_recursion_steps: maxRecursionStepsSetting,
            world_info_use_group_scoring: useGroupScoring,
            world_info_min_activations: minActivations,
            world_info_min_activations_depth_max: minActivationsDepthMax,
            world_info_case_sensitive: caseSensitive,
            world_info_match_whole_words: matchWholeWords,
        }),
    });
}
