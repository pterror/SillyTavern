/**
 * The sole first_mes-aware module in the codebase.
 *
 * A TavernCard V2 file's greeting content is split across two fields for portability: `first_mes`
 * (the default greeting's text, or '' when there is no default) and `data.alternate_greetings`
 * (every other greeting, in stable order), with the default's position recorded separately in
 * `data.extensions.greeting_default_position` so re-ordering the list doesn't need to move
 * `first_mes`'s content around to keep the default "at the front".
 *
 * Everything above this module deals in a single ordered greeting list plus a nullable default
 * index (see {@link GreetingsModel}) - never `first_mes` or `alternate_greetings` directly. This is
 * the only place in the application that performs the split (writing a card) or the join (reading
 * one). If some other module ever needs to know `first_mes` exists, that's a sign this boundary is
 * in the wrong place, not a reason to duplicate the split here.
 *
 * Mirrors the client's `cardToGreetingsModel()` / `greetingsModelToCardFields()` in
 * `public/script.js` (~12575-12650): same empty-first_mes-means-no-default rule, same
 * out-of-range-recorded-position fallback (default leads the list). Those client functions predate
 * the server owning this split and are expected to become read-only display helpers once callers
 * move to the position-addressed greeting operations this module backs - matched here for semantics,
 * not shared as one implementation, since one is browser-side and one is server-side.
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
        // Empty first_mes means "no default" - alternate_greetings holds the entire list, in order.
        return { greetings: altGreetings.slice(), defaultIndex: null };
    }

    const recordedPosition = card?.data?.extensions?.[GREETING_DEFAULT_POSITION_KEY];
    if (Number.isInteger(recordedPosition) && recordedPosition >= 0 && recordedPosition <= altGreetings.length) {
        const greetings = altGreetings.slice();
        greetings.splice(recordedPosition, 0, firstMes);
        return { greetings, defaultIndex: recordedPosition };
    }

    // No usable recorded position (missing, out of range, or a card written/edited by something that
    // doesn't know about it) - fall back to the pre-existing behavior: the default leads the list.
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
 * Where a tracked index (the default's position) ends up after removing one element at
 * `removedIndex` from the same array. Removing the default itself clears it (returns null) rather
 * than guessing which neighbor should inherit default status.
 * @param {number|null} defaultIndex
 * @param {number} removedIndex
 */
export function reindexDefaultAfterRemoval(defaultIndex, removedIndex) {
    if (defaultIndex === null) return null;
    if (removedIndex === defaultIndex) return null;
    return removedIndex < defaultIndex ? defaultIndex - 1 : defaultIndex;
}

/**
 * Where a tracked index (the default's position) ends up after a pick-and-place move: one element
 * removed from `sourceIndex`, then reinserted at `finalTargetIndex` (already adjusted for the
 * removal, i.e. the exact position passed to the reinserting splice).
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
 * Touches exactly the three fields this module owns (`first_mes`, `data.alternate_greetings`,
 * `data.extensions.greeting_default_position`) and nothing else on the card. Deletes the
 * default-position extension key entirely when there is no default, rather than writing it as null,
 * so a card with no default doesn't carry a stale marker for {@link cardToGreetingsModel}'s
 * out-of-range fallback to trip over later.
 * @param {object} card
 * @param {GreetingsModel} model
 */
export function applyGreetingsModelToCard(card, model) {
    const { firstMes, alternateGreetings, greetingDefaultPosition } = greetingsModelToCardFields(model);
    card.first_mes = firstMes;
    card.data = card.data ?? {};
    card.data.alternate_greetings = alternateGreetings;
    if (greetingDefaultPosition === null) {
        if (card.data.extensions) delete card.data.extensions[GREETING_DEFAULT_POSITION_KEY];
    } else {
        card.data.extensions = card.data.extensions ?? {};
        card.data.extensions[GREETING_DEFAULT_POSITION_KEY] = greetingDefaultPosition;
    }
}
