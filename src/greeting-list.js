/**
 * Sole first_mes-aware module: converts between a card's split `first_mes`/`data.alternate_greetings`
 * fields and a single ordered greeting list with a nullable default index (see {@link GreetingsModel}).
 * Mirrors the client's `cardToGreetingsModel()`/`greetingsModelToCardFields()` in public/script.js.
 */

export const GREETING_DEFAULT_POSITION_KEY = 'greeting_default_position';

/**
 * @typedef {{greetings: string[], defaultIndex: number|null}} GreetingsModel Ordered greeting list,
 *   independent of which one (if any) is the default; `defaultIndex` is where the default sits in
 *   that order, or null when the card has no default greeting at all.
 */

/**
 * Reads a character card into a {@link GreetingsModel}.
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
 * Inverse of {@link cardToGreetingsModel}.
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
 * Reindexes the default after removing `removedIndex`. Removing the default itself clears it (null)
 * rather than guessing a successor.
 * @param {number|null} defaultIndex
 * @param {number} removedIndex
 */
export function reindexDefaultAfterRemoval(defaultIndex, removedIndex) {
    if (defaultIndex === null) return null;
    if (removedIndex === defaultIndex) return null;
    return removedIndex < defaultIndex ? defaultIndex - 1 : defaultIndex;
}

/**
 * Reindexes the default after a move: one element removed from `sourceIndex`, reinserted at
 * `finalTargetIndex` (already adjusted for the removal).
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
 * Writes a {@link GreetingsModel} onto a card object in place, through {@link greetingsModelToCardFields}.
 * Deletes the default-position extension key entirely when there is no default, rather than writing
 * null, so a stale marker can't trip up {@link cardToGreetingsModel}'s fallback later.
 * @param {object} card
 * @param {GreetingsModel} model
 */
export function applyGreetingsModelToCard(card, model) {
    const { firstMes, alternateGreetings, greetingDefaultPosition } = greetingsModelToCardFields(model);
    card.first_mes = firstMes;
    card.data = card.data ?? {};
    // Write both v1 and v2 copies: reads reconcile by taking v2 and overwriting v1 with it
    // (character-card-normalize.js), so writing only v1 would silently discard the edit.
    card.data.first_mes = firstMes;
    card.data.alternate_greetings = alternateGreetings;
    if (greetingDefaultPosition === null) {
        if (card.data.extensions) delete card.data.extensions[GREETING_DEFAULT_POSITION_KEY];
    } else {
        card.data.extensions = card.data.extensions ?? {};
        card.data.extensions[GREETING_DEFAULT_POSITION_KEY] = greetingDefaultPosition;
    }
}
