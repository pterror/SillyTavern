// Which macros a preview may fill in, and the text it renders with each macro's value in its place. The values come
// from the server (macro-values.js), which fills in the prompts too. A leaf module, so importing it never adds an
// import cycle; the server imports it as well.

const VALUE_START = '\ue000';
const PLACEHOLDER_END = '\ue001';
const VALUE_REGEX = new RegExp(`${VALUE_START}(\\d+)${PLACEHOLDER_END}`, 'g');

/**
 * {{trim}} with the line breaks either side of it, which the macro engine removes once the other macros are filled in
 * (it reaches outside its own braces). A preview removes it first.
 */
export const TRIM_MACRO = /(?:\r?\n)*{{trim}}(?:\r?\n)*/gi;

/**
 * Macros that read state and have no side effects and no randomness, so a preview may fill them in on every redraw.
 * Lowercase. Anything else, built-in or from an extension, is shown as written.
 */
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
 * The name a macro's text starts with: `{{ name::args }}`, `{{name:arg}}`, `{{name args}}`. Variable shorthand
 * (`{{.x}}`, `{{$x}}`) has no name.
 * @param {string} inner The text between `{{` and `}}`.
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
 * The top-level `{{…}}` spans of a text, nested macros inside each.
 * @param {string} text
 * @returns {{ start: number, end: number }[]} `end` is exclusive.
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
 * Whether a macro and every macro nested in it may be evaluated.
 * @param {string} macroText The whole `{{…}}`.
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

/** For each mention, the macro whose value is its card's text: who it names' description, its macros filled in. */
const MENTION_ABOUT = Object.freeze({ user: '{{persona}}', char: '{{description}}', charifnotgroup: '{{description}}' });

/**
 * @param {string} macroName
 * @returns {string | undefined} The macro whose value is the card text of the mention by that name.
 */
export function mentionAboutMacro(macroName) {
    return MENTION_ABOUT[/** @type {keyof typeof MENTION_ABOUT} */ (macroName.toLowerCase())];
}

/**
 * Who a mention names, their description as filled in (its macros' values); none until it is known.
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
 * @typedef {(source: string) => string | null | undefined} MacroValueOf A macro's value by its `{{…}}`: null when it
 * is filled in only when sent, undefined when it isn't known yet. Either is shown as written.
 */

/**
 * The top-level macros of a text, as a preview fills them in.
 * @param {string} text
 * @returns {string[]} Each one's `{{…}}`.
 */
export function macrosIn(text) {
    const trimmed = text.replace(TRIM_MACRO, '');
    return topLevelMacroSpans(trimmed).map(({ start, end }) => trimmed.slice(start, end));
}

/**
 * The text with a placeholder where each top-level macro was, which survives markdown and sanitizing, so it can be
 * rendered before {@link insertMacroPlaceholders} puts what shows each macro in its place.
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
 * Plain text with each macro's value in its place, and every macro with none as written: for counting a field's
 * tokens.
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
 * Puts what `render` gives for each macro in place of its placeholder.
 * @param {string} html
 * @param {(index: number) => string} render
 * @returns {string}
 */
export function insertMacroPlaceholders(html, render) {
    return html.replace(VALUE_REGEX, (_, index) => render(Number(index)));
}
