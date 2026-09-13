import { substituteParams } from './macro-substitution.js';

/**
 * Server-side port of public/scripts/cfg-scale.js's CFG (classifier-free guidance) resolution -
 * getGuidanceScale(), getCustomSeparator(), and getCfgPrompt() - plus the max-context adjustment
 * slice of public/script.js's Generate() (~lines 5664-5679) that consumes them. Fills the gap
 * src/final-prompt-combination.js's module doc explicitly left open (it takes an ALREADY-RESOLVED
 * `{value, depth}` CFG prompt and punts on getCfgPrompt() itself).
 *
 * Unlike the client, every `chat_metadata`/`extension_settings.cfg`/`selected_group` read is an
 * explicit parameter instead of an ambient global - same "caller resolves entities" pattern as
 * src/character-card-fields.js (e.g. the client's avatar-keyed character-CFG lookup becomes a
 * plain `charaCfg` object param here, and `!!selected_group` becomes `isGroup`).
 *
 * Judgment calls:
 * - The client's `getGuidanceScale()` opening `if (!extension_settings.cfg) return;` guard is
 *   about whether the CFG *extension* is enabled at all, not about resolving a value from
 *   already-given inputs, so it isn't ported - a caller with the extension disabled simply never
 *   calls this module (or calls it with every source undefined, which falls through to `undefined`).
 * - `getCfgPrompt()`'s character branch takes a plain `charaCfg` param (the character's CFG
 *   settings object, or undefined) instead of re-deriving it from an avatar lookup, matching
 *   `getGuidanceScale()`'s param and avoiding a second lookup for the same value.
 * - The `useCfgPrompt = cfgGuidanceScale && cfgGuidanceScale.value !== 1` gate ahead of the
 *   max-context adjustment (public/script.js ~line 5666) is done INSIDE `adjustMaxContextForCfg()`
 *   rather than left to the caller, since the function already takes `cfgGuidanceScale` as a param
 *   anyway - this keeps "should CFG apply at all" and "how much to adjust by" one atomic decision.
 */

/**
 * @typedef {object} GuidanceScale
 * @property {number} type One of `cfgType`'s values.
 * @property {number} value The resolved guidance scale (never `1` - a scale of `1` means CFG is disabled).
 */

/**
 * @typedef {object} CfgSettings Mirrors one entry of the client's `extension_settings.cfg.chara`
 *  array, or `extension_settings.cfg.global`.
 * @property {number} [guidance_scale]
 * @property {string} [negative_prompt]
 * @property {string} [positive_prompt]
 */

/**
 * @typedef {object} GetGuidanceScaleParams
 * @property {number} [chatGuidanceScale] Equivalent of `chat_metadata[metadataKeys.guidance_scale]`.
 * @property {boolean} [groupchatIndividualChars] Equivalent of `chat_metadata[metadataKeys.groupchat_individual_chars] ?? false`.
 * @property {boolean} [isGroup] Equivalent of `!!selected_group`.
 * @property {CfgSettings} [charaCfg] Equivalent of the client's avatar-keyed
 *  `extension_settings.cfg.chara?.find(...)` lookup - caller resolves it; `undefined` if no match.
 * @property {CfgSettings} [globalCfg] Equivalent of `extension_settings.cfg.global`.
 */

/**
 * Port of public/scripts/cfg-scale.js's `getGuidanceScale()`. Resolves which CFG source (chat,
 * character, or global) is active, in that priority order, respecting the "guidance_scale === 1
 * means disabled" guard on each level.
 * @param {GetGuidanceScaleParams} [params]
 * @returns {GuidanceScale|undefined} `undefined` when no source is active.
 */
export const cfgType = {
    chat: 0,
    chara: 1,
    global: 2,
};

export function getGuidanceScale({
    chatGuidanceScale,
    groupchatIndividualChars = false,
    isGroup = false,
    charaCfg,
    globalCfg,
} = {}) {
    if (chatGuidanceScale && chatGuidanceScale !== 1 && !groupchatIndividualChars) {
        return { type: cfgType.chat, value: chatGuidanceScale };
    }

    if ((!isGroup && charaCfg || groupchatIndividualChars) && charaCfg?.guidance_scale !== 1) {
        return { type: cfgType.chara, value: charaCfg.guidance_scale };
    }

    if (globalCfg && globalCfg.guidance_scale !== 1) {
        return { type: cfgType.global, value: globalCfg.guidance_scale };
    }

    return undefined;
}

