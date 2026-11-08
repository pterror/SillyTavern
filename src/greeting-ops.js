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
    let defaultIndex = model.greetings.length === 0 ? position : model.defaultIndex;
    if (defaultIndex !== null && model.greetings.length > 0 && position <= defaultIndex) defaultIndex += 1;
    return { ok: true, model: { greetings, defaultIndex }, position };
}

/**
 * @param {import('./greeting-list.js').GreetingsModel} model
 * @param {string} text
 * @returns {{ok: true, model: import('./greeting-list.js').GreetingsModel, position: number}|{ok: false, reason: string}}
 */
export function opAppend(model, text) {
    const length = model.greetings.length;
    return opAdd(model, length, length, text);
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
 * @typedef {{op: 'add', text: string, position?: number, expectedLength?: number}
 *   | {op: 'edit', position: number, hash: number, text: string}
 *   | {op: 'delete', position: number, hash: number}
 *   | {op: 'move', position: number, hash: number, side: 'before'|'after', target: number, targetHash: number}
 *   | {op: 'default', position: number, hash: number}
 *   | {op: 'undefault', hash: number}} GreetingChange
 */

/**
 * @param {GreetingChange} change
 * @returns {(model: import('./greeting-list.js').GreetingsModel) => any}
 */
export function greetingOperation(change) {
    switch (change.op) {
        case 'add': return change.position === undefined
            ? model => opAppend(model, change.text)
            : model => opAdd(model, /** @type {number} */ (change.position), /** @type {number} */ (change.expectedLength), change.text);
        case 'edit': return model => opEdit(model, change.position, change.hash, change.text);
        case 'delete': return model => opDelete(model, change.position, change.hash);
        case 'move': return model => opMove(model, change.position, change.hash, change.side, change.target, change.targetHash);
        case 'default': return model => opSetDefault(model, change.position, change.hash);
        case 'undefault': return model => opUnsetDefaultByHash(model, change.hash);
    }
}

/**
 * @param {GreetingChange} change
 * @param {{position?: number, sourcePosition?: number, targetPosition?: number, model?: import('./greeting-list.js').GreetingsModel}} result
 * @param {number} chosen a session's chosen greeting's place among the card's greetings
 * @returns {number|null} its place after the change; null for the card's default
 */
export function chosenGreetingAfter(change, result, chosen) {
    switch (change.op) {
        case 'add': {
            const at = /** @type {number} */ (result.position);
            return chosen >= at ? chosen + 1 : chosen;
        }
        case 'edit': return chosen;
        case 'delete': {
            const at = /** @type {number} */ (result.position);
            const left = result.model?.greetings.length ?? 0;
            if (chosen === at) return left === 0 ? null : Math.min(at, left - 1);
            return chosen > at ? chosen - 1 : chosen;
        }
        case 'move': {
            const source = /** @type {number} */ (result.sourcePosition);
            const target = /** @type {number} */ (result.targetPosition);
            const anchor = target > source ? target - 1 : target;
            return reindexDefaultAfterMove(chosen, source, change.side === 'before' ? anchor : anchor + 1);
        }
        case 'default':
        case 'undefault':
            return null;
    }
}
