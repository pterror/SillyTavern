import { DOMPurify } from '../lib.js';
import { insertMacroPlaceholders } from './safe-macros.js';
import { renderMarkdown } from './marked-processor.js';

/** @typedef {(strings: TemplateStringsArray, ...values: any[]) => string} Translate */

/**
 * @typedef {object} MacroRegistryView
 * @property {(name: string) => string | undefined} categoryOf
 * @property {() => { name: string, category: string | undefined }[]} list
 */

/** @type {MacroRegistryView} */
let registry = { categoryOf: () => undefined, list: () => [] };

/**
 * @param {MacroRegistryView} view
 */
export function setMacroRegistry(view) {
    registry = view;
}

/** @returns {{ name: string, category: string | undefined }[]} */
export function registeredMacros() {
    return registry.list();
}

/**
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

const SHOWN_LENGTH = 24;
const TOOLTIP_VALUE_LENGTH = 200;
const ABOUT_LENGTH = 600;
const ABOUT_TAGS = ['p', 'br', 'em', 'strong', 'del', 's', 'code', 'q', 'b', 'i', 'u', 'sub', 'sup', 'mark', 'small', 'span'];

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
const MENTIONS = new Set(['user', 'char', 'charifnotgroup']);

/**
 * @typedef {object} MacroShown
 * @property {string} source
 * @property {string} [name]
 * @property {string} [category]
 * @property {string | null} value
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
 * @param {string} source
 */
function describe(source) {
    return source.replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '').split('::').map(part => part.trim()).filter(Boolean).join(' · ');
}

/**
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
        return { kind: 'mention', label: value, icon: null, note: '' };
    }
    const label = compact ? shorten(value, SHOWN_LENGTH) : value;
    return { kind: 'value', label, icon, note: label === value ? '' : shorten(value, TOOLTIP_VALUE_LENGTH) };
}

/**
 * @param {MacroShown} macro
 * @param {{ t: Translate, compact?: boolean, person?: MacroPerson | null }} options
 * @returns {Record<string, string>}
 */
export function macroTooltipAttributes(macro, { t, compact = false, person = null }) {
    const { kind, note } = macroPillContent(macro, t, compact);
    return {
        ...macroColorAttributes(macro.name, macro.category),
        'data-macro-source': macro.source,
        ...(note ? { 'data-macro-note': note } : {}),
        ...(kind === 'mention' && person ? { 'data-macro-person': JSON.stringify({ ...person, about: shorten(person.about, ABOUT_LENGTH) }) } : {}),
    };
}

/**
 * @param {MacroShown} macro
 * @param {{ t: Translate, compact?: boolean, person?: MacroPerson | null }} options
 * @returns {HTMLElement}
 */
export function macroPill(macro, { t, compact = false, person = null }) {
    macro = { ...macro, category: macro.category ?? (macro.name ? registry.categoryOf(macro.name) : undefined) };
    const { kind, label, icon } = macroPillContent(macro, t, compact);
    const pill = document.createElement('span');
    pill.className = `macro-pill macro-pill-${kind}`;
    for (const [attribute, value] of Object.entries(macroTooltipAttributes(macro, { t, compact, person }))) pill.setAttribute(attribute, value);
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
 * @typedef {object} MacroPerson
 * @property {string} name
 * @property {string} avatarUrl
 * @property {string} about
 */

/**
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
        about.innerHTML = DOMPurify.sanitize(renderMarkdown(person.about), { ALLOWED_TAGS: ABOUT_TAGS, ALLOWED_ATTR: [] });
        text.append(about);
    }
    card.append(avatar, text);
    return card;
}

/**
 * @param {string} html
 * @param {MacroShown[]} macros
 * @param {Translate} t
 * @param {(macroName: string) => MacroPerson | null} [person]
 * @returns {string}
 */
export function insertMacroPills(html, macros, t, person) {
    return insertMacroPlaceholders(html, (index) => {
        const macro = macros[index];
        if (!macro) return '';
        return macroPill(macro, { t, person: macro.name ? person?.(macro.name) : null }).outerHTML;
    });
}