/**
 * Port of public/scripts/cfg-scale.js's `getCustomSeparator()`. `rawSeparator` is the raw
 * (JSON-encoded) `chat_metadata[metadataKeys.prompt_separator]` - falsy means "not set". Invalid
 * JSON falls back to the default separator, same as the client (its `console.warn` is ported too).
 * @param {string} [rawSeparator]
 * @returns {string}
 */
function getCustomSeparator(rawSeparator) {
    const defaultSeparator = '\n';

    if (!rawSeparator) {
        return defaultSeparator;
    }

    try {
        return JSON.parse(rawSeparator);
    } catch {
        console.warn('[cfg-prompt-resolve] Invalid JSON detected for prompt separator. Using default separator.');
        return defaultSeparator;
    }
}

/**
 * @typedef {object} ChatMetadataCfgPrompts
 * @property {string} [negativePrompt] Equivalent of `chat_metadata[metadataKeys.negative_prompt]`.
 * @property {string} [positivePrompt] Equivalent of `chat_metadata[metadataKeys.positive_prompt]`.
 */

/**
 * @typedef {object} GetCfgPromptParams
 * @property {ChatMetadataCfgPrompts} [chatMetadataPrompts]
 * @property {CfgSettings} [charaCfg] Same resolved object as passed to `getGuidanceScale()` - not re-derived here.
 * @property {CfgSettings} [globalCfg]
 * @property {number[]} [promptCombine] Equivalent of `chat_metadata[metadataKeys.prompt_combine] ?? []` -
 *  `cfgType` values whose prompt text gets combined in ADDITION to whichever type is "active".
 * @property {string} [promptSeparator] Raw (JSON-encoded) `chat_metadata[metadataKeys.prompt_separator]`.
 * @property {number} [promptInsertionDepth] Equivalent of `chat_metadata[metadataKeys.prompt_insertion_depth] ?? 1`.
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext] Forwarded to `substituteParams()`.
 */

/**
 * @typedef {object} CfgPrompt
 * @property {string} value The combined, separator-joined CFG prompt text (possibly empty).
 * @property {number} depth Insertion depth (0 means "append to the last message").
 */

/**
 * Port of public/scripts/cfg-scale.js's `getCfgPrompt(guidanceScale, isNegative, quiet)`. Builds
 * the combined prompt from whichever of chat/chara/global sources match `guidanceScale.type` or
 * are additionally listed in `promptCombine`.
 *
 * Order note: sources are unshifted in this exact sequence - chat, then chara, then global - so
 * when all three apply the FINAL joined order is global, chara, chat (each unshift puts its
 * result at index 0, so the earliest-unshifted source, chat, ends up last). Mirrors the client exactly.
 *
 * The client's `quiet` param only gated a `console.log` of the resolved prompt (no behavioral
 * effect); it isn't ported, so `quiet` isn't a param here.
 * @param {GuidanceScale} guidanceScale
 * @param {boolean} isNegative
 * @param {GetCfgPromptParams} [params]
 * @returns {CfgPrompt}
 */
export function getCfgPrompt(guidanceScale, isNegative, {
    chatMetadataPrompts = {},
    charaCfg,
    globalCfg,
    promptCombine = [],
    promptSeparator,
    promptInsertionDepth = 1,
    macroContext = {},
} = {}) {
    const splitCfgPrompt = [];

    if (guidanceScale.type === cfgType.chat || promptCombine.includes(cfgType.chat)) {
        const text = isNegative ? chatMetadataPrompts.negativePrompt : chatMetadataPrompts.positivePrompt;
        splitCfgPrompt.unshift(substituteParams(text, macroContext));
    }

    if (guidanceScale.type === cfgType.chara || promptCombine.includes(cfgType.chara)) {
        const text = isNegative ? charaCfg?.negative_prompt : charaCfg?.positive_prompt;
        splitCfgPrompt.unshift(substituteParams(text, macroContext));
    }

    if (guidanceScale.type === cfgType.global || promptCombine.includes(cfgType.global)) {
        const text = isNegative ? globalCfg?.negative_prompt : globalCfg?.positive_prompt;
        splitCfgPrompt.unshift(substituteParams(text, macroContext));
    }

    const customSeparator = getCustomSeparator(promptSeparator);
    const combinedCfgPrompt = splitCfgPrompt.filter((e) => e.length > 0).join(customSeparator);

    return {
        value: combinedCfgPrompt,
        depth: promptInsertionDepth,
    };
}

