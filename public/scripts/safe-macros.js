// A leaf module: the app's substituteParams is passed in, so importing it never adds an import cycle.

const VALUE_START = '';
const RAW_START = '';
const PLACEHOLDER_END = '';
const VALUE_REGEX = new RegExp(`${VALUE_START}(\\d+)${PLACEHOLDER_END}`, 'g');
const RAW_REGEX = new RegExp(`${RAW_START}(\\d+)${PLACEHOLDER_END}`, 'g');

/**
 * Macros that read state and have no side effects and no randomness, so a preview may evaluate them on every redraw.
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
function isSafeMacro(macroText) {
    const opens = [...macroText.matchAll(/\{\{/g)];
    for (const open of opens) {
        const name = macroName(macroText.slice(open.index + 2));
        if (name === null || !isSafeMacroName(name)) return false;
    }
    return true;
}

/**
 * Replaces each top-level macro that isn't safe to run with a placeholder.
 * @param {string} text
 * @returns {{ masked: string, raws: string[] }}
 */
function maskUnsafeMacros(text) {
    /** @type {string[]} */
    const raws = [];
    let masked = '';
    let cursor = 0;
    for (const { start, end } of topLevelMacroSpans(text)) {
        const macroText = text.slice(start, end);
        if (isSafeMacro(macroText)) continue;
        masked += text.slice(cursor, start) + `${RAW_START}${raws.length}${PLACEHOLDER_END}`;
        raws.push(macroText);
        cursor = end;
    }
    masked += text.slice(cursor);
    return { masked, raws };
}

/**
 * @param {string} macroText One whole `{{…}}`.
 * @param {(content: string, options?: object) => string} substituteParams The app's substituteParams.
 * @param {object} [options] Extra substituteParams options.
 * @returns {string | null} Its value, or null when it isn't safe to run without being sent.
 */
export function evaluateSafeMacro(macroText, substituteParams, options = {}) {
    if (!/^\{\{[\s\S]*\}\}$/.test(macroText) || !isSafeMacro(macroText)) return null;
    return substituteParams(macroText, options);
}

/**
 * Plain text with only the safe macros evaluated and every other macro as written: for counting a field's tokens on
 * every change without running macros that have side effects or randomness.
 * @param {string} text
 * @param {(content: string, options?: object) => string} substituteParams The app's substituteParams.
 * @param {object} [options] Extra substituteParams options.
 * @returns {string}
 */
export function substituteSafeMacrosAsText(text, substituteParams, options = {}) {
    const { masked, raws } = maskUnsafeMacros(text);
    return substituteParams(masked, options).replace(RAW_REGEX, (_, index) => raws[Number(index)] ?? '');
}

/**
 * @typedef {import('./macro-pill.js').MacroShown} MacroShown
 */

/**
 * A macro's placeholder in text being rendered: survives markdown and sanitizing, and {@link insertMacroPlaceholders}
 * puts what shows the macro in its place.
 * @param {number} index
 */
function macroPlaceholder(index) {
    return `${VALUE_START}${index}${PLACEHOLDER_END}`;
}

/**
 * @param {object} options substituteParams options
 * @param {MacroShown[]} macros Gets each evaluated macro.
 */
function collecting(options, macros) {
    return {
        ...options,
        postProcessFn: (/** @type {string} */ value, /** @type {import('./macros/engine/MacroEnvBuilder.js').MacroIdentity | undefined} */ macro) => {
            macros.push({ source: macro?.source ?? '', name: macro?.name, category: macro?.category, value: String(value) });
            return macroPlaceholder(macros.length - 1);
        },
    };
}

/**
 * Evaluates every macro, leaving a placeholder where each goes, so the text can be rendered before
 * {@link insertMacroPlaceholders} puts them back.
 * @param {string} text
 * @param {(content: string, options: object) => string} substituteParams The app's substituteParams.
 * @param {object} [options] Extra substituteParams options.
 * @returns {{ text: string, macros: MacroShown[] }}
 */
export function substituteMacros(text, substituteParams, options = {}) {
    /** @type {MacroShown[]} */
    const macros = [];
    return { text: substituteParams(text, collecting(options, macros)), macros };
}

/**
 * Evaluates only the macros that are safe to run on every redraw of a preview; every other macro is kept as written,
 * with no value (null). Each comes back as a placeholder, so the text can be rendered before
 * {@link insertMacroPlaceholders} puts them back.
 * @param {string} text
 * @param {(content: string, options: object) => string} substituteParams The app's substituteParams.
 * @param {object} [options] Extra substituteParams options.
 * @returns {{ text: string, macros: MacroShown[] }}
 */
export function substituteSafeMacros(text, substituteParams, options = {}) {
    const { masked, raws } = maskUnsafeMacros(text);
    /** @type {MacroShown[]} */
    const macros = [];
    const substituted = substituteParams(masked, collecting(options, macros));
    const evaluated = macros.length;
    for (const source of raws) {
        macros.push({ source, name: macroName(source.slice(2)) ?? undefined, value: null });
    }
    return { text: substituted.replace(RAW_REGEX, (_, index) => macroPlaceholder(evaluated + Number(index))), macros };
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
