import { getStringHash } from '../public/scripts/hash-utils.js';

/** @typedef {import('./greeting-items.js').GreetingModel} GreetingModel */

/**
 * @param {string} text
 */
export function hashGreetingText(text) {
    return getStringHash(JSON.stringify(text));
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
 * @param {number} id
 * @param {number} expectedHash the hash of the text the greeting had when it was read
 * @param {{gone: string, changed: string}} reasons
 * @returns {{ok: true, position: number}|{ok: false, reason: string}}
 */
function findGreeting(model, id, expectedHash, reasons) {
    const position = model.greetings.findIndex(g => g.id === id);
    if (position < 0) return { ok: false, reason: reasons.gone };
    if (hashGreetingText(model.greetings[position].text) !== expectedHash) return { ok: false, reason: reasons.changed };
    return { ok: true, position };
}

/**
 * @param {GreetingModel} model
 * @param {string} text
 * @param {number} [except] the id of the greeting being changed
 * @returns {{ok: false, reason: string, same: number, sameId: number} | null} the refusal when another greeting has the
 *   text: `same` its position, `sameId` its id
 */
function sameAsAnother(model, text, except) {
    const same = model.greetings.findIndex(g => g.id !== except && g.text === text);
    return same < 0 ? null : { ok: false, reason: `same as greeting ${same + 1}`, same, sameId: model.greetings[same].id };
}

const GREETING_REASONS = { gone: 'the greeting is gone', changed: 'the greeting changed since it was loaded' };
const TARGET_REASONS = { gone: 'the target greeting is gone', changed: 'the target greeting changed since it was loaded' };

/**
 * @param {GreetingModel} model
 * @param {number} position where in the card the greeting goes
 * @param {number} expectedLength
 * @param {string} text
 * @returns {{ok: true, model: GreetingModel, position: number, id: number}|{ok: false, reason: string, same?: number, sameId?: number}}
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
    const same = sameAsAnother(model, text);
    if (same) return same;
    const added = { id: model.nextId, text };
    const greetings = model.greetings.slice();
    greetings.splice(position, 0, added);
    const defaultId = model.greetings.length === 0 ? added.id : model.defaultId;
    return { ok: true, model: { greetings, defaultId, nextId: model.nextId + 1 }, position, id: added.id };
}

/**
 * @param {GreetingModel} model
 * @param {string} text
 * @returns {ReturnType<typeof opAdd>}
 */
export function opAppend(model, text) {
    const length = model.greetings.length;
    return opAdd(model, length, length, text);
}

/**
 * @param {GreetingModel} model
 * @param {number} id
 * @param {number} expectedHash
 * @param {string} text
 * @returns {{ok: true, model: GreetingModel, position: number, id: number}|{ok: false, reason: string, same?: number, sameId?: number}}
 */
export function opEdit(model, id, expectedHash, text) {
    if (typeof text !== 'string' || text === '') {
        return { ok: false, reason: 'refused to blank stored greeting text' };
    }
    const found = findGreeting(model, id, expectedHash, GREETING_REASONS);
    if (!found.ok) {
        const at = model.greetings.findIndex(g => g.id === id);
        // the same edit sent again, after the first one was stored
        if (at >= 0 && model.greetings[at].text === text) return { ok: true, model, position: at, id };
        return found;
    }
    const same = sameAsAnother(model, text, id);
    if (same) return same;
    const greetings = model.greetings.map((g, i) => (i === found.position ? { id: g.id, text } : g));
    return { ok: true, model: { ...model, greetings }, position: found.position, id };
}

/**
 * @param {GreetingModel} model
 * @param {number} id
 * @param {number} expectedHash
 * @returns {{ok: true, model: GreetingModel, position: number, id: number}|{ok: false, reason: string}}
 */
export function opDelete(model, id, expectedHash) {
    const found = findGreeting(model, id, expectedHash, GREETING_REASONS);
    if (!found.ok) return found;
    const greetings = model.greetings.filter(g => g.id !== id);
    return { ok: true, model: { ...model, greetings, defaultId: model.defaultId === id ? null : model.defaultId }, position: found.position, id };
}

/**
 * @param {GreetingModel} model
 * @param {number} id
 * @param {number} expectedHash
 * @param {'before'|'after'} side
 * @param {number} targetId
 * @param {number} targetExpectedHash
 * @returns {{ok: true, model: GreetingModel, sourcePosition: number, targetPosition: number}|{ok: false, reason: string}}
 */
export function opMove(model, id, expectedHash, side, targetId, targetExpectedHash) {
    const source = findGreeting(model, id, expectedHash, GREETING_REASONS);
    if (!source.ok) return source;
    const target = findGreeting(model, targetId, targetExpectedHash, TARGET_REASONS);
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
 * @param {number} id
 * @param {number} expectedHash
 * @returns {{ok: true, model: GreetingModel, position: number, id: number}|{ok: false, reason: string}}
 */
export function opSetDefault(model, id, expectedHash) {
    const found = findGreeting(model, id, expectedHash, GREETING_REASONS);
    if (!found.ok) return found;
    return { ok: true, model: { ...model, defaultId: id }, position: found.position, id };
}

/**
 * @param {GreetingModel} model
 * @param {number} id the default greeting, as it was read
 * @param {number} expectedHash
 * @returns {{ok: true, model: GreetingModel}|{ok: false, reason: string}}
 */
export function opUnsetDefault(model, id, expectedHash) {
    if (model.defaultId === null) return { ok: true, model };
    if (model.defaultId !== id) return { ok: false, reason: 'default greeting changed since it was loaded' };
    const found = findGreeting(model, id, expectedHash, GREETING_REASONS);
    if (!found.ok) return { ok: false, reason: 'default greeting changed since it was loaded' };
    return { ok: true, model: { ...model, defaultId: null } };
}

/**
 * A change to a card's greetings, each existing greeting named by its id with the hash of the text it was read with
 * @typedef {{op: 'add', text: string, position?: number, expectedLength?: number}
 *   | {op: 'edit', id: number, hash: number, text: string}
 *   | {op: 'delete', id: number, hash: number}
 *   | {op: 'move', id: number, hash: number, side: 'before'|'after', target: number, targetHash: number}
 *   | {op: 'default', id: number, hash: number}
 *   | {op: 'undefault', id: number, hash: number}} GreetingChange
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
        case 'edit': return model => opEdit(model, change.id, change.hash, change.text);
        case 'delete': return model => opDelete(model, change.id, change.hash);
        case 'move': return model => opMove(model, change.id, change.hash, change.side, change.target, change.targetHash);
        case 'default': return model => opSetDefault(model, change.id, change.hash);
        case 'undefault': return model => opUnsetDefault(model, change.id, change.hash);
    }
}
