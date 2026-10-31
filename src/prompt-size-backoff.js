import { modifyLastPromptLine } from './prompt-line-formatting.js';
import { substituteParams } from './macro-substitution.js';

/**
 * @typedef {object} AddChatsPreambleParams
 * @property {string} mainApi
 * @property {string} [naiPreamble]
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext]
 */

/**
 * @param {string} mesSendString
 * @param {AddChatsPreambleParams} params
 * @returns {string}
 */
export function addChatsPreamble(mesSendString, { mainApi, naiPreamble, macroContext = {} } = {}) {
    return mainApi === 'novel'
        ? substituteParams(naiPreamble, macroContext) + '\n' + mesSendString
        : mesSendString;
}

/**
 * @typedef {object} AddChatsSeparatorParams
 * @property {string} [chatStart]
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext]
 */

/**
 * @param {string} mesSendString
 * @param {AddChatsSeparatorParams} params
 * @returns {string}
 */
export function addChatsSeparator(mesSendString, { chatStart, macroContext = {} } = {}) {
    if (chatStart) {
        return substituteParams(chatStart + '\n', macroContext) + mesSendString;
    }
    return mesSendString;
}

/** @typedef {{message: string, extensionPrompts: string[]}} MesSendEntry */

/**
 * @param {object} params
 * @param {MesSendEntry[]} params.mesSend
 * @param {string[]} params.mesExamplesArray
 * @param {number} params.countExmAdd
 * @param {string} [params.pinExmString]
 * @param {import('./prompt-line-formatting.js').ModifyLastPromptLineParams} params.modifyLastPromptLineParams
 * @returns {{mesSend: MesSendEntry[], mesExmString: string}}
 */
function applySetPromptString({ mesSend, mesExamplesArray, countExmAdd, pinExmString, modifyLastPromptLineParams }) {
    mesSend = mesSend.slice();
    const mesExmString = pinExmString ?? mesExamplesArray.slice(0, countExmAdd).join('');

    if (mesSend.length) {
        const last = mesSend[mesSend.length - 1];
        mesSend[mesSend.length - 1] = {
            ...last,
            message: modifyLastPromptLine(last.message, modifyLastPromptLineParams),
        };
    }

    return { mesSend, mesExmString };
}

/**
 * @typedef {object} ResolvePromptStringsParams
 * @property {MesSendEntry[]} mesSend
 * @property {string[]} mesExamplesArray
 * @property {number} countExmAdd
 * @property {string} [pinExmString]
 * @property {string} combinedStoryString
 * @property {string} generatedPromptCache
 * @property {number} thisMaxContext
 * @property {(text: string) => Promise<number>} countTokens
 * @property {string} mainApi
 * @property {string} [naiPreamble]
 * @property {string} [chatStart]
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext]
 * @property {import('./prompt-line-formatting.js').ModifyLastPromptLineParams} modifyLastPromptLineParams
 */

/**
 * @typedef {object} ResolvePromptStringsResult
 * @property {MesSendEntry[]} mesSend
 * @property {string} mesExmString
 * @property {number} countExmAdd
 */

/**
 * @param {ResolvePromptStringsParams} params
 * @returns {Promise<ResolvePromptStringsResult>}
 */
export async function resolvePromptStrings({
    mesSend,
    mesExamplesArray,
    countExmAdd,
    pinExmString,
    combinedStoryString,
    generatedPromptCache,
    thisMaxContext,
    countTokens,
    mainApi,
    naiPreamble,
    chatStart,
    macroContext = {},
    modifyLastPromptLineParams,
}) {
    mesSend = mesSend.slice();

    if (!(generatedPromptCache.length > 0 && mainApi !== 'openai')) {
        const { mesSend: resolvedMesSend, mesExmString } = applySetPromptString({
            mesSend, mesExamplesArray, countExmAdd, pinExmString, modifyLastPromptLineParams,
        });
        return { mesSend: resolvedMesSend, mesExmString, countExmAdd };
    }

    for (;;) {
        const { mesSend: steppedMesSend, mesExmString } = applySetPromptString({
            mesSend, mesExamplesArray, countExmAdd, pinExmString, modifyLastPromptLineParams,
        });
        mesSend = steppedMesSend;

        const jointMessages = mesSend.map(e => `${e.extensionPrompts.join('')}${e.message}`).join('');
        const prompt = [
            combinedStoryString,
            mesExmString,
            addChatsPreamble(addChatsSeparator(jointMessages, { chatStart, macroContext }), { mainApi, naiPreamble, macroContext }),
            '\n',
            modifyLastPromptLine('', modifyLastPromptLineParams),
            generatedPromptCache,
        ].join('').replace(/\r/gm, '');

        const thisPromptContextSize = await countTokens(prompt);

        if (!(thisPromptContextSize > thisMaxContext)) {
            return { mesSend, mesExmString, countExmAdd };
        }

        if (countExmAdd > 0) {
            countExmAdd--;
            continue;
        }

        if (mesSend.length > 0) {
            mesSend = mesSend.slice(1);
            continue;
        }

        return { mesSend, mesExmString, countExmAdd };
    }
}
