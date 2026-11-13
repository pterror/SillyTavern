import { DOMPurify } from '../lib.js';
import { chat } from './chat-state.js';
import { macroValuePieces } from './chat-text/macros.js';
import { chatHtmlPolicy } from './chat-text/policy.js';
import { drawnText, showText, stopText, textReader } from './chat-text/surface.js';
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
 * @param {() => Record<string, string | null> | undefined} valuesOf the values of the text's macros, as the server sent
 *   them with it
 * @param {Element | null} [loreIn] the message's text element, for its lore marks; none for text without them
 * @returns {TextSetup}
 */
function chatSetup(speaker, kind, valuesOf, loreIn = null) {
    const grammar = grammarOptions(true);
    /** @type {import('./chat-text/macros.js').MacroValueSource} */
    const values = { get: source => valuesOf()?.[source] };
    return {
        key: JSON.stringify([kind, speaker, grammar]),
        grammar,
        html: MESSAGE_POLICY,
        macro: macroValuePieces(values, name => withFilledAbout(page.macroPerson(name, { name: speaker ?? '' }), name, values.get), page.t),
        ...(loreIn ? { overlays: () => [page.loreMarks(loreIn, () => messageShownIn(loreIn))] } : {}),
    };
}

/**
 * @param {Element} element an element of a message
 * @returns {() => Record<string, string | null> | undefined} the values of its macros, as the chat has them now
 */
const valuesIn = element => () => messageShownIn(element)?.extra?.macro_values;

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
    showText(element, text, chatSetup(speakerOf(message), 'message', valuesIn(element), element), { fade });
}

/** @type {WeakMap<Element, { redraw: () => void }>} the editor open on a message's text or reasoning element */
const openEditors = new WeakMap();

/**
 * Says an editor is open on a message's text or reasoning element, so drawing it again draws the editor's macros
 * again too
 * @param {Element} element
 * @param {{ redraw: () => void } | null} editor none when it closed
 */
export function editingIn(element, editor) {
    if (editor) openEditors.set(element, editor);
    else openEditors.delete(element);
}

/**
 * Draws a message's text again, from scratch, for when its macros' values changed; in an editor open in it, its macros
 * @param {Element} element the message's `.mes_text`
 * @param {ChatMessage} message
 */
export function redrawMessageText(element, message) {
    const editing = openEditors.get(element);
    if (editing) {
        editing.redraw();
        return;
    }
    stopText(element);
    showMessageText(element, message);
}

/**
 * Shows a message's reasoning in its reasoning element, and draws the macros of a reasoning editor open on it again
 * @param {Element} element the message's `.mes_reasoning`
 * @param {ChatMessage} message
 * @param {string} reasoning
 * @param {{ fade?: boolean }} [options] fade: the reasoning is being streamed
 */
export function showReasoningText(element, message, reasoning, { fade = false } = {}) {
    openEditors.get(element)?.redraw();
    showText(element, reasoning, chatSetup(speakerOf(message), 'reasoning', valuesIn(element)), { fade });
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
    showText(element, bias, chatSetup(null, 'bias', valuesIn(element)));
}

/**
 * A text drawn as a message of the open chat from the given speaker, once, for a place outside the chat
 * @param {string} text
 * @param {{ name: string, isUser: boolean }} speaker
 * @returns {HTMLElement}
 */
export function drawnMessageText(text, { name, isUser }) {
    return drawnText(text, chatSetup(isUser ? null : name, 'message', () => undefined));
}

/**
 * An alternative of a message drawn for the list of alternatives, the parts a search matched marked
 * @param {{ name: string, isUser: boolean, macros: () => Record<string, string | null> | null | undefined }} alternative
 *   macros: the values of its macros, as the list has them
 * @returns {{ element: HTMLElement, show: (text: string, matches: readonly number[] | null) => void, stop: () => void }}
 */
export function alternativeReader({ name, isUser, macros }) {
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
    const shown = textReader({ ...chatSetup(isUser ? null : name, 'alternative', () => macros() ?? undefined), overlays: () => [search] });
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
 * The macros the open chat's messages draw, for an action that may change their values to be answered with them
 * @returns {{ avatar_url?: string, group_id?: string, at?: string | null, items: { node: string, speaker: string | null, sources: string[] }[] } | undefined}
 */
export function shownMessageMacros() {
    const items = chat.flatMap((message) => {
        if (!message || typeof message.node_id !== 'string' || isAppMessage(message)) return [];
        const sources = [message.mes, message.extra?.reasoning, message.extra?.bias].flatMap(text => (typeof text === 'string' ? macrosIn(text) : []));
        return sources.length ? [{ node: message.node_id, speaker: speakerOf(message), sources: [...new Set(sources)] }] : [];
    });
    return items.length ? { ...page.macroScope(), items } : undefined;
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

/**
 * How the chat box draws what is written in it: as the person's message will be drawn, its macros filled in when sent
 * @returns {TextSetup}
 */
export function chatBoxSetup() {
    return chatSetup(null, 'chat-box', () => undefined);
}

/**
 * How a message's text, or its reasoning, is drawn in an editor opened in it: as the message draws it, its macros'
 * values those the chat has for the message now
 * @param {Element} element the message's text or reasoning element
 * @param {ChatMessage} message
 * @param {'message' | 'reasoning'} kind
 * @returns {{ setup: TextSetup, macroValue: (source: string) => string | null | undefined, speaker: string }}
 */
export function messageEditorSetup(element, message, kind) {
    const valuesOf = valuesIn(element);
    return {
        setup: chatSetup(speakerOf(message), kind, valuesOf),
        macroValue: source => valuesOf()?.[source],
        speaker: speakerOf(message) ?? '',
    };
}
