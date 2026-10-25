// How a macro is shown wherever it is shown (the live editor, a field's preview): as a pill holding what is sent in its
// place, never as its `{{…}}` text, so nothing on screen reads as if the braces were sent. The source is in its tooltip.
// A leaf module: the app's translation is passed in and the macro registry gives its categories
// (setMacroCategories()), so importing it never adds an import cycle.

import { insertMacroPlaceholders } from './safe-macros.js';

/** @typedef {(strings: TemplateStringsArray, ...values: any[]) => string} Translate */

/** @type {(name: string) => string | undefined} A macro's category, by its name: the registry's, once it is loaded. */
let categoryOf = () => undefined;

/**
 * Called by the macro registry: how a macro's category is found from its name.
 * @param {(name: string) => string | undefined} lookup
 */
export function setMacroCategories(lookup) {
    categoryOf = lookup;
}

/** The most of a value or a macro's description a pill in the editor shows; its tooltip has all of it. */
const SHOWN_LENGTH = 24;
/** The most of a value a tooltip shows. */
const TOOLTIP_VALUE_LENGTH = 200;

/** Each category's icon (macros/engine/MacroRegistry.js MacroCategory). Names are mentions: `@` instead. */
const CATEGORY_ICONS = Object.freeze({
    character: 'fa-id-card',
    chat: 'fa-comments',
    time: 'fa-clock',
    random: 'fa-dice',
    variable: 'fa-cube',
    state: 'fa-sliders',
    prompts: 'fa-scroll',
});
const DEFAULT_ICON = 'fa-code';
/** The macros that are one person's name: shown as a mention of them. */
const MENTIONS = new Set(['user', 'char', 'charifnotgroup']);

/**
 * @typedef {object} MacroShown A macro as a pill shows it.
 * @property {string} source Its `{{…}}` text.
 * @property {string} [name] Its name.
 * @property {string} [category] Its category in the registry, if it is registered.
 * @property {string | null} value What is sent in its place; null when it is worked out only when sent.
 */

/**
 * @param {string} text
 * @param {number} length
 */
function shorten(text, length) {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

/**
 * A macro's text without its braces, its arguments set apart: `{{random::a::b}}` is `random · a · b`.
 * @param {string} source
 */
function describe(source) {
    return source.replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '').split('::').map(part => part.trim()).filter(Boolean).join(' · ');
}

/**
 * What a pill says, and what its tooltip says. `compact`: a value is shortened (the editor's pills); a name never is.
 * @param {MacroShown} macro
 * @param {Translate} t
 * @param {boolean} [compact]
 * @returns {{ kind: 'mention' | 'value' | 'empty' | 'later', label: string, icon: string | null, tooltip: string }}
 */
export function macroPillContent({ source, name, category, value }, t, compact = false) {
    const icon = CATEGORY_ICONS[/** @type {keyof typeof CATEGORY_ICONS} */ (category)] ?? DEFAULT_ICON;
    if (value === null) {
        return { kind: 'later', label: shorten(describe(source), SHOWN_LENGTH), icon, tooltip: t`${source} is filled in when the message is sent. The model never sees ${source}.` };
    }
    if (value.trim() === '') {
        return { kind: 'empty', label: shorten(describe(source), SHOWN_LENGTH), icon, tooltip: t`${source} sends nothing in its place.` };
    }
    const tooltip = t`${source} is replaced by “${shorten(value, TOOLTIP_VALUE_LENGTH)}” before sending. The model never sees ${source}.`;
    if (MENTIONS.has(name?.toLowerCase() ?? '')) {
        return { kind: 'mention', label: `@${value}`, icon: null, tooltip };
    }
    return { kind: 'value', label: compact ? shorten(value, SHOWN_LENGTH) : value, icon, tooltip };
}

/**
 * A macro's pill. The editor's is `compact` (macroPillContent()) and has no title: it shows its own tooltip.
 * @param {MacroShown} macro
 * @param {{ t: Translate, compact?: boolean }} options
 * @returns {HTMLElement}
 */
export function macroPill(macro, { t, compact = false }) {
    macro = { ...macro, category: macro.category ?? (macro.name ? categoryOf(macro.name) : undefined) };
    const { kind, label, icon, tooltip } = macroPillContent(macro, t, compact);
    const pill = document.createElement('span');
    pill.className = `macro-pill macro-pill-${kind}`;
    if (macro.category) pill.dataset.macroCategory = macro.category;
    if (macro.name) pill.dataset.macroName = macro.name;
    if (!compact) pill.title = tooltip;
    if (icon) {
        const i = document.createElement('i');
        i.className = `macro-pill-icon fa-solid ${icon}`;
        i.setAttribute('aria-hidden', 'true');
        pill.append(i);
    }
    pill.append(label);
    return pill;
}

/**
 * Puts each macro's pill in place of its placeholder (safe-macros.js) in rendered HTML.
 * @param {string} html
 * @param {MacroShown[]} macros
 * @param {Translate} t
 * @returns {string}
 */
export function insertMacroPills(html, macros, t) {
    return insertMacroPlaceholders(html, index => (macros[index] ? macroPill(macros[index], { t }).outerHTML : ''));
}
