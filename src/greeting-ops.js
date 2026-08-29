import { getStringHash } from '../public/scripts/hash-utils.js';
import { reindexDefaultAfterMove, reindexDefaultAfterRemoval } from './greeting-list.js';

/**
 * The six named operations a caller can perform against a character's greeting list, each addressing
 * a position in the ONE unified list (see greeting-list.js's {@link import('./greeting-list.js').GreetingsModel})
 * rather than `first_mes` or `alternate_greetings` directly.
 *
 * Every op that targets an existing greeting (edit, delete, move's source, set-default) takes an
 * `expectedHash` alongside its position and refuses with `{ ok: false, reason }` if the greeting
 * actually at that position doesn't hash-match - the list moved under the caller since it last loaded,
 * and this refuses rather than guessing. add and unset-default don't target existing content, so they
 * carry no hash: add only needs its insertion position to be in range, and unset-default doesn't
 * address a position at all. This is a deliberate scope decision, not an oversight - see the route
 * handlers' notes on why a retried add isn't given extra dedup protection beyond that.
 *
 * Pure: each function takes a model and returns either `{ ok: true, model }` (a new model, the input
 * is never mutated) or `{ ok: false, reason }`. No I/O, no knowledge of cards or files - that split
 * lives entirely in greeting-list.js and whatever route glue calls these.
 */

/**
 * Hashes greeting text the same way the client's `_loadedFieldHashes` hashes any loaded field value:
 * `getStringHash()` of the value's JSON, so this is one hashing convention shared with the rest of
 * the codebase's optimistic-concurrency checks, not a second scheme invented for greetings.
 * @param {string} text
 * @returns {number}
 */
export function hashGreetingText(text) {
    return getStringHash(JSON.stringify(text));
}

function positionInBounds(position, length) {
    return Number.isInteger(position) && position >= 0 && position < length;
}

function hashMatches(model, position, expectedHash) {
    return hashGreetingText(model.greetings[position]) === expectedHash;
}

/**
 * Inserts `text` at `position` (0..length, i.e. `length` appends at the end). Refuses empty text -
 * no operation ever lets an empty string enter the list.
 *
 * Carries no precondition hash, unlike every other op - it doesn't target existing content, only an
 * insertion point, so there's nothing to hash-check against. That does mean `position` itself can be
 * stale if the list moved since the caller last loaded it: the failure mode is the new greeting
 * landing at the wrong index, not any data loss, and it's fixable with a single move afterward - a
 * different class of failure than a mis-targeted edit or delete overwriting/removing the wrong
 * greeting, which is why only this op gets to skip the check.
 * @param {import('./greeting-list.js').GreetingsModel} model
 * @param {number} position
 * @param {string} text
 */
export function opAdd(model, position, text) {
    if (typeof text !== 'string' || text === '') {
        return { ok: false, reason: 'refused to add empty greeting text' };
    }
    if (!Number.isInteger(position) || position < 0 || position > model.greetings.length) {
        return { ok: false, reason: 'position out of range' };
    }
    const greetings = model.greetings.slice();
    greetings.splice(position, 0, text);
    let defaultIndex = model.defaultIndex;
    if (defaultIndex !== null && position <= defaultIndex) defaultIndex += 1;
    return { ok: true, model: { greetings, defaultIndex } };
}

/**
 * Replaces the text at `position`. Refuses empty text and a stale `expectedHash`.
 * @param {import('./greeting-list.js').GreetingsModel} model
 * @param {number} position
 * @param {number} expectedHash
 * @param {string} text
 */
export function opEdit(model, position, expectedHash, text) {
    if (typeof text !== 'string' || text === '') {
        return { ok: false, reason: 'refused to blank stored greeting text' };
    }
    if (!positionInBounds(position, model.greetings.length)) {
        return { ok: false, reason: 'position out of range' };
    }
    if (!hashMatches(model, position, expectedHash)) {
        return { ok: false, reason: 'greeting at position changed since it was loaded' };
    }
    const greetings = model.greetings.slice();
    greetings[position] = text;
    return { ok: true, model: { greetings, defaultIndex: model.defaultIndex } };
}

