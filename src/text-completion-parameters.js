import { getStoppingStrings } from './stopping-strings.js';
import { getCustomTokenBans, calculateLogitBias } from './token-bans-and-bias.js';
import { createTextGenGenerationData } from './textgen-generation-data.js';
import { createKoboldGenerationData } from './kobold-generation-data.js';
import { createNovelGenerationData } from './novel-generation-data.js';

/**
 * @typedef {ReturnType<typeof import('./text-completion-generation-input.js').readTextCompletionConnection>} TextCompletionConnection
 */

/**
 * @typedef {object} TextCompletionPromptFacts
 * @property {string} prompt The prompt the parameters go with.
 * @property {string} type
 * @property {boolean} [isImpersonate]
 * @property {boolean} [isContinue]
 * @property {string} name1
 * @property {string} name2
 * @property {object[]} [chat]
 * @property {boolean} [isGroup]
 * @property {string[]} [groupMemberNames]
 * @property {string[]} [ephemeralStoppingStrings]
 * @property {string[]} [bannedWordsSink] Words the prompt's macros banned.
 * @property {{ guidanceScale?: number|null, negativePrompt?: string }} [cfgValues]
 * @property {number} [thisMaxContext] The prompt's budget, when it differs from the connection's.
 * @property {import('./macro-substitution.js').SubstituteParamsContext} macroContext
 * @property {(text: string) => number[] | null | Promise<number[] | null>} encodeTokens
 * @property {(tokenizerType: number, text: string) => number[] | Promise<number[]>} [encodeTokensByType]
 * @property {number} [novelTokenizerType]
 * @property {import('./kobold-generation-data.js').KoboldGenerationFlags} [koboldFlags]
 * @property {boolean} [isHorde]
 * @property {number} [novelDataTier]
 * @property {number[]} [presetOrder]
 */

/**
 * What a text completion connection is sent with a prompt: its samplers, stopping strings, bans and bias.
 * @param {TextCompletionConnection} connection
 * @param {TextCompletionPromptFacts} facts
 * @returns {Promise<{ generate_data: Record<string, any>, droppedEntries: string[], stoppingStrings: string[], bannedTokens: any, bannedStrings: any, logitBias: object }>}
 */
export async function createTextCompletionParameters(connection, {
    prompt, type, isImpersonate = false, isContinue = false, name1, name2, chat = [], isGroup = false, groupMemberNames = [],
    ephemeralStoppingStrings = [], bannedWordsSink = [], cfgValues = {}, thisMaxContext = connection.thisMaxContext, macroContext,
    encodeTokens, encodeTokensByType, novelTokenizerType, koboldFlags = {}, isHorde = false, novelDataTier, presetOrder,
}) {
    const { mainApi, settings, model, amountGen, maxContext, requestTokenProbabilities, consoleLogPrompts, apiServer } = connection;
    const stoppingStringsParams = {
        namesAsStopStrings: connection.namesAsStopStrings, name1, name2, chat, isGroup, groupMemberNames,
        singleLine: connection.singleLine, instructPreset: connection.instructPreset, contextSettings: connection.contextSettings,
        customStoppingStringsRaw: connection.customStoppingStringsRaw, customStoppingStringsMacro: connection.customStoppingStringsMacro,
        ephemeralStoppingStrings, macroContext,
    };
    const stoppingStrings = getStoppingStrings({ ...stoppingStringsParams, isImpersonate, isContinue, api: mainApi });
    const isTextgen = mainApi !== 'kobold' && mainApi !== 'novel';

    /** @type {string[]} */
    const droppedEntries = [];
    const { banned_tokens: bannedTokens, banned_strings: bannedStrings } = await getCustomTokenBans({
        bannedTokensRaw: connection.bannedTokensRaw, globalBannedTokensRaw: connection.globalBannedTokensRaw, sendBannedTokens: connection.sendBannedTokens,
        bannedWordsFromMacros: bannedWordsSink, encode: isTextgen ? encodeTokens : () => null, macroContext,
        dropped: isTextgen ? droppedEntries : undefined,
    });
    const logitBias = isTextgen ? await calculateLogitBias({ logitBiasEntries: connection.logitBiasEntries, encode: encodeTokens, dropped: droppedEntries }) : {};

    let generate_data;
    if (mainApi === 'kobold') {
        generate_data = createKoboldGenerationData({
            finalPrompt: prompt, settings, maxLength: amountGen, maxContextLength: maxContext ?? thisMaxContext,
            isHorde, type, koboldSettings: settings, koboldFlags, apiServer, stoppingStringsParams, macroContext,
        });
    } else if (mainApi === 'novel') {
        generate_data = await createNovelGenerationData({
            finalPrompt: prompt, settings, maxLength: amountGen, isImpersonate, isContinue, type, novelDataTier, presetOrder,
            consoleLogPrompts, requestTokenProbabilities, stoppingStringsParams, tokenizerType: novelTokenizerType,
            encodeTokens: encodeTokensByType, dropped: droppedEntries, macroContext,
        });
    } else {
        generate_data = await createTextGenGenerationData(settings, model, prompt, amountGen, isImpersonate, isContinue, cfgValues, type, {
            stoppingStrings, bannedTokens, bannedStrings, logitBias, maxContext: thisMaxContext, requestTokenProbabilities, macroContext,
        });
    }
    return { generate_data, droppedEntries, stoppingStrings, bannedTokens, bannedStrings, logitBias };
}
