import { addChatsPreamble, addChatsSeparator } from './prompt-size-backoff.js';

/**
 * Server-side port of the TEXT-COMPLETION-ONLY final-prompt-combination slice of public/script.js's
 * Generate() -> getCombinedPrompt(isNegative) closure (~lines 6207-6313). Consumes the `mesSend` /
 * `injectedIndices` produced by src/chat-history-budget.js's buildMesSend()/fillContextBudget(), and
 * reuses the already-ported addChatsPreamble()/addChatsSeparator() from src/prompt-size-backoff.js
 * verbatim rather than reimplementing them.
 *
 * The client's `if (main_api === 'openai') return '';` short-circuit (~lines 6214-6217) is NOT
 * ported - this module only implements the text-completion path; a caller handles the OAI case
 * (which has its own prompt manager) separately.
 *
 * Deliberately NOT ported (each needs real infrastructure that doesn't exist yet, not just a
 * context value - listed so a future pass knows exactly what's missing, not guessing):
 * - getCfgPrompt() itself (public/scripts/cfg-scale.js) - a separate, fairly involved feature with
 *   its own chat_metadata/character-override resolution, out of scope for this task. This module
 *   instead takes the ALREADY-RESOLVED `{value, depth}` (or null/undefined when CFG isn't active)
 *   as the `cfgPrompt` param - the caller is responsible for calling getCfgPrompt() (or its future
 *   server-side port) before calling combineFinalPrompt().
 * - The GENERATE_BEFORE_COMBINE_PROMPTS / GENERATE_AFTER_COMBINE_PROMPTS extension event hooks
 *   (~lines 6285-6319 of public/script.js) - these let extensions completely override the combined
 *   prompt or the itemization `data` object passed to GENERATE_BEFORE_COMBINE_PROMPTS. There is no
 *   server-side extension-execution model to run arbitrary extension code against these events yet.
 *   Whether the server needs an equivalent hook mechanism (and what it would look like - a plugin
 *   API? a declarative override config?) is a genuine, real design gap that this task deliberately
 *   does NOT decide as a side effect. combineFinalPrompt() below always returns the "no subscriber
 *   overrode it" result (the equivalent of `combine()`'s return value), same as if
 *   `data.combinedPrompt` had stayed falsy on the client.
 * - The itemization `data` object construction (~lines 6285-6306) - this is bookkeeping for the
 *   unported extension event and the itemization UI, not prompt-combination logic. This module
 *   returns the pieces (`combinedPrompt`, `finalMesSend` with `.injected` already set, `mesSendString`)
 *   a caller could build such a `data` object from later, but does not build the object itself.
 */

/**
 * @typedef {import('./prompt-size-backoff.js').MesSendEntry & {injected?: boolean}} FinalMesSendEntry
 *  Equivalent of one entry of the client's `finalMesSend` array after getCombinedPrompt() has run -
 *  a deep-cloned MesSendEntry, possibly with the CFG/prompt-bias splices applied to `.message` or
 *  `.extensionPrompts`, and always with `.injected` set.
 */

/**
 * @typedef {object} CfgPrompt Equivalent of the client's ALREADY-RESOLVED return value of
 *  getCfgPrompt(cfgGuidanceScale, isNegative) (public/scripts/cfg-scale.js) - NOT ported here, see
 *  the module doc comment. Pass `null`/`undefined` when CFG isn't active (equivalent of the client's
 *  `useCfgPrompt` being falsy).
 * @property {string} value The resolved CFG prompt text to splice in. Falsy (empty string) means "no
 *  splice", same as the client's `if (cfgPrompt.value)` guard.
 * @property {number} depth 0 means "append to the last message"; otherwise the depth used to compute
 *  `cfgDepth` per the client's `mesSend.length - cfgPrompt.depth` logic.
 */

