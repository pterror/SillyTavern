import { getStringHash } from '../public/scripts/hash-utils.js';
import { reindexDefaultAfterMove, reindexDefaultAfterRemoval } from './greeting-list.js';

/**
 * Six named operations against a character's greeting list, addressing positions in the unified list
 * (see {@link import('./greeting-list.js').GreetingsModel}). Every op takes a precondition and refuses
 * with `{ ok: false, reason }` when it doesn't match: ops that target an existing greeting (edit,
 * delete, move's source and its anchor, set-default) take an `expectedHash` of the greeting there,
 * add takes the `expectedLength` of the list, unset-default the `expectedDefaultPosition`. Pure: each
 * returns either `{ ok: true, model }` (new model, input never mutated) or `{ ok: false, reason }`.
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
 * It targets an insertion point, not existing content, so its precondition is the list's length
 * rather than a hash.
 * @param {import('./greeting-list.js').GreetingsModel} model
 * @param {number} position
 * @param {number} expectedLength
 * @param {string} text
 */
export function opAdd(model, position, expectedLength, text) {
    if (typeof text !== 'string' || text === '') {
        return { ok: false, reason: 'refused to add empty greeting text' };
    }
    if (model.greetings.length !== expectedLength) {
        return { ok: false, reason: 'greeting list length changed since it was loaded' };
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
 * Replaces the text of the greeting whose hash is `expectedHash`. That is the greeting at `position` when its
 * hash matches; otherwise (the position is out of range, or holds something else) the greeting is looked up by
 * `expectedHash` alone, so an edit still lands on its greeting after other greetings were added, removed or
 * moved. Refuses empty text, and refuses when no greeting or more than one greeting has that hash.
 * `position` in the result is where the edit landed.
 * @param {import('./greeting-list.js').GreetingsModel} model
 * @param {number} position
 * @param {number} expectedHash
 * @param {string} text
 * @returns {{ok: true, model: import('./greeting-list.js').GreetingsModel, position: number}|{ok: false, reason: string}}
 */
export function opEdit(model, position, expectedHash, text) {
    if (typeof text !== 'string' || text === '') {
        return { ok: false, reason: 'refused to blank stored greeting text' };
    }
    let target = position;
    if (!positionInBounds(position, model.greetings.length) || !hashMatches(model, position, expectedHash)) {
        const matches = [];
        for (let i = 0; i < model.greetings.length && matches.length < 2; i++) {
            if (hashMatches(model, i, expectedHash)) matches.push(i);
        }
        if (matches.length !== 1) {
            return {
                ok: false,
                reason: !positionInBounds(position, model.greetings.length)
                    ? 'position out of range'
                    : 'greeting at position changed since it was loaded',
            };
        }
        target = matches[0];
    }
    const greetings = model.greetings.slice();
    greetings[target] = text;
    return { ok: true, model: { greetings, defaultIndex: model.defaultIndex }, position: target };
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
 * Moves the greeting at `sourcePosition` immediately before or after the anchor greeting at
 * `targetPosition`, order otherwise preserved. Both positions are read against the list as it
 * currently stands. "Move to the end" is `side: 'after'` with the last greeting as the anchor.
 * @param {import('./greeting-list.js').GreetingsModel} model
 * @param {number} sourcePosition
 * @param {number} expectedHash hash of the greeting at `sourcePosition`
 * @param {'before'|'after'} side which side of the anchor the moved greeting lands on
 * @param {number} targetPosition position of the anchor greeting (an existing greeting, not an insertion index)
 * @param {number} targetExpectedHash hash of the greeting at `targetPosition`
 */
export function opMove(model, sourcePosition, expectedHash, side, targetPosition, targetExpectedHash) {
    if (!positionInBounds(sourcePosition, model.greetings.length)) {
        return { ok: false, reason: 'position out of range' };
    }
    if (!hashMatches(model, sourcePosition, expectedHash)) {
        return { ok: false, reason: 'greeting at position changed since it was loaded' };
    }
    if (!positionInBounds(targetPosition, model.greetings.length)) {
        return { ok: false, reason: 'target position out of range' };
    }
    if (!hashMatches(model, targetPosition, targetExpectedHash)) {
        return { ok: false, reason: 'target greeting changed since it was loaded' };
    }
    if (targetPosition === sourcePosition) {
        return { ok: false, reason: 'cannot move a greeting next to itself' };
    }
    if (side !== 'before' && side !== 'after') {
        return { ok: false, reason: 'side must be before or after' };
    }
    const greetings = model.greetings.slice();
    const [moved] = greetings.splice(sourcePosition, 1);
    const anchorIndex = targetPosition > sourcePosition ? targetPosition - 1 : targetPosition;
    const insertIndex = side === 'before' ? anchorIndex : anchorIndex + 1;
    greetings.splice(insertIndex, 0, moved);
    const defaultIndex = reindexDefaultAfterMove(model.defaultIndex, sourcePosition, insertIndex);
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
 * Clears the default entirely. The list keeps its order and membership.
 * @param {import('./greeting-list.js').GreetingsModel} model
 * @param {number|null} expectedDefaultPosition `null` asserts there is no default
 */
export function opUnsetDefault(model, expectedDefaultPosition) {
    if (model.defaultIndex !== expectedDefaultPosition) {
        return { ok: false, reason: 'default greeting changed since it was loaded' };
    }
    return { ok: true, model: { greetings: model.greetings.slice(), defaultIndex: null } };
}
