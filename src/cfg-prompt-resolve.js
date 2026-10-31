import { substituteParams } from './macro-substitution.js';

/**
 * @typedef {object} GuidanceScale
 * @property {number} type
 * @property {number} value
 */

/**
 * @typedef {object} CfgSettings
 * @property {number} [guidance_scale]
 * @property {string} [negative_prompt]
 * @property {string} [positive_prompt]
 */

/**
 * @typedef {object} GetGuidanceScaleParams
 * @property {number} [chatGuidanceScale]
 * @property {boolean} [groupchatIndividualChars]
 * @property {boolean} [isGroup]
 * @property {CfgSettings} [charaCfg]
 * @property {CfgSettings} [globalCfg]
 */

/**
 * @param {GetGuidanceScaleParams} [params]
 * @returns {GuidanceScale|undefined}
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
 * @property {string} [negativePrompt]
 * @property {string} [positivePrompt]
 */

/**
 * @typedef {object} GetCfgPromptParams
 * @property {ChatMetadataCfgPrompts} [chatMetadataPrompts]
 * @property {CfgSettings} [charaCfg]
 * @property {CfgSettings} [globalCfg]
 * @property {number[]} [promptCombine]
 * @property {string} [promptSeparator]
 * @property {number} [promptInsertionDepth]
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext]
 */

/**
 * @typedef {object} CfgPrompt
 * @property {string} value
 * @property {number} depth
 */

/**
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
 * @property {GuidanceScale|undefined} cfgGuidanceScale
 * @property {number} thisMaxContext
 * @property {(text: string) => Promise<number>} countTokens
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
 * @property {number} thisMaxContext
 * @property {CfgPrompt|undefined} negativePrompt
 * @property {CfgPrompt|undefined} positivePrompt
 */

/**
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