/**
 * @typedef {object} CombineFinalPromptParams
 * @property {import('./prompt-size-backoff.js').MesSendEntry[]} mesSend Equivalent of the ambient
 *  `mesSend` (see src/chat-history-budget.js's buildMesSend() output, as possibly further trimmed by
 *  src/prompt-size-backoff.js's resolvePromptStrings()). NOT mutated - deep-cloned internally via
 *  structuredClone(), same as the client.
 * @property {number[]} injectedIndices Equivalent of the ambient `injectedIndices`, in the same
 *  reverse-index space as the client's (computed against chat2's reverse-index space before the
 *  arrMes->mesSend reversal - see src/chat-history-budget.js's buildMesSend()).
 * @property {CfgPrompt | null} [cfgPrompt] Equivalent of `useCfgPrompt ? getCfgPrompt(...) : undefined`
 *  - see the CfgPrompt typedef and the module doc comment's "deliberately not ported" section.
 * @property {string} promptBias Equivalent of the ambient `promptBias`.
 * @property {boolean} isInstruct
 * @property {boolean} isImpersonate
 * @property {string} combinedStoryString Equivalent of the ambient `combinedStoryString` (see
 *  src/story-string-assembly.js).
 * @property {string} mesExmString Equivalent of the ambient `mesExmString` (see
 *  src/prompt-size-backoff.js's resolvePromptStrings() output).
 * @property {string} generatedPromptCache Equivalent of the ambient `generatedPromptCache` (see
 *  src/chat-history-budget.js's buildMesSend() output).
 * @property {string} [chatStart] Equivalent of power_user.context.chat_start, forwarded to addChatsSeparator().
 * @property {string} mainApi Equivalent of main_api, forwarded to addChatsPreamble().
 * @property {string} [naiPreamble] Equivalent of nai_settings.preamble, forwarded to addChatsPreamble().
 * @property {boolean} [collapseNewlines] Equivalent of power_user.collapse_newlines.
 * @property {import('./macro-substitution.js').SubstituteParamsContext} [macroContext] Forwarded to
 *  addChatsPreamble()/addChatsSeparator().
 */

/**
 * @typedef {object} CombineFinalPromptResult
 * @property {string} combinedPrompt Equivalent of the client's combine()'s return value.
 * @property {FinalMesSendEntry[]} finalMesSend Equivalent of the client's `finalMesSend` after both
 *  splices and the `.injected` annotation.
 * @property {string} mesSendString Equivalent of the ambient `mesSendString` after combine() runs
 *  (the client assigns this to an OUTER-scoped variable as a side effect inside combine() - ported
 *  here as an explicit return field instead).
 */

/**
 * Port of public/script.js's Generate() -> getCombinedPrompt(isNegative) closure body, TEXT-COMPLETION
 * ONLY (~lines 6219-6283, plus combine() at ~6256-6279). See the module doc comment for what is
 * deliberately out of scope (getCfgPrompt() itself, the extension event hooks, the itemization `data`
 * object).
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
    // Deep clone - mirrors the client's `structuredClone(mesSend)`. mesSend itself is never mutated.
    const finalMesSend = structuredClone(mesSend);

    if (cfgPrompt?.value) {
        if (cfgPrompt.depth === 0) {
            const last = finalMesSend[finalMesSend.length - 1];
            last.message += appendWithWhitespaceSniff(last.message, cfgPrompt.value);
        } else {
            // TODO: Make all extension prompts use an array/splice method
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

    // Add prompt bias after everything else
    // Always run with continue
    if (!isInstruct && !isImpersonate) {
        if (promptBias.trim().length !== 0) {
            const last = finalMesSend[finalMesSend.length - 1];
            last.message += appendWithWhitespaceSniff(last.message, promptBias.trimStart());
        }
    }

    // Flattens the multiple prompt objects to a string. Equivalent of the client's combine().
    let mesSendString = finalMesSend.map((e) => `${e.extensionPrompts.join('')}${e.message}`).join('');

    // add a custom dingus (if defined)
    mesSendString = addChatsSeparator(mesSendString, { chatStart, macroContext });

    // add chat preamble
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
 * Port of the exact whitespace-sniffing logic inlined twice in the client (for the CFG splice at
 * depth 0, and for the prompt-bias append) - ~lines 6226-6229 and ~6249-6252 of public/script.js:
 * `/\s/.test(message.slice(-1)) ? value : ` ${value}``. Returns the string to APPEND to `message`
 * (i.e. either `value` as-is, or a space-prefixed copy), not the concatenated result.
 * @param {string} message The message being appended to (its current, pre-append value).
 * @param {string} value The value to append.
 * @returns {string}
 */
function appendWithWhitespaceSniff(message, value) {
    return /\s/.test(message.slice(-1)) ? value : ` ${value}`;
}

/**
 * Port of public/scripts/power-user.js's collapseNewlines(x) (~line 607-609): collapses runs of two
 * or more newlines down to a single newline.
 * @param {string} x
 * @returns {string}
 */
function collapseNewlines(x) {
    return x.replaceAll(/\n+/g, '\n');
}
