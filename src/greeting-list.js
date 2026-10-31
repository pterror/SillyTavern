export const GREETING_DEFAULT_POSITION_KEY = 'greeting_default_position';

/** @typedef {{greetings: string[], defaultIndex: number|null}} GreetingsModel */

/**
 * @param {{first_mes?: string, data?: {alternate_greetings?: string[], extensions?: Record<string, any>}}} card
 * @returns {GreetingsModel}
 */
export function cardToGreetingsModel(card) {
    const firstMes = card?.first_mes ?? '';
    const altGreetings = Array.isArray(card?.data?.alternate_greetings) ? card.data.alternate_greetings : [];

    if (firstMes === '') {
        return { greetings: altGreetings.slice(), defaultIndex: null };
    }

    const recordedPosition = card?.data?.extensions?.[GREETING_DEFAULT_POSITION_KEY];
    if (Number.isInteger(recordedPosition) && recordedPosition >= 0 && recordedPosition <= altGreetings.length) {
        const greetings = altGreetings.slice();
        greetings.splice(recordedPosition, 0, firstMes);
        return { greetings, defaultIndex: recordedPosition };
    }

    return { greetings: [firstMes, ...altGreetings], defaultIndex: 0 };
}

/**
 * @param {GreetingsModel} model
 * @returns {{firstMes: string, alternateGreetings: string[], greetingDefaultPosition: number|null}}
 */
export function greetingsModelToCardFields({ greetings, defaultIndex }) {
    if (defaultIndex === null || defaultIndex === undefined) {
        return { firstMes: '', alternateGreetings: greetings.slice(), greetingDefaultPosition: null };
    }
    const clampedIndex = Math.max(0, Math.min(defaultIndex, greetings.length - 1));
    const firstMes = greetings[clampedIndex] ?? '';
    const alternateGreetings = greetings.filter((_, i) => i !== clampedIndex);
    return { firstMes, alternateGreetings, greetingDefaultPosition: clampedIndex };
}

/**
 * @param {number|null} defaultIndex
 * @param {number} removedIndex
 */
export function reindexDefaultAfterRemoval(defaultIndex, removedIndex) {
    if (defaultIndex === null) return null;
    if (removedIndex === defaultIndex) return null;
    return removedIndex < defaultIndex ? defaultIndex - 1 : defaultIndex;
}

/**
 * @param {number|null} defaultIndex
 * @param {number} sourceIndex
 * @param {number} finalTargetIndex
 */
export function reindexDefaultAfterMove(defaultIndex, sourceIndex, finalTargetIndex) {
    if (defaultIndex === null) return null;
    if (defaultIndex === sourceIndex) return finalTargetIndex;
    let result = defaultIndex;
    if (sourceIndex < result) result -= 1;
    if (finalTargetIndex <= result) result += 1;
    return result;
}

/**
 * @param {object} card
 * @param {GreetingsModel} model
 */
export function applyGreetingsModelToCard(card, model) {
    const { firstMes, alternateGreetings, greetingDefaultPosition } = greetingsModelToCardFields(model);
    card.first_mes = firstMes;
    card.data = card.data ?? {};
    card.data.first_mes = firstMes;
    card.data.alternate_greetings = alternateGreetings;
    if (greetingDefaultPosition === null) {
        if (card.data.extensions) delete card.data.extensions[GREETING_DEFAULT_POSITION_KEY];
    } else {
        card.data.extensions = card.data.extensions ?? {};
        card.data.extensions[GREETING_DEFAULT_POSITION_KEY] = greetingDefaultPosition;
    }
}
