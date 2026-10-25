// How a macro is shown wherever it is shown (the live editor, a field's preview): as a pill holding what is sent in its
// place, never as its `{{…}}` text, so nothing on screen reads as if the braces were sent. The source is in its tooltip.
// A leaf module: the app's translation is passed in and the macro registry tells it about the macros
// (setMacroRegistry()), so importing it never adds an import cycle.

import { insertMacroPlaceholders } from './safe-macros.js';

/** @typedef {(strings: TemplateStringsArray, ...values: any[]) => string} Translate */

/**
 * @typedef {object} MacroRegistryView What the pills need of the macro registry.
 * @property {(name: string) => string | undefined} categoryOf A macro's category, by its name.
 * @property {() => { name: string, category: string | undefined }[]} list Every macro a user may write.
 */

/** @type {MacroRegistryView} The registry's, once it is loaded. */
let registry = { categoryOf: () => undefined, list: () => [] };

/**
 * Called by the macro registry as it loads.
 * @param {MacroRegistryView} view
 */
export function setMacroRegistry(view) {
    registry = view;
}

/** @returns {{ name: string, category: string | undefined }[]} Every macro a user may write. */
export function registeredMacros() {
    return registry.list();
}

/**
 * The attributes of an element showing a macro (a pill, the macro opened as written, its tooltip): its name gives it
 * the macro's color (macro-colors.js, style.css), its category its icon.
 * @param {string | undefined} name
 * @param {string | undefined} category
 * @returns {Record<string, string>}
 */
export function macroColorAttributes(name, category) {
    category ??= name ? registry.categoryOf(name) : undefined;
    return {
        ...(category ? { 'data-macro-category': category } : {}),
        ...(name ? { 'data-macro-name': name } : {}),
    };
}

/** The most of a value or a macro's description a pill in the editor shows; its tooltip has all of it. */
const SHOWN_LENGTH = 24;
/** The most of a shortened value its tooltip shows. */
const TOOLTIP_VALUE_LENGTH = 200;

/** Each category's icon (macros/engine/MacroRegistry.js MacroCategory). One person's name is a mention: `@` instead. */
const CATEGORY_ICONS = Object.freeze({
    names: 'fa-user',
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
 * What a pill says, and the note its tooltip adds under the macro's source ('' when the pill says it all).
 * `compact`: a value is shortened (the editor's pills), its note then the whole of it; a name never is.
 * @param {MacroShown} macro
 * @param {Translate} t
 * @param {boolean} [compact]
 * @returns {{ kind: 'mention' | 'value' | 'empty' | 'later', label: string, icon: string | null, note: string }}
 */
export function macroPillContent({ source, name, category, value }, t, compact = false) {
    const icon = CATEGORY_ICONS[/** @type {keyof typeof CATEGORY_ICONS} */ (category)] ?? DEFAULT_ICON;
    if (value === null) {
        return { kind: 'later', label: shorten(describe(source), SHOWN_LENGTH), icon, note: t`Filled in when sent` };
    }
    if (value.trim() === '') {
        return { kind: 'empty', label: shorten(describe(source), SHOWN_LENGTH), icon, note: t`Sends nothing` };
    }
    if (MENTIONS.has(name?.toLowerCase() ?? '')) {
        return { kind: 'mention', label: `@${value}`, icon: null, note: '' };
    }
    const label = compact ? shorten(value, SHOWN_LENGTH) : value;
    return { kind: 'value', label, icon, note: label === value ? '' : shorten(value, TOOLTIP_VALUE_LENGTH) };
}

/**
 * A macro's pill. The editor's is `compact` (macroPillContent()) and has no title: it shows its own tooltip.
 * @param {MacroShown} macro
 * @param {{ t: Translate, compact?: boolean }} options
 * @returns {HTMLElement}
 */
export function macroPill(macro, { t, compact = false }) {
    macro = { ...macro, category: macro.category ?? (macro.name ? registry.categoryOf(macro.name) : undefined) };
    const { kind, label, icon, note } = macroPillContent(macro, t, compact);
    const pill = document.createElement('span');
    pill.className = `macro-pill macro-pill-${kind}`;
    for (const [attribute, value] of Object.entries(macroColorAttributes(macro.name, macro.category))) pill.setAttribute(attribute, value);
    if (!compact) pill.title = note ? `${macro.source}\n${note}` : macro.source;
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
 * @typedef {object} MacroPerson Who a mention ({{user}}, {{char}}) names.
 * @property {string} name
 * @property {string} avatarUrl
 * @property {string} about Their description (the persona's, the character's).
 */

/** The most of who a mention names' description its card shows. */
const ABOUT_LENGTH = 240;

/**
 * A mention's card: who it names, with their avatar and description, and the macro it is written as.
 * @param {MacroPerson} person
 * @param {string} source
 * @returns {HTMLElement}
 */
export function macroPersonCard(person, source) {
    const card = document.createElement('div');
    card.className = 'macro-person-card';
    const avatar = document.createElement('img');
    avatar.className = 'macro-person-avatar';
    avatar.src = person.avatarUrl;
    avatar.alt = '';
    const text = document.createElement('div');
    text.className = 'macro-person-text';
    const name = document.createElement('div');
    name.className = 'macro-person-name';
    name.textContent = person.name;
    const code = document.createElement('code');
    code.textContent = source;
    text.append(name, code);
    if (person.about.trim()) {
        const about = document.createElement('div');
        about.className = 'macro-person-about';
        about.textContent = shorten(person.about, ABOUT_LENGTH);
        text.append(about);
    }
    card.append(avatar, text);
    return card;
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
