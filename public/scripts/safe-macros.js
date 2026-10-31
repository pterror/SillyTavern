const VALUE_START = '\ue000';
const PLACEHOLDER_END = '\ue001';
const VALUE_REGEX = new RegExp(`${VALUE_START}(\\d+)${PLACEHOLDER_END}`, 'g');

export const TRIM_MACRO = /(?:\r?\n)*{{trim}}(?:\r?\n)*/gi;

const SAFE_MACRO_NAMES = new Set([
    'char', 'user', 'group', 'groupnotmuted', 'notchar', 'charifnotgroup',
    'description', 'chardescription', 'personality', 'charpersonality', 'scenario', 'charscenario',
    'persona', 'mesexamples', 'mesexamplesraw', 'charprompt', 'charinstruction', 'chardepthprompt',
    'charfirstmessage', 'charversion', 'char_version', 'charcreatornotes', 'creatornotes', 'systemprompt',
    'model', 'maxcontext', 'maxcontexttokens', 'maxprompt', 'maxprompttokens', 'maxresponse', 'maxresponsetokens',
    'newline', 'space', 'noop', 'trim', '//', 'original', 'input', 'ismobile',
    'lastmessage', 'lastmessageid', 'lastusermessage', 'lastcharmessage', 'firstincludedmessageid',
    'firstdisplayedmessageid', 'lastswipeid', 'currentswipeid', 'lastgenerationtype', 'allchatrange',
    'date', 'time', 'weekday', 'isodate', 'isotime', 'datetimeformat', 'idleduration', 'idle_duration', 'timediff',
    'getvar', 'getglobalvar', 'hasvar', 'hasglobalvar', 'getvarkey', 'getglobalvarkey', 'hasextension',
    'reverse', 'outlet',
]);

/**
 * @param {string} name
 * @returns {boolean}
 */
function isSafeMacroName(name) {
    const lower = name.toLowerCase();
    return SAFE_MACRO_NAMES.has(lower) || /^time_utc[-+]\d+$/.test(lower);
}

/**
 * @param {string} inner
 * @returns {string | null}
 */
function macroName(inner) {
    const body = inner.trimStart();
    if (body.startsWith('//')) return '//';
    if (/^[.$]/.test(body)) return null;
    const match = /^[#/!?~>]*\s*([^\s:{}|]+)/.exec(body);
    return match ? match[1] : null;
}

/**
 * @param {string} text
 * @returns {{ start: number, end: number }[]}
 */
export function topLevelMacroSpans(text) {
    /** @type {{ start: number, end: number }[]} */
    const spans = [];
    let depth = 0;
    let start = -1;
    for (let i = 0; i < text.length - 1; i++) {
        if (text[i] === '{' && text[i + 1] === '{') {
            if (depth === 0) start = i;
            depth++;
            i++;
        } else if (text[i] === '}' && text[i + 1] === '}' && depth > 0) {
            depth--;
            i++;
            if (depth === 0) spans.push({ start, end: i + 1 });
        }
    }
    return spans;
}

/**
 * @param {string} macroText
 * @returns {boolean}
 */
export function isSafeMacro(macroText) {
    const opens = [...macroText.matchAll(/\{\{/g)];
    for (const open of opens) {
        const name = macroName(macroText.slice(open.index + 2));
        if (name === null || !isSafeMacroName(name)) return false;
    }
    return true;
}

const MENTION_ABOUT = Object.freeze({ user: '{{persona}}', char: '{{charCreatorNotes}}', charifnotgroup: '{{charCreatorNotes}}' });

/**
 * @param {string} macroName
 * @returns {string | undefined}
 */
export function mentionAboutMacro(macroName) {
    return MENTION_ABOUT[/** @type {keyof typeof MENTION_ABOUT} */ (macroName.toLowerCase())];
}

/**
 * @template {{ about: string }} P
 * @param {P | null} person
 * @param {string} macroName
 * @param {MacroValueOf} valueOf
 * @returns {P | null}
 */
export function withFilledAbout(person, macroName, valueOf) {
    if (!person) return person;
    const source = mentionAboutMacro(macroName);
    const about = source ? valueOf(source) : undefined;
    return { ...person, about: typeof about === 'string' ? about : '' };
}

/**
 * @typedef {import('./macro-pill.js').MacroShown} MacroShown
 * @typedef {(source: string) => string | null | undefined} MacroValueOf
 */

/**
 * @param {string} text
 * @returns {string[]}
 */
export function macrosIn(text) {
    const trimmed = text.replace(TRIM_MACRO, '');
    return topLevelMacroSpans(trimmed).map(({ start, end }) => trimmed.slice(start, end));
}

/**
 * @param {string} text
 * @param {MacroValueOf} valueOf
 * @returns {{ text: string, macros: MacroShown[] }}
 */
export function withMacroPlaceholders(text, valueOf) {
    const trimmed = text.replace(TRIM_MACRO, '');
    /** @type {MacroShown[]} */
    const macros = [];
    let out = '';
    let cursor = 0;
    for (const { start, end } of topLevelMacroSpans(trimmed)) {
        const source = trimmed.slice(start, end);
        out += trimmed.slice(cursor, start) + `${VALUE_START}${macros.length}${PLACEHOLDER_END}`;
        macros.push({ source, name: macroName(source.slice(2)) ?? undefined, value: valueOf(source) ?? null });
        cursor = end;
    }
    return { text: out + trimmed.slice(cursor), macros };
}

/**
 * @param {string} text
 * @param {MacroValueOf} valueOf
 * @returns {string}
 */
export function withMacroValues(text, valueOf) {
    const trimmed = text.replace(TRIM_MACRO, '');
    let out = '';
    let cursor = 0;
    for (const { start, end } of topLevelMacroSpans(trimmed)) {
        const source = trimmed.slice(start, end);
        out += trimmed.slice(cursor, start) + (valueOf(source) ?? source);
        cursor = end;
    }
    return out + trimmed.slice(cursor);
}

/**
 * @param {string} html
 * @param {(index: number) => string} render
 * @returns {string}
 */
export function insertMacroPlaceholders(html, render) {
    return html.replace(VALUE_REGEX, (_, index) => render(Number(index)));
}
