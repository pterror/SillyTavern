import { modifyLastPromptLine } from './prompt-line-formatting.js';
import { substituteParams } from './macro-substitution.js';

/**
 * Server-side port of the TEXT-COMPLETION-ONLY prompt-size backoff slice of public/script.js's
 * Generate(): addChatsPreamble()/addChatsSeparator() (~lines 7150-7162), setPromptString() and its
 * modifyLastPromptLine() wiring (~lines 6088-6101), checkPromptSize() (~lines 6168-6194), and the
 * top-level call-site branch that decides between the two (~lines 6196-6202). The
 * OpenAI/chat-completion path is out of scope, same convention as src/chat-history-budget.js.
 *
 * Like src/chat-history-budget.js and src/story-string-assembly.js, every piece of context the
 * client closures captured from the enclosing Generate() scope is taken as an explicit parameter
 * instead of an ambient global (main_api, nai_settings, power_user.context, etc.). The already-ported
 * modifyLastPromptLine() (src/prompt-line-formatting.js) and substituteParams()
 * (src/macro-substitution.js) are reused as-is, not reimplemented.
 */

/**
 * @typedef {object} AddChatsPreambleParams
 * @property {string} mainApi Equivalent of main_api.
 * @property {string} [naiPreamble] Equivalent of nai_settings.preamble.
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext]
 */

/**
 * Port of public/script.js's addChatsPreamble(mesSendString) (~lines 7150-7154).
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
 * @property {string} [chatStart] Equivalent of power_user.context.chat_start.
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext]
 */

/**
 * Port of public/script.js's addChatsSeparator(mesSendString) (~lines 7156-7162).
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

/**
 * @typedef {{message: string, extensionPrompts: string[]}} MesSendEntry Equivalent of one entry of
 *  the client's `mesSend` array (see src/chat-history-budget.js's buildMesSend()).
 */

/**
 * Applies the client's setPromptString() body (~lines 6090-6101) to local copies: resolves
 * mesExmString and, if mesSend is non-empty, replaces the LAST entry's `.message` with the result
 * of modifyLastPromptLine(). Does not mutate the caller's mesSend array.
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
 * @property {MesSendEntry[]} mesSend Equivalent of the ambient `mesSend` array (see
 *  src/chat-history-budget.js's buildMesSend() output). Not mutated - a local copy is trimmed and
 *  returned instead.
 * @property {string[]} mesExamplesArray
 * @property {number} countExmAdd Equivalent of the ambient, mutable `count_exm_add`. Not mutated -
 *  a local copy is decremented and returned instead.
 * @property {string} [pinExmString] Equivalent of the ambient `pinExmString`; when set, used
 *  verbatim as mesExmString instead of slicing mesExamplesArray.
 * @property {string} combinedStoryString Equivalent of the ambient `combinedStoryString` (see
 *  src/story-string-assembly.js).
 * @property {string} generatedPromptCache Equivalent of the ambient `generatedPromptCache` (see
 *  src/chat-history-budget.js's buildMesSend() output). Its length (and mainApi) decides whether
 *  the checkPromptSize() backoff loop runs at all, per the client's top-level call-site branch.
 * @property {number} thisMaxContext Equivalent of this_max_context.
 * @property {(text: string) => Promise<number>} countTokens Equivalent of
 *  getTokenCountAsync(text, power_user.token_padding) - the padding is already baked into
 *  countTokens/thisMaxContext by the caller, matching src/chat-history-budget.js's convention.
 * @property {string} mainApi Equivalent of main_api.
 * @property {string} [naiPreamble] Equivalent of nai_settings.preamble, forwarded to addChatsPreamble().
 * @property {string} [chatStart] Equivalent of power_user.context.chat_start, forwarded to addChatsSeparator().
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext] Forwarded to
 *  substituteParams() inside addChatsPreamble()/addChatsSeparator().
 * @property {import('./prompt-line-formatting.js').ModifyLastPromptLineParams} modifyLastPromptLineParams
 *  Forwarded, UNCHANGED, to every modifyLastPromptLine() call this function makes - both the
 *  "replace mesSend's last entry" call site and the "candidate size-check string" call site on
 *  `''`, on every recursive/iterative pass, mirroring the client's closure capturing identical
 *  outer variables for both call sites.
 */

/**
 * @typedef {object} ResolvePromptStringsResult
 * @property {MesSendEntry[]} mesSend Final, possibly-trimmed mesSend (oldest entries shifted off the
 *  front by the backoff loop), with modifyLastPromptLine() already applied to its last entry.
 * @property {string} mesExmString Final mesExmString (pinExmString verbatim, or
 *  mesExamplesArray.slice(0, countExmAdd).join('') for the final countExmAdd).
 * @property {number} countExmAdd Final, possibly-decremented countExmAdd.
 */

/**
 * Port of the top-level call-site branch (~lines 6196-6202) plus checkPromptSize() (~lines
 * 6168-6194) plus setPromptString() (~lines 6090-6101): when `generatedPromptCache` is non-empty
 * and `mainApi !== 'openai'`, repeatedly re-runs the client's setPromptString() body, assembles the
 * same candidate prompt string checkPromptSize() builds, and token-counts it; while over budget,
 * first decrements countExmAdd down to 0, then shifts mesSend's oldest entry off the front,
 * re-checking after each single change - exactly like the client's one-decrement/one-shift-per-call
 * recursion. Stops (without erroring) once both countExmAdd is 0 and mesSend is empty, even if still
 * over budget. When generatedPromptCache is empty (or mainApi is 'openai'), this just runs the
 * setPromptString()-equivalent once, with no size check and no trimming.
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

        // Both exhausted - stop trimming, same as the client's terminal `else` branch.
        return { mesSend, mesExmString, countExmAdd };
    }
}
