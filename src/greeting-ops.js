import { getStringHash } from '../public/scripts/hash-utils.js';
import { reindexDefaultAfterMove, reindexDefaultAfterRemoval } from './greeting-list.js';

/**
 * Six named operations against a character's greeting list, addressing positions in the unified list
 * (see {@link import('./greeting-list.js').GreetingsModel}). Ops that target an existing greeting
 * (edit, delete, move's source, set-default) take an `expectedHash` and refuse with
 * `{ ok: false, reason }` if the greeting there doesn't hash-match. Pure: each returns either
 * `{ ok: true, model }` (new model, input never mutated) or `{ ok: false, reason }`.
 */

/**
 * Hashes greeting text the same way the client's `_loadedFieldHashes` hashes any loaded field value.
 * @param {string} text
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
 * Inserts `text` at `position` (0..length, i.e. `length` appends at the end). Refuses empty text.
 * Carries no precondition hash, unlike every other op - it only targets an insertion point, not
 * existing content, so a stale `position` just lands the greeting at the wrong index rather than
 * losing data.
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
 * `targetPosition` is pre-removal: an index into the list as it currently stands (0..length,
 * `length` meaning "move to the end"), matching how the client computes it. The post-removal
 * adjustment happens here, once.
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
