import { getStringHash } from '../public/scripts/hash-utils.js';
import { reindexDefaultAfterMove, reindexDefaultAfterRemoval } from './greeting-list.js';

/**
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
    if (!found.ok) {
        if (positionInBounds(position, model.greetings.length) && model.greetings[position] === text) {
            return { ok: true, model: { greetings: model.greetings.slice(), defaultIndex: model.defaultIndex }, position };
        }
        return found;
    }
    const greetings = model.greetings.slice();
    greetings[found.position] = text;
    return { ok: true, model: { greetings, defaultIndex: model.defaultIndex }, position: found.position };
}

/**
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
 * @param {import('./greeting-list.js').GreetingsModel} model
 * @param {number} sourcePosition
 * @param {number} expectedHash
 * @param {'before'|'after'} side
 * @param {number} targetPosition
 * @param {number} targetExpectedHash
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
 * @param {import('./greeting-list.js').GreetingsModel} model
 * @param {number} position
 * @param {number} expectedHash
 * @returns {{ok: true, model: import('./greeting-list.js').GreetingsModel, position: number}|{ok: false, reason: string}}
 */
export function opSetDefault(model, position, expectedHash) {
    const found = findGreeting(model, position, expectedHash, GREETING_REASONS);
    if (!found.ok) {
        if (model.defaultIndex !== null && hashMatches(model, model.defaultIndex, expectedHash)) {
            return { ok: true, model: { greetings: model.greetings.slice(), defaultIndex: model.defaultIndex }, position: model.defaultIndex };
        }
        return found;
    }
    return { ok: true, model: { greetings: model.greetings.slice(), defaultIndex: found.position }, position: found.position };
}

/**
 * @param {import('./greeting-list.js').GreetingsModel} model
 * @param {number} expectedDefaultHash
 */
export function opUnsetDefaultByHash(model, expectedDefaultHash) {
    if (model.defaultIndex !== null && !hashMatches(model, model.defaultIndex, expectedDefaultHash)) {
        return { ok: false, reason: 'default greeting changed since it was loaded' };
    }
    return { ok: true, model: { greetings: model.greetings.slice(), defaultIndex: null } };
}

/**
 * @param {import('./greeting-list.js').GreetingsModel} model
 * @param {number|null} expectedDefaultPosition
 */
export function opUnsetDefault(model, expectedDefaultPosition) {
    if (model.defaultIndex !== null && model.defaultIndex !== expectedDefaultPosition) {
        return { ok: false, reason: 'default greeting changed since it was loaded' };
    }
    return { ok: true, model: { greetings: model.greetings.slice(), defaultIndex: null } };
}
