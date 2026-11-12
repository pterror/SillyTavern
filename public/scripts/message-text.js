import { DOMPurify } from '../lib.js';
import { chat } from './chat-state.js';
import { macroValuePieces } from './chat-text/macros.js';
import { chatHtmlPolicy } from './chat-text/policy.js';
import { drawnText, showText, stopText, textReader } from './chat-text/surface.js';
import { MacroValues } from './macro-values.js';
import { macrosIn, withFilledAbout } from './safe-macros.js';

/**
 * @typedef {import('./chat-text/surface.js').TextSetup} TextSetup
 */

/**
 * What drawing the chat's text reads from the page
 * @typedef {object} MessageTextPage
 * @property {() => Record<string, any>} settings the settings text is drawn by (`power_user`)
 * @property {() => import('./macro-values.js').MacroScope} macroScope the open chat's
 * @property {(macroName: string, options: { name?: string }) => import('./macro-pill.js').MacroPerson | null} macroPerson
 * @property {(text: string) => string} substituteParams for settings that hold macros
 * @property {string} systemName the name the app's own messages are from
 * @property {(shownIn: Element, message: () => ChatMessage | undefined) => import('@pterror/interact-editor/reader').Overlay} loreMarks
 * @property {() => boolean} mediaAllowed whether media from other sites is loaded
 * @property {() => void} mediaBlocked hears that media from another site was hidden
 * @property {import('./macro-pill.js').Translate} t
 */

/** @type {MessageTextPage} */
let page;

/**
 * @param {MessageTextPage} dependencies
 */
export function initMessageText(dependencies) {
    page = dependencies;
}

/** @type {Map<string, MacroValues>} the open chat's macro values, by the character a message is from ('' for the user) */
const chatValues = new Map();

/**
 * @param {string | null} speaker the character the text is from, or null for the user
 * @returns {MacroValues}
 */
function valuesFor(speaker) {
    const key = speaker ?? '';
    let values = chatValues.get(key);
    if (!values) {
        values = new MacroValues(() => (speaker === null ? page.macroScope() : { ...page.macroScope(), name2: speaker }));
        chatValues.set(key, values);
    }
    return values;
}

/**
 * @param {ChatMessage} message
 * @returns {string | null}
 */
const speakerOf = message => (message.is_user ? null : String(message.name ?? ''));

/**
 * @param {string} styleScope
 * @returns {import('@pterror/interact-markdown/look').Html}
 */
const policyFor = styleScope => chatHtmlPolicy({
    mediaAllowed: () => page.mediaAllowed(),
    autoplay: () => Boolean(page.settings().media_autoplay),
    styleScope,
    blocked: () => page.mediaBlocked(),
});

const MESSAGE_POLICY = policyFor('.mes_text ');

/**
 * @param {boolean} dialogueQuotes
 * @returns {TextSetup['grammar']}
 */
function grammarOptions(dialogueQuotes) {
    const settings = page.settings();
    const escapes = String(settings.markdown_escape_strings ?? '');
    return {
        dialogueQuotes,
        encodeTags: Boolean(settings.encode_tags),
        escapeLines: escapes ? page.substituteParams(escapes).split(',').filter(Boolean) : [],
        reasoningMarkers: [settings.reasoning?.prefix ?? '', settings.reasoning?.suffix ?? ''],
    };
}

/**
 * @param {string | null} speaker
 * @param {string} kind
 * @param {Element | null} shownIn the message's text element, for its lore marks; none for text without them
 * @returns {TextSetup}
 */
function chatSetup(speaker, kind, shownIn) {
    const grammar = grammarOptions(true);
    const values = valuesFor(speaker);
    return {
        key: JSON.stringify([kind, speaker, grammar]),
        grammar,
        html: MESSAGE_POLICY,
        macro: macroValuePieces(values, name => withFilledAbout(page.macroPerson(name, { name: speaker ?? '' }), name, values.valueOf), page.t),
        ...(shownIn ? { overlays: () => [page.loreMarks(shownIn, () => messageShownIn(shownIn))] } : {}),
    };
}

/** @type {WeakMap<Element, ChatMessage>} */
const shownMessages = new WeakMap();

/**
 * @param {Element} element a message's text element
 * @returns {ChatMessage | undefined} the message as the chat has it now, or as it was shown when it isn't in the chat
 */
function messageShownIn(element) {
    const id = element.closest('.mes')?.getAttribute('mesid');
    return (id === null || id === undefined ? undefined : chat[Number(id)]) ?? shownMessages.get(element);
}

/**
 * @param {ChatMessage} message
 * @returns {boolean} whether the message is the app's own, its text the page's HTML rather than chat text
 */
const isAppMessage = message => Boolean(message.is_system) && message.name === page.systemName;

/**
 * Shows a message's text in its text element. The app's own messages are its HTML; every other is drawn by the
 * reader from the text as stored.
 * @param {Element} element the message's `.mes_text`
 * @param {ChatMessage} message
 * @param {{ fade?: boolean }} [options] fade: the text is a reply being streamed
 */
export function showMessageText(element, message, { fade = false } = {}) {
    const text = String(message.mes ?? '');
    if (isAppMessage(message)) {
        stopText(element);
        element.innerHTML = DOMPurify.sanitize(text);
        return;
    }
    shownMessages.set(element, message);
    showText(element, text, chatSetup(speakerOf(message), 'message', element), { fade });
}

