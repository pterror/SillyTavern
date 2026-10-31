import { substituteParams } from './macro-substitution.js';

export const REASONING_PLACEHOLDER = '​';

/**
 * @typedef {object} ReasoningFoldState
 * @property {number} counter
 * @property {number} prefixLength
 * @property {string} prefixReasoning
 * @property {string} prefixReasoningFormatted
 * @property {number|null} prefixDuration
 * @property {boolean} prefixIncomplete
 */

/**
 * @returns {ReasoningFoldState}
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
 * @param {ReasoningFoldState} state
 * @param {object} config
 * @param {boolean} config.addToPrompts
 * @param {number} config.maxAdditions
 * @returns {boolean}
 */
export function isReasoningLimitReached(state, { addToPrompts, maxAdditions }) {
    if (!addToPrompts) {
        return true;
    }
    return state.counter >= maxAdditions;
}

/**
 * @param {ReasoningFoldState} state
 * @param {string} content
 * @param {string} reasoning
 * @param {boolean} isPrefix
 * @param {number|null} duration
 * @param {object} config
 * @param {boolean} config.addToPrompts
 * @param {number} config.maxAdditions
 * @param {string} [config.reasoningPrefix]
 * @param {string} [config.reasoningSeparator]
 * @param {string} [config.reasoningSuffix]
 * @param {import('./macro-substitution.js').SubstituteParamsContext} [config.macroContext]
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
    if (!isPrefix && (!addToPrompts || state.counter >= maxAdditions)) {
        return { content, state };
    }

    if (!reasoning || reasoning === REASONING_PLACEHOLDER) {
        return { content, state };
    }

    const nextState = { ...state, counter: state.counter + 1 };

    const prefix = substituteParams(reasoningPrefix || '', macroContext);
    const separator = substituteParams(reasoningSeparator || '', macroContext);
    const suffix = substituteParams(reasoningSuffix || '', macroContext);

    if (isPrefix && !content) {
        const formattedReasoning = `${prefix}${reasoning}`;
        nextState.prefixReasoning = reasoning;
        nextState.prefixReasoningFormatted = formattedReasoning;
        nextState.prefixLength = formattedReasoning.length;
        nextState.prefixDuration = duration;
        nextState.prefixIncomplete = true;
        return { content: formattedReasoning, state: nextState };
    }

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
 * @param {ReasoningFoldState} state
 * @param {string} content
 * @returns {string}
 */
export function removeReasoningPrefix(state, content) {
    if (state.prefixLength > 0) {
        return content.slice(state.prefixLength);
    }
    return content;
}
