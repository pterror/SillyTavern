import { getStringHash } from '../public/scripts/hash-utils.js';

/** @typedef {import('./greeting-items.js').GreetingModel} GreetingModel */

/**
 * @param {string} text
 */
export function hashGreetingText(text) {
    return getStringHash(JSON.stringify(text));
}

function positionInBounds(position, length) {
    return Number.isInteger(position) && position >= 0 && position < length;
}

/**
 * @param {GreetingModel} model
 * @param {number} position
 * @param {number} expectedHash
 */
function hashMatches(model, position, expectedHash) {
    return hashGreetingText(model.greetings[position].text) === expectedHash;
}

/**
 * @param {GreetingModel} model
 * @returns {number | null}
 */
export function defaultPositionOf(model) {
    const at = model.greetings.findIndex(g => g.id === model.defaultId);
    return at < 0 ? null : at;
}

/**
 * @param {GreetingModel} model
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
 * @param {GreetingModel} model
 * @param {number} position
 * @param {number} expectedLength
 * @param {string} text
 * @returns {{ok: true, model: GreetingModel, position: number}|{ok: false, reason: string}}
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
    const added = { id: model.nextId, text };
    const greetings = model.greetings.slice();
    greetings.splice(position, 0, added);
    const defaultId = model.greetings.length === 0 ? added.id : model.defaultId;
    return { ok: true, model: { greetings, defaultId, nextId: model.nextId + 1 }, position };
}

/**
 * @param {GreetingModel} model
 * @param {string} text
 * @returns {{ok: true, model: GreetingModel, position: number}|{ok: false, reason: string}}
 */
export function opAppend(model, text) {
    const length = model.greetings.length;
    return opAdd(model, length, length, text);
}

/**
 * @param {GreetingModel} model
 * @param {number} position
 * @param {number} expectedHash
 * @param {string} text
 * @returns {{ok: true, model: GreetingModel, position: number}|{ok: false, reason: string}}
 */
export function opEdit(model, position, expectedHash, text) {
    if (typeof text !== 'string' || text === '') {
        return { ok: false, reason: 'refused to blank stored greeting text' };
    }
    const found = findGreeting(model, position, expectedHash, GREETING_REASONS);
    if (!found.ok) {
        if (positionInBounds(position, model.greetings.length) && model.greetings[position].text === text) {
            return { ok: true, model, position };
        }
        return found;
    }
    const greetings = model.greetings.map((g, i) => (i === found.position ? { id: g.id, text } : g));
    return { ok: true, model: { ...model, greetings }, position: found.position };
}

/**
 * @param {GreetingModel} model
 * @param {number} position
 * @param {number} expectedHash
 * @returns {{ok: true, model: GreetingModel, position: number}|{ok: false, reason: string}}
 */
export function opDelete(model, position, expectedHash) {
    const found = findGreeting(model, position, expectedHash, GREETING_REASONS);
    if (!found.ok) return found;
    const gone = model.greetings[found.position];
    const greetings = model.greetings.filter((_, i) => i !== found.position);
    return { ok: true, model: { ...model, greetings, defaultId: model.defaultId === gone.id ? null : model.defaultId }, position: found.position };
}

/**
 * @param {GreetingModel} model
 * @param {number} sourcePosition
 * @param {number} expectedHash
 * @param {'before'|'after'} side
 * @param {number} targetPosition
 * @param {number} targetExpectedHash
 * @returns {{ok: true, model: GreetingModel, sourcePosition: number, targetPosition: number}|{ok: false, reason: string}}
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
    const anchor = model.greetings[target.position];
    const greetings = model.greetings.filter((_, i) => i !== source.position);
    const at = greetings.indexOf(anchor);
    greetings.splice(side === 'before' ? at : at + 1, 0, model.greetings[source.position]);
    return { ok: true, model: { ...model, greetings }, sourcePosition: source.position, targetPosition: target.position };
}

/**
 * @param {GreetingModel} model
 * @param {number} position
 * @param {number} expectedHash
 * @returns {{ok: true, model: GreetingModel, position: number}|{ok: false, reason: string}}
 */
export function opSetDefault(model, position, expectedHash) {
    const found = findGreeting(model, position, expectedHash, GREETING_REASONS);
    if (!found.ok) {
        const shown = defaultPositionOf(model);
        if (shown !== null && hashMatches(model, shown, expectedHash)) {
            return { ok: true, model, position: shown };
        }
        return found;
    }
    return { ok: true, model: { ...model, defaultId: model.greetings[found.position].id }, position: found.position };
}

/**
 * @param {GreetingModel} model
 * @param {number} expectedDefaultHash
 * @returns {{ok: true, model: GreetingModel}|{ok: false, reason: string}}
 */
export function opUnsetDefaultByHash(model, expectedDefaultHash) {
    const shown = defaultPositionOf(model);
    if (shown !== null && !hashMatches(model, shown, expectedDefaultHash)) {
        return { ok: false, reason: 'default greeting changed since it was loaded' };
    }
    return { ok: true, model: { ...model, defaultId: null } };
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
 * @returns {(model: GreetingModel) => any}
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
