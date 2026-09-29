import { getStringHash } from '../public/scripts/hash-utils.js';
import { reindexDefaultAfterMove, reindexDefaultAfterRemoval } from './greeting-list.js';

/**
 * Six named operations against a character's greeting list, addressing positions in the unified list
 * (see {@link import('./greeting-list.js').GreetingsModel}). Every op takes a precondition and refuses
 * with `{ ok: false, reason }` when it doesn't match (append, which can't overwrite anything, takes none): ops that target an existing greeting (edit,
 * delete, move's source and its anchor, set-default) take an `expectedHash` of that greeting, found at
 * the position given or, if it moved, by the hash alone (see {@link findGreeting}); add takes the `expectedLength` of the list, unset-default the `expectedDefaultPosition` or the hash of the default greeting. Pure: each
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
 * Finds the greeting whose hash is `expectedHash`: the one at `position` when its hash matches; otherwise (the
 * position is out of range, or holds something else) the one greeting anywhere in the list that has it. Refuses when
 * no greeting or more than one greeting has it, with `outOfRange` when `position` is out of range, else `changed`.
 * @param {import('./greeting-list.js').GreetingsModel} model
 * @param {number} position
 * @param {number} expectedHash
 * @param {{outOfRange: string, changed: string}} reasons
 * @returns {{ok: true, position: number}|{ok: false, reason: string}}
 */
function findGreeting(model, position, expectedHash, reasons) {
    const inBounds = positionInBounds(position, model.greetings.length);
    if (inBounds && hashMatches(model, position, expectedHash)) {
        return { ok: true, position };
    }
    const matches = [];
    for (let i = 0; i < model.greetings.length && matches.length < 2; i++) {
        if (hashMatches(model, i, expectedHash)) matches.push(i);
    }
    if (matches.length !== 1) {
        return { ok: false, reason: inBounds ? reasons.changed : reasons.outOfRange };
    }
    return { ok: true, position: matches[0] };
}

const GREETING_REASONS = { outOfRange: 'position out of range', changed: 'greeting at position changed since it was loaded' };
const TARGET_REASONS = { outOfRange: 'target position out of range', changed: 'target greeting changed since it was loaded' };

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
 * Inserts `text` after the last greeting, whatever the list's length. Refuses empty text. It can't overwrite
 * anything, so it takes no precondition. `position` in the result is where it landed.
 * @param {import('./greeting-list.js').GreetingsModel} model
 * @param {string} text
 * @returns {{ok: true, model: import('./greeting-list.js').GreetingsModel, position: number}|{ok: false, reason: string}}
 */
export function opAppend(model, text) {
    const length = model.greetings.length;
    const result = opAdd(model, length, length, text);
    return result.ok ? { ...result, position: length } : result;
}

/**
 * Replaces the text of the greeting whose hash is `expectedHash`, found by {@link findGreeting}, so an edit still
 * lands on its greeting after other greetings were added, removed or moved. Refuses empty text.
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
    const found = findGreeting(model, position, expectedHash, GREETING_REASONS);
    if (!found.ok) return found;
    const greetings = model.greetings.slice();
    greetings[found.position] = text;
    return { ok: true, model: { greetings, defaultIndex: model.defaultIndex }, position: found.position };
}

/**
 * Removes the greeting whose hash is `expectedHash`, found by {@link findGreeting}. Removing the current default
 * clears default-ness (no successor is guessed at) via {@link reindexDefaultAfterRemoval}.
 * `position` in the result is where the removed greeting was.
 * @param {import('./greeting-list.js').GreetingsModel} model
 * @param {number} position
 * @param {number} expectedHash
 * @returns {{ok: true, model: import('./greeting-list.js').GreetingsModel, position: number}|{ok: false, reason: string}}
 */
export function opDelete(model, position, expectedHash) {
    const found = findGreeting(model, position, expectedHash, GREETING_REASONS);
    if (!found.ok) return found;
    const greetings = model.greetings.slice();
    greetings.splice(found.position, 1);
    const defaultIndex = reindexDefaultAfterRemoval(model.defaultIndex, found.position);
    return { ok: true, model: { greetings, defaultIndex }, position: found.position };
}

/**
 * Moves the greeting whose hash is `expectedHash` immediately before or after the anchor greeting whose hash is
 * `targetExpectedHash`, order otherwise preserved. Each is found by {@link findGreeting}, starting from
 * `sourcePosition` and `targetPosition` read against the list as it currently stands. "Move to the end" is
 * `side: 'after'` with the last greeting as the anchor. `sourcePosition` and `targetPosition` in the result are
 * where the moved greeting and the anchor were found.
 * @param {import('./greeting-list.js').GreetingsModel} model
 * @param {number} sourcePosition
 * @param {number} expectedHash hash of the greeting to move
 * @param {'before'|'after'} side which side of the anchor the moved greeting lands on
 * @param {number} targetPosition position of the anchor greeting (an existing greeting, not an insertion index)
 * @param {number} targetExpectedHash hash of the anchor greeting
 * @returns {{ok: true, model: import('./greeting-list.js').GreetingsModel, sourcePosition: number, targetPosition: number}|{ok: false, reason: string}}
 */
export function opMove(model, sourcePosition, expectedHash, side, targetPosition, targetExpectedHash) {
    const source = findGreeting(model, sourcePosition, expectedHash, GREETING_REASONS);
    if (!source.ok) return source;
    const target = findGreeting(model, targetPosition, targetExpectedHash, TARGET_REASONS);
    if (!target.ok) return target;
    if (target.position === source.position) {
        return { ok: false, reason: 'cannot move a greeting next to itself' };
    }
    if (side !== 'before' && side !== 'after') {
        return { ok: false, reason: 'side must be before or after' };
    }
    const greetings = model.greetings.slice();
    const [moved] = greetings.splice(source.position, 1);
    const anchorIndex = target.position > source.position ? target.position - 1 : target.position;
    const insertIndex = side === 'before' ? anchorIndex : anchorIndex + 1;
    greetings.splice(insertIndex, 0, moved);
    const defaultIndex = reindexDefaultAfterMove(model.defaultIndex, source.position, insertIndex);
    return { ok: true, model: { greetings, defaultIndex }, sourcePosition: source.position, targetPosition: target.position };
}

/**
 * Makes the greeting whose hash is `expectedHash`, found by {@link findGreeting}, the default. Never reorders
 * anything. `position` in the result is where that greeting is.
 * @param {import('./greeting-list.js').GreetingsModel} model
 * @param {number} position
 * @param {number} expectedHash
 * @returns {{ok: true, model: import('./greeting-list.js').GreetingsModel, position: number}|{ok: false, reason: string}}
 */
export function opSetDefault(model, position, expectedHash) {
    const found = findGreeting(model, position, expectedHash, GREETING_REASONS);
    if (!found.ok) return found;
    return { ok: true, model: { greetings: model.greetings.slice(), defaultIndex: found.position }, position: found.position };
}

/**
 * Clears the default entirely when the default greeting is the one whose hash is `expectedDefaultHash`, wherever it
 * now sits. Refuses when the default is another greeting or there is none. The list keeps its order and membership.
 * @param {import('./greeting-list.js').GreetingsModel} model
 * @param {number} expectedDefaultHash
 */
export function opUnsetDefaultByHash(model, expectedDefaultHash) {
    if (model.defaultIndex === null || !hashMatches(model, model.defaultIndex, expectedDefaultHash)) {
        return { ok: false, reason: 'default greeting changed since it was loaded' };
    }
    return { ok: true, model: { greetings: model.greetings.slice(), defaultIndex: null } };
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
