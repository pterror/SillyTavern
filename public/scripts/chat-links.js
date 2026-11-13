import { getStringHash } from './hash-utils.js';
import { isStoredNodeId } from './node-identity.js';
import { newUi } from './new-ui-page.js';
import { CHAT_LINKS_LOOKS } from './name-holders.js';

/**
 * @typedef {{ of: number, links: [number, number, string][], complete: boolean }} MessageLinks
 * @typedef {{ world: string, picture: string | null }} LinkedEntry
 * @typedef {{ messages: Record<string, MessageLinks>, entries: Record<string, LinkedEntry>, looks: import('@st/protocol/looks').Looks }} ChatLinks
 */

/** @type {Map<string, MessageLinks>} the links the server last sent for each message the tab shows, by node id */
const held = new Map();
/** @type {Map<string, LinkedEntry>} */
const linked = new Map();
/** @type {Map<() => void, Element>} each listener of a message's links, and the element its text is shown in */
const listeners = new Map();

/**
 * Takes the links an answer carries. A chat's open and a push replace every link held (they are what the tab shows);
 * every other answer adds to them.
 * @param {ChatLinks | null | undefined} links
 * @param {{ replace?: boolean }} [o]
 */
export function takeChatLinks(links, { replace = false } = {}) {
    if (!links || typeof links !== 'object') return;
    if (replace) {
        held.clear();
        linked.clear();
        newUi().names.hold(CHAT_LINKS_LOOKS, links.looks);
    } else {
        newUi().names.add(CHAT_LINKS_LOOKS, links.looks);
    }
    for (const [nodeId, message] of Object.entries(links.messages ?? {})) held.set(nodeId, message);
    for (const [thing, entry] of Object.entries(links.entries ?? {})) linked.set(thing, entry);
    for (const [listener, shownIn] of listeners) {
        if (shownIn.isConnected) listener();
        else listeners.delete(listener);
    }
}

/**
 * @param {string} thing an entry's entity id
 * @returns {LinkedEntry | null}
 */
export const linkedEntry = thing => linked.get(thing) ?? null;

/**
 * Where a message's text writes names of entries, each wrapped in its entry's look and linked, while the text is the
 * one the server looked through. It stops hearing changes once the element the text is shown in is taken off the page.
 * @param {Element} shownIn where the message's text is shown
 * @param {() => Record<string, any> | undefined} message the message the text is
 * @returns {import('@pterror/interact-editor/reader').Overlay}
 */
export function chatLinkOverlay(shownIn, message) {
    return {
        ranges(from, to, { read }) {
            const nodeId = message()?.node_id;
            if (typeof nodeId !== 'string' || !isStoredNodeId(nodeId)) return [];
            const found = held.get(nodeId);
            if (!found || from !== 0) return [];
            const text = read(from, to);
            if (getStringHash(text) !== found.of) return [];
            return found.links.flatMap(([start, end, thing]) => {
                if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= text.length && start < end)) return [];
                const [box, name] = newUi().names.inline(thing, linked.get(thing)?.picture ?? null);
                return [
                    { from: start, to: end, class: `${box.class} chat-name`, attributes: { ...box.attributes, tabindex: '0', role: 'link' } },
                    { from: start, to: end, class: name.class, attributes: name.attributes },
                ];
            });
        },
        watch(listener) {
            listeners.set(listener, shownIn);
            return () => listeners.delete(listener);
        },
    };
}
