import { substituteParams } from './macro-substitution.js';

/**
 * Server-side port of public/scripts/reasoning.js's PromptReasoning class - folds a message's
 * separately-stored <think>-style reasoning text back into its visible content before it goes
 * into the prompt.
 *
 * Ported as a small set of pure functions operating on an explicit state object, rather than a
 * class, to match the "no ambient globals, explicit state" convention already used elsewhere this
 * session (e.g. src/world-info/timed-effects.js's chatMetadata-as-explicit-param style, though that
 * module mutates its object in place - here the caller instead gets a new state object back from
 * each call, since PromptReasoning's state - counter/prefix tracking - is small enough that
 * immutable-update reads more naturally than threading a mutable object through a class). This
 * also sidesteps `power_user.reasoning.*` and `substituteParams`'s macro context ever being read
 * from a module-level global: every config value the client read off `power_user.reasoning` is an
 * explicit parameter here (`addToPrompts`, `maxAdditions`, `reasoningPrefix`, `reasoningSeparator`,
 * `reasoningSuffix`), and the macro context is threaded through as `macroContext`.
 *
 * Deliberately NOT ported: the client class's `static #LATEST` / `getLatestPrefix()` /
 * `clearLatest()`. Those track a single cross-instance "currently streaming" reasoning prefix so a
 * live-updating UI element can show the in-progress reasoning text while it streams in from the
 * backend. That's a client-side streaming-UI concern with no server-side prompt-assembly
 * equivalent - a server building one static prompt has no "latest instance across the whole page"
 * to track.
 */

/** Zero-width space used as a legacy placeholder for "no reasoning". Mirrors PromptReasoning.REASONING_PLACEHOLDER. */
export const REASONING_PLACEHOLDER = '​';

/**
 * @typedef {object} ReasoningFoldState
 * @property {number} counter Number of successful reasoning additions so far
 * @property {number} prefixLength Length of the most recently formatted prefix reasoning block, or -1 if none set yet
 * @property {string} prefixReasoning Raw reasoning text of the most recent prefix addition
 * @property {string} prefixReasoningFormatted Formatted (prefix+reasoning[+suffix+separator]) text of the most recent prefix addition
 * @property {number|null} prefixDuration Duration passed in for the most recent prefix addition
 * @property {boolean} prefixIncomplete Whether the most recent prefix addition was the "reasoning only, no content yet" form
 */

/**
 * @returns {ReasoningFoldState} A fresh initial state, equivalent to `new PromptReasoning()`'s constructor state.
 */
export function createReasoningFoldState() {
    return {
        counter: 0,
        prefixLength: -1,
        prefixReasoning: '',
        prefixReasoningFormatted: '',
        prefixDuration: null,
        prefixIncomplete: false,
    };
}

/**
 * Mirrors PromptReasoning#isLimitReached().
 * @param {ReasoningFoldState} state
 * @param {object} config
 * @param {boolean} config.addToPrompts Mirrors power_user.reasoning.add_to_prompts
 * @param {number} config.maxAdditions Mirrors power_user.reasoning.max_additions
 * @returns {boolean}
 */
export function isReasoningLimitReached(state, { addToPrompts, maxAdditions }) {
    if (!addToPrompts) {
        return true;
    }
    return state.counter >= maxAdditions;
}

/**
 * Mirrors PromptReasoning#addToMessage(). Does not mutate `state` - returns a new state object
 * alongside the folded content.
 * @param {ReasoningFoldState} state
 * @param {string} content Message content
 * @param {string} reasoning Message reasoning
 * @param {boolean} isPrefix Whether this is the last message prefix
 * @param {number|null} duration Duration of the reasoning
 * @param {object} config
 * @param {boolean} config.addToPrompts Mirrors power_user.reasoning.add_to_prompts
 * @param {number} config.maxAdditions Mirrors power_user.reasoning.max_additions
 * @param {string} [config.reasoningPrefix] Mirrors power_user.reasoning.prefix (pre-substitution)
 * @param {string} [config.reasoningSeparator] Mirrors power_user.reasoning.separator (pre-substitution)
 * @param {string} [config.reasoningSuffix] Mirrors power_user.reasoning.suffix (pre-substitution)
 * @param {import('./macro-substitution.js').SubstituteParamsContext} [config.macroContext] Context forwarded to substituteParams
 * @returns {{ content: string, state: ReasoningFoldState }}
 */
export function foldReasoningIntoMessage(state, content, reasoning, isPrefix, duration, {
    addToPrompts,
    maxAdditions,
    reasoningPrefix = '',
    reasoningSeparator = '',
    reasoningSuffix = '',
    macroContext = {},
} = {}) {
    // Disabled or reached limit of additions
    // NOTE: subtly different from isReasoningLimitReached() - gated on !isPrefix, so a prefix
    // message can still get reasoning added even past the limit. Port this exact inlined check.
    if (!isPrefix && (!addToPrompts || state.counter >= maxAdditions)) {
        return { content, state };
    }

    // No reasoning provided or a legacy placeholder
    if (!reasoning || reasoning === REASONING_PLACEHOLDER) {
        return { content, state };
    }

    const nextState = { ...state, counter: state.counter + 1 };

    const prefix = substituteParams(reasoningPrefix || '', macroContext);
    const separator = substituteParams(reasoningSeparator || '', macroContext);
    const suffix = substituteParams(reasoningSuffix || '', macroContext);

    // Combine parts with reasoning only
    if (isPrefix && !content) {
        const formattedReasoning = `${prefix}${reasoning}`;
        nextState.prefixReasoning = reasoning;
        nextState.prefixReasoningFormatted = formattedReasoning;
        nextState.prefixLength = formattedReasoning.length;
        nextState.prefixDuration = duration;
        nextState.prefixIncomplete = true;
        return { content: formattedReasoning, state: nextState };
    }

    // Combine parts with reasoning and content
    const formattedReasoning = `${prefix}${reasoning}${suffix}${separator}`;
    if (isPrefix) {
        nextState.prefixReasoning = reasoning;
        nextState.prefixReasoningFormatted = formattedReasoning;
        nextState.prefixLength = formattedReasoning.length;
        nextState.prefixDuration = duration;
        nextState.prefixIncomplete = false;
    }
    return { content: `${formattedReasoning}${content}`, state: nextState };
}

/**
 * Mirrors PromptReasoning#removePrefix().
 * @param {ReasoningFoldState} state
 * @param {string} content Content with the reasoning prefix
 * @returns {string} Content without the reasoning prefix
 */
export function removeReasoningPrefix(state, content) {
    if (state.prefixLength > 0) {
        return content.slice(state.prefixLength);
    }
    return content;
}
