import { addChatsPreamble, addChatsSeparator } from './prompt-size-backoff.js';

/** @typedef {import('./prompt-size-backoff.js').MesSendEntry & {injected?: boolean}} FinalMesSendEntry */

/**
 * @typedef {object} CfgPrompt
 * @property {string} value
 * @property {number} depth
 */

/**
 * @typedef {object} CombineFinalPromptParams
 * @property {import('./prompt-size-backoff.js').MesSendEntry[]} mesSend
 * @property {number[]} injectedIndices
 * @property {CfgPrompt | null} [cfgPrompt]
 * @property {string} promptBias
 * @property {boolean} isInstruct
 * @property {boolean} isImpersonate
 * @property {string} combinedStoryString
 * @property {string} mesExmString
 * @property {string} generatedPromptCache
 * @property {string} [chatStart]
 * @property {string} mainApi
 * @property {string} [naiPreamble]
 * @property {boolean} [collapseNewlines]
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext]
 */

/**
 * @typedef {object} CombineFinalPromptResult
 * @property {string} combinedPrompt
 * @property {FinalMesSendEntry[]} finalMesSend
 * @property {string} mesSendString
 */

/**
 * @param {CombineFinalPromptParams} params
 * @returns {CombineFinalPromptResult}
 */
export function combineFinalPrompt({
    mesSend,
    injectedIndices,
    cfgPrompt,
    promptBias,
    isInstruct,
    isImpersonate,
    combinedStoryString,
    mesExmString,
    generatedPromptCache,
    chatStart,
    mainApi,
    naiPreamble,
    collapseNewlines: shouldCollapseNewlines = false,
    macroContext = {},
}) {
    const finalMesSend = structuredClone(mesSend);

    if (cfgPrompt?.value) {
        if (cfgPrompt.depth === 0) {
            const last = finalMesSend[finalMesSend.length - 1];
            last.message += appendWithWhitespaceSniff(last.message, cfgPrompt.value);
        } else {
            const lengthDiff = mesSend.length - cfgPrompt.depth;
            const cfgDepth = lengthDiff >= 0 ? lengthDiff : 0;
            const cfgMessage = finalMesSend[cfgDepth];
            if (cfgMessage) {
                if (!Array.isArray(finalMesSend[cfgDepth].extensionPrompts)) {
                    finalMesSend[cfgDepth].extensionPrompts = [];
                }
                finalMesSend[cfgDepth].extensionPrompts.push(`${cfgPrompt.value}\n`);
            }
        }
    }

    if (!isInstruct && !isImpersonate) {
        if (promptBias.trim().length !== 0) {
            const last = finalMesSend[finalMesSend.length - 1];
            last.message += appendWithWhitespaceSniff(last.message, promptBias.trimStart());
        }
    }

    let mesSendString = finalMesSend.map((e) => `${e.extensionPrompts.join('')}${e.message}`).join('');

    mesSendString = addChatsSeparator(mesSendString, { chatStart, macroContext });

    mesSendString = addChatsPreamble(mesSendString, { mainApi, naiPreamble, macroContext });

    let combinedPrompt = [
        combinedStoryString,
        mesExmString,
        mesSendString,
        generatedPromptCache,
    ].join('').replace(/\r/gm, '');

    if (shouldCollapseNewlines) {
        combinedPrompt = collapseNewlines(combinedPrompt);
    }

    finalMesSend.forEach((item, i) => {
        item.injected = injectedIndices.includes(finalMesSend.length - i - 1);
    });

    return { combinedPrompt, finalMesSend, mesSendString };
}

/**
 * @param {string} message
 * @param {string} value
 * @returns {string}
 */
function appendWithWhitespaceSniff(message, value) {
    return /\s/.test(message.slice(-1)) ? value : ` ${value}`;
}

/**
 * @param {string} x
 * @returns {string}
 */
function collapseNewlines(x) {
    return x.replaceAll(/\n+/g, '\n');
}
