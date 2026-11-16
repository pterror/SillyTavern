import { DOMPurify } from '../lib.js';
import { chat } from './chat-state.js';
import { loadChatEditor } from './chat-text/editors.js';
import { macroValuePieces } from './chat-text/macros.js';
import { chatHtmlPolicy } from './chat-text/policy.js';
import { drawnText, showText, stopText, textReader } from './chat-text/surface.js';
import { heldMacroSources, MacroValues, macroScopeKey } from './macro-values.js';
import { withFilledAbout } from './safe-macros.js';

/**
 * @typedef {import('./chat-text/surface.js').TextSetup} TextSetup
 */

/**
 * What drawing the chat's text reads from the page
 * @typedef {object} MessageTextPage
 * @property {() => Record<string, any>} settings the settings text is drawn by (`power_user`)
 * @property {() => import('./macro-values.js').MacroScope | null} chatScope the open chat's macros are filled in from:
 *   its character or group, and where it is read up to; none with no chat open
 * @property {(macroName: string, options: { name?: string }) => import('./macro-pill.js').MacroPerson | null} macroPerson
 * @property {(text: string) => string} substituteParams for settings that hold macros
 * @property {string} systemName the name the app's own messages are from
 * @property {(shownIn: Element, message: () => ChatMessage | undefined) => import('@pterror/interact-editor/reader').Overlay} loreMarks
 * @property {(shownIn: Element, message: () => ChatMessage | undefined) => import('@pterror/interact-editor/reader').Overlay} chatLinks
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
 * @param {string | null} speaker null for the person
 * @returns {MacroValues} the values of the macros of the open chat's texts from the speaker
 */
export function chatMacroValues(speaker) {
    return new MacroValues(() => {
        const scope = page.chatScope() ?? {};
        return speaker === null ? scope : { ...scope, name2: speaker };
    });
}

/**
 * @param {MacroValues} values
 * @returns {import('./chat-text/macros.js').MacroValueSource} the values as a text being drawn reads them: one not known
 *   is asked for
 */
const drawnValues = values => ({ get: source => values.read(source) });

/**
 * @param {MacroValues} values
 * @returns {string} what tells drawings with these values from drawings with others
 */
const valuesKey = values => `${macroScopeKey(values.scope())}#${values.version()}`;

/**
 * @param {string | null} speaker
 * @param {string} kind
 * @param {MacroValues} values the values of the text's macros
 * @param {Element | null} [loreIn] the message's text element, for its lore marks and the names it writes; none for
 *   text without them
 * @returns {TextSetup}
 */