/**
 * Removes the greeting at `position`. Removing the current default clears default-ness (no
 * successor is guessed at) via {@link reindexDefaultAfterRemoval}.
 * @param {import('./greeting-list.js').GreetingsModel} model
 * @param {number} position
 * @param {number} expectedHash
 */
export function opDelete(model, position, expectedHash) {
    if (!positionInBounds(position, model.greetings.length)) {
        return { ok: false, reason: 'position out of range' };
    }
    if (!hashMatches(model, position, expectedHash)) {
        return { ok: false, reason: 'greeting at position changed since it was loaded' };
    }
    const greetings = model.greetings.slice();
    greetings.splice(position, 1);
    const defaultIndex = reindexDefaultAfterRemoval(model.defaultIndex, position);
    return { ok: true, model: { greetings, defaultIndex } };
}

/**
 * Moves the greeting at `sourcePosition` to `targetPosition`, order otherwise preserved.
 *
 * `targetPosition` is pre-removal: an index into the list exactly as it currently stands (0..length,
 * `length` meaning "move to the end"), the same list `sourcePosition` is read against. This is the
 * boundary's contract deliberately, not an implementation detail leaking through - a caller reads
 * "move greeting 3 to position 7" against the array it's looking at, which is how the client's
 * pick-and-place UI computes it (`insertPosition = isLast ? array.length : nextIndex`) and how its
 * old move helper phrased the adjustment (`adjustedTo = toIdx > fromIdx ? toIdx - 1 : toIdx`) -
 * pushing that adjustment onto every caller instead of doing it once here would just be asking for
 * an off-by-one at the boundary. The internal post-removal index (what actually gets spliced, and
 * what {@link reindexDefaultAfterMove}'s `finalTargetIndex` takes) is computed here, once.
 * @param {import('./greeting-list.js').GreetingsModel} model
 * @param {number} sourcePosition
 * @param {number} expectedHash hash of the greeting at `sourcePosition`
 * @param {number} targetPosition pre-removal insertion index (0..length, inclusive of "move to the end")
 */
export function opMove(model, sourcePosition, expectedHash, targetPosition) {
    if (!positionInBounds(sourcePosition, model.greetings.length)) {
        return { ok: false, reason: 'position out of range' };
    }
    if (!hashMatches(model, sourcePosition, expectedHash)) {
        return { ok: false, reason: 'greeting at position changed since it was loaded' };
    }
    if (!Number.isInteger(targetPosition) || targetPosition < 0 || targetPosition > model.greetings.length) {
        return { ok: false, reason: 'target position out of range' };
    }
    const greetings = model.greetings.slice();
    const [moved] = greetings.splice(sourcePosition, 1);
    // Adjust the caller's pre-removal target down by one once it's past the hole the removal left,
    // same arithmetic the old client-side move helper did - this is the one place that does it.
    const postRemovalTarget = targetPosition > sourcePosition ? targetPosition - 1 : targetPosition;
    greetings.splice(postRemovalTarget, 0, moved);
    const defaultIndex = reindexDefaultAfterMove(model.defaultIndex, sourcePosition, postRemovalTarget);
    return { ok: true, model: { greetings, defaultIndex } };
}

/**
 * Makes the greeting at `position` the default. Never reorders anything.
 * @param {import('./greeting-list.js').GreetingsModel} model
 * @param {number} position
 * @param {number} expectedHash
 */
export function opSetDefault(model, position, expectedHash) {
    if (!positionInBounds(position, model.greetings.length)) {
        return { ok: false, reason: 'position out of range' };
    }
    if (!hashMatches(model, position, expectedHash)) {
        return { ok: false, reason: 'greeting at position changed since it was loaded' };
    }
    return { ok: true, model: { greetings: model.greetings.slice(), defaultIndex: position } };
}

/**
 * Clears the default entirely. The list keeps its order and membership. Doesn't address a position -
 * there is nothing content-specific being asserted - so it carries no precondition hash.
 * @param {import('./greeting-list.js').GreetingsModel} model
 */
export function opUnsetDefault(model) {
    return { ok: true, model: { greetings: model.greetings.slice(), defaultIndex: null } };
}