/**
 * @typedef {object} AdjustMaxContextForCfgParams
 * @property {GuidanceScale|undefined} cfgGuidanceScale Equivalent of the ambient result of
 *  `getGuidanceScale()` - `undefined` or a `value` of `1` both mean "CFG is inactive", handled here.
 * @property {number} thisMaxContext Equivalent of the ambient `this_max_context`.
 * @property {(text: string) => Promise<number>} countTokens Equivalent of `getTokenCountAsync(text)`.
 * @property {ChatMetadataCfgPrompts} [chatMetadataPrompts]
 * @property {CfgSettings} [charaCfg]
 * @property {CfgSettings} [globalCfg]
 * @property {number[]} [promptCombine]
 * @property {string} [promptSeparator]
 * @property {number} [promptInsertionDepth]
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext]
 */

/**
 * @typedef {object} AdjustMaxContextForCfgResult
 * @property {number} thisMaxContext Possibly-decremented max context.
 * @property {CfgPrompt|undefined} negativePrompt Resolved negative CFG prompt, `undefined` when CFG
 *  isn't active. Kept as the full `{value, depth}` object (not just `.value`) so a caller can pass
 *  it straight into src/final-prompt-combination.js's `cfgPrompt` param without a third call.
 * @property {CfgPrompt|undefined} positivePrompt Resolved positive CFG prompt, same shape/rationale.
 */

/**
 * Port of the CFG max-context adjustment slice of public/script.js's Generate()
 * (~lines 5664-5679): resolves both negative and positive CFG prompts, token-counts them, and
 * decrements `thisMaxContext` by `Math.max(negativeCount, positiveCount)` - only when at least one
 * resolved prompt value is non-empty, same as the client's `if (negativePrompt || positivePrompt)` guard.
 *
 * The `useCfgPrompt = cfgGuidanceScale && cfgGuidanceScale.value !== 1` gate is done INSIDE this
 * function (see the module doc comment's judgment-call note) rather than being the caller's job.
 * @param {AdjustMaxContextForCfgParams} params
 * @returns {Promise<AdjustMaxContextForCfgResult>}
 */
export async function adjustMaxContextForCfg({
    cfgGuidanceScale,
    thisMaxContext,
    countTokens,
    chatMetadataPrompts,
    charaCfg,
    globalCfg,
    promptCombine,
    promptSeparator,
    promptInsertionDepth,
    macroContext,
}) {
    const useCfgPrompt = Boolean(cfgGuidanceScale) && cfgGuidanceScale.value !== 1;

    if (!useCfgPrompt) {
        return { thisMaxContext, negativePrompt: undefined, positivePrompt: undefined };
    }

    const cfgPromptParams = { chatMetadataPrompts, charaCfg, globalCfg, promptCombine, promptSeparator, promptInsertionDepth, macroContext };
    const negativePrompt = getCfgPrompt(cfgGuidanceScale, true, cfgPromptParams);
    const positivePrompt = getCfgPrompt(cfgGuidanceScale, false, cfgPromptParams);

    if (negativePrompt.value || positivePrompt.value) {
        const [negativePromptTokenCount, positivePromptTokenCount] = await Promise.all([
            countTokens(negativePrompt.value),
            countTokens(positivePrompt.value),
        ]);
        const decrement = Math.max(negativePromptTokenCount, positivePromptTokenCount);
        thisMaxContext -= decrement;
    }

    return { thisMaxContext, negativePrompt, positivePrompt };
}