function chatSetup(speaker, kind, values, loreIn = null) {
    const grammar = grammarOptions(true);
    const drawn = drawnValues(values);
    return {
        key: JSON.stringify([kind, speaker, grammar, valuesKey(values)]),
        grammar,
        html: MESSAGE_POLICY,
        macro: macroValuePieces(drawn, name => withFilledAbout(page.macroPerson(name, { name: speaker ?? '' }), name, drawn.get), page.t),
        ...(loreIn ? { overlays: () => [page.loreMarks(loreIn, () => messageShownIn(loreIn)), page.chatLinks(loreIn, () => messageShownIn(loreIn))] } : {}),
        now: () => chatSetup(speaker, kind, values, loreIn),
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
    showText(element, text, chatSetup(speakerOf(message), 'message', chatMacroValues(speakerOf(message)), element), { fade });
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
 * Draws a message's text again, from scratch; in an editor open in it, its macros
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
    showText(element, reasoning, chatSetup(speakerOf(message), 'reasoning', chatMacroValues(speakerOf(message))), { fade });
}

/**
 * An alternative's text in an editor, as the list reads it
 * @param {object} options
 * @param {string} options.name the speaker
 * @param {boolean} options.isUser
 * @param {MacroValues} options.values the values of its macros
 * @param {string} options.text
 * @param {() => void} options.changed hears each edit
 * @returns {{ element: HTMLElement, text: () => string, focus: (at?: number) => void, stop: () => void }}
 */
export function alternativeEditor({ name, isUser, values, text, changed }) {
    const element = document.createElement('div');
    let current = text;
    let stopped = false;
    /** @type {import('./chat-text/editor.js').ChatEditor | null} */
    let editor = null;
    /** @type {number | undefined} */
    let at;
    let wanted = false;
    const placed = () => {
        if (!editor || !wanted) return;
        editor.place(Math.min(at ?? text.length, text.length));
        editor.view.focus();
    };
    void loadChatEditor().then(({ chatEditor }) => {
        if (stopped) return;
        editor = chatEditor({
            parent: element,
            setup: chatSetup(isUser ? null : name, 'alternative', values),
            macroValue: values.valueOf,
            macroValues: values,
            speaker: isUser ? '' : name,
            initial: text,
            edited: (now) => {
                current = now;
                changed();
            },
            save: async () => {},
            className: 'alternative-editor-text mes_text',
            label: page.t`Alternative`,
        });
        placed();
    });
    return {
        element,
        text: () => current,
        focus(position) {
            at = position;
            wanted = true;
            placed();
        },
        stop() {
            stopped = true;
            editor?.stop();
        },
    };
}

/**
 * Shows the bias of a message's reply in its bias line
 * @param {Element} element the message's `.mes_bias`
 * @param {ChatMessage} message
 * @param {string} bias
 */
export function showBiasText(element, message, bias) {
    if (!bias) {
        stopText(element);
        element.replaceChildren();
        return;
    }
    showText(element, bias, chatSetup(speakerOf(message), 'bias', chatMacroValues(speakerOf(message))));
}

/**
 * A text drawn as a message of the open chat from the given speaker, once, for a place outside the chat
 * @param {string} text
 * @param {{ name: string, isUser: boolean }} speaker
 * @returns {HTMLElement}
 */
export function drawnMessageText(text, { name, isUser }) {
    return drawnText(text, chatSetup(isUser ? null : name, 'message', chatMacroValues(isUser ? null : name)));
}

/**
 * An alternative of a message drawn for the list of alternatives, the parts a search matched marked
 * @param {{ name: string, isUser: boolean, values: MacroValues }} alternative values: the values of its macros
 * @returns {{ element: HTMLElement, show: (text: string, matches: readonly number[] | null) => void, stop: () => void }}
 */
export function alternativeReader({ name, isUser, values }) {
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
    /** @returns {TextSetup} */
    const setupNow = () => ({ ...chatSetup(isUser ? null : name, 'alternative', values), overlays: () => [search], now: setupNow });
    const shown = textReader(setupNow());
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
 * @param {{ values: MacroValues, person: (macroName: string) => import('./macro-pill.js').MacroPerson | null, styleScope?: string }} options
 * @returns {TextSetup}
 */
export function cardTextSetup(kind, { values, person, styleScope = '' }) {
    const drawn = drawnValues(values);
    const macro = macroValuePieces(drawn, name => withFilledAbout(person(name), name, drawn.get), page.t);
    const now = () => cardTextSetup(kind, { values, person, styleScope });
    if (kind === 'greeting') {
        const grammar = grammarOptions(true);
        return { key: JSON.stringify([kind, grammar, valuesKey(values)]), grammar, html: MESSAGE_POLICY, macro, now };
    }
    if (kind === 'notes') {
        return { key: JSON.stringify([kind, styleScope, valuesKey(values)]), grammar: {}, html: policyFor(styleScope), macro, now };
    }
    return { key: JSON.stringify([kind, valuesKey(values)]), grammar: { encodeTags: true }, html: MESSAGE_POLICY, macro, now };
}

/**
 * The macros the page holds values of, for an action that may change their values to be answered with them
 * (`replaceMacroValues`), with where the open chat is read up to
 * @returns {{ avatar_url?: string, group_id?: string, at?: string | null, scopes: ReturnType<typeof heldMacroSources> } | undefined}
 */
export function shownMessageMacros() {
    const scopes = heldMacroSources();
    return scopes.length ? { ...(page.chatScope() ?? {}), scopes } : undefined;
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
 * How the chat box draws what is written in it: as the person's message will be drawn
 * @param {MacroValues} values the values of its macros
 * @returns {TextSetup}
 */
export function chatBoxSetup(values) {
    return chatSetup(null, 'chat-box', values);
}

/**
 * How a message's text, or its reasoning, is drawn in an editor opened in it: as the message draws it, with the values
 * the message is drawn with
 * @param {ChatMessage} message
 * @param {'message' | 'reasoning'} kind
 * @returns {{ setup: TextSetup, macroValue: (source: string) => string | null | undefined, macroValues: MacroValues, speaker: string }}
 */
export function messageEditorSetup(message, kind) {
    const speaker = speakerOf(message);
    const values = chatMacroValues(speaker);
    return { setup: chatSetup(speaker, kind, values), macroValue: values.valueOf, macroValues: values, speaker: speaker ?? '' };
}