/**
 * Draws a message's text again, from scratch, with its macros' values learned again, for when what they are filled in
 * from changed (the persona, the card)
 * @param {Element} element the message's `.mes_text`
 * @param {ChatMessage} message
 */
export function redrawMessageText(element, message) {
    stopText(element);
    showMessageText(element, message);
    if (isAppMessage(message) || macrosIn(String(message.mes ?? '')).length === 0) return;
    void valuesFor(speakerOf(message)).refresh().then((changed) => {
        const shown = shownMessages.get(element);
        if (!changed || !shown || !element.isConnected || element.querySelector('textarea')) return;
        stopText(element);
        showMessageText(element, shown);
    });
}

/**
 * Shows a message's reasoning in its reasoning element
 * @param {Element} element the message's `.mes_reasoning`
 * @param {ChatMessage} message
 * @param {string} reasoning
 * @param {{ fade?: boolean }} [options] fade: the reasoning is being streamed
 */
export function showReasoningText(element, message, reasoning, { fade = false } = {}) {
    showText(element, reasoning, chatSetup(speakerOf(message), 'reasoning', null), { fade });
}

/**
 * Shows the bias of a message's reply in its bias line
 * @param {Element} element the message's `.mes_bias`
 * @param {string} bias
 */
export function showBiasText(element, bias) {
    if (!bias) {
        stopText(element);
        element.replaceChildren();
        return;
    }
    showText(element, bias, chatSetup(null, 'bias', null));
}

/**
 * A text drawn as a message of the open chat from the given speaker, once, for a place outside the chat
 * @param {string} text
 * @param {{ name: string, isUser: boolean }} speaker
 * @returns {HTMLElement}
 */
export function drawnMessageText(text, { name, isUser }) {
    return drawnText(text, chatSetup(isUser ? null : name, 'message', null));
}

/**
 * An alternative of a message drawn for the list of alternatives, the parts a search matched marked
 * @param {{ name: string, isUser: boolean }} speaker
 * @returns {{ element: HTMLElement, show: (text: string, matches: readonly number[] | null) => void, stop: () => void }}
 */
export function alternativeReader({ name, isUser }) {
    /** @type {readonly number[] | null} */
    let matches = null;
    /** @type {Set<() => void>} */
    const listeners = new Set();
    /** @type {import('@pterror/interact-editor/reader').Overlay} */
    const search = {
        ranges() {
            /** @type {import('@pterror/interact-editor/reader').Range[]} */
            const ranges = [];
            for (let i = 0; matches && i + 1 < matches.length; i += 2) ranges.push({ from: matches[i], to: matches[i + 1], class: 'match' });
            return ranges;
        },
        watch(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
    const shown = textReader({ ...chatSetup(isUser ? null : name, 'alternative', null), overlays: () => [search] });
    return {
        element: shown.element,
        show(text, found) {
            const changed = JSON.stringify(found) !== JSON.stringify(matches);
            matches = found ? [...found] : null;
            shown.show(text);
            if (changed) for (const listener of listeners) listener();
        },
        stop: shown.stop,
    };
}

/**
 * How a card's text is drawn where it is previewed: a greeting as a message, the creator's notes and the description
 * with HTML and their styles limited to the given scope, the rest with HTML shown as text and markdown's links and
 * images drawn
 * @param {'greeting' | 'notes' | 'literal'} kind
 * @param {{ values: import('./chat-text/macros.js').MacroValueSource & { valueOf: import('./safe-macros.js').MacroValueOf }, person: (macroName: string) => import('./macro-pill.js').MacroPerson | null, styleScope?: string }} options
 * @returns {TextSetup}
 */
export function cardTextSetup(kind, { values, person, styleScope = '' }) {
    const macro = macroValuePieces(values, name => withFilledAbout(person(name), name, values.valueOf), page.t);
    if (kind === 'greeting') {
        const grammar = grammarOptions(true);
        return { key: JSON.stringify([kind, grammar]), grammar, html: MESSAGE_POLICY, macro };
    }
    if (kind === 'notes') {
        return { key: JSON.stringify([kind, styleScope]), grammar: {}, html: policyFor(styleScope), macro };
    }
    return { key: kind, grammar: { encodeTags: true }, html: MESSAGE_POLICY, macro };
}

/**
 * Learns the values of the macros in messages before they are drawn, in one request for each speaker, so their
 * text is drawn whole
 * @param {readonly ChatMessage[]} messages
 * @returns {Promise<void>}
 */
export async function learnMessageMacros(messages) {
    /** @type {Map<string | null, string[]>} */
    const wanted = new Map();
    for (const message of messages) {
        if (!message || isAppMessage(message)) continue;
        const sources = [String(message.mes ?? ''), String(message.extra?.reasoning ?? '')].flatMap(macrosIn);
        if (!sources.length) continue;
        const speaker = speakerOf(message);
        wanted.set(speaker, [...(wanted.get(speaker) ?? []), ...sources]);
    }
    await Promise.all([...wanted].map(([speaker, sources]) => valuesFor(speaker).wantMacros(sources)));
}

/**
 * The style elements a message's text draws
 * @param {ChatMessage} message
 * @returns {HTMLStyleElement[]}
 */
export function messageStyles(message) {
    if (!message || isAppMessage(message)) return [];
    return [...drawnMessageText(String(message.mes ?? ''), { name: String(message.name ?? ''), isUser: Boolean(message.is_user) }).querySelectorAll('style')];
}
