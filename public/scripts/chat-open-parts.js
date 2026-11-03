/**
 * @typedef {{ type: 'character'|'group', id: string }} ChatOwner
 */

/** @type {Map<string, (owner: ChatOwner) => unknown>} */
const askers = new Map();

/** @type {{ chat: string, parts: Map<string, unknown> }} */
let opened = { chat: '', parts: new Map() };

/**
 * @param {string} name A part src/chat-open-parts.js answers
 * @param {(owner: ChatOwner) => unknown} ask undefined: this open doesn't need the part
 */
export function askOnChatOpen(name, ask) {
    askers.set(name, ask);
}

/**
 * @param {ChatOwner} owner
 * @returns {Record<string, unknown>}
 */
export function chatOpenAsks(owner) {
    /** @type {Record<string, unknown>} */
    const asks = {};
    for (const [name, ask] of askers) {
        const asked = ask(owner);
        if (asked !== undefined) asks[name] = asked;
    }
    return asks;
}

/**
 * @param {string} chat
 * @param {unknown} parts
 */
export function takeChatOpenParts(chat, parts) {
    opened = { chat, parts: new Map(parts && typeof parts === 'object' ? Object.entries(parts) : []) };
}

/**
 * @param {string} name
 * @param {string|undefined} chat
 * @returns {any}
 */
export function chatOpenPart(name, chat) {
    return chat === opened.chat ? opened.parts.get(name) ?? null : null;
}

/**
 * @param {string} name
 * @param {string|undefined} chat
 * @returns {any}
 */
export function takeChatOpenPart(name, chat) {
    const part = chatOpenPart(name, chat);
    opened.parts.delete(name);
    return part;
}
