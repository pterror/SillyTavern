import { getMacroAutoCompleteAt } from '../autocomplete/MacroAutoCompleteHelper.js';
import { MACRO_AUTOCOMPLETE_MODE, shouldActivateMacroAutocomplete } from '../autocomplete/MacroAutoComplete.js';

/**
 * @typedef {import('@pterror/interact-editor/suggestions').Suggest} Suggest
 * @typedef {import('@pterror/interact-editor/suggestions').Option} Option
 * @typedef {import('@codemirror/view').EditorView} EditorView
 */

/** The whole text, as `read` gives it: positions past the end are clamped */
const END = Number.MAX_SAFE_INTEGER;

/**
 * Replaces a range with text and puts the cursor after it
 * @param {EditorView} view
 * @param {number} from
 * @param {number} to
 * @param {string} insert
 */
function put(view, from, to, insert) {
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.complete' });
}

/**
 * Macros after `{{`, from the macro registry
 * @param {(source: string) => string | null | undefined} valueOf a macro's value as the text has it: null when only
 *   known when sent, undefined when the text came without it
 * @param {import('../macro-pill.js').Translate} t
 * @returns {Suggest}
 */
export function macroSuggestions(valueOf, t) {
    return async (read, pos, explicit) => {
        const text = read(0, END);
        if (!shouldActivateMacroAutocomplete(text, pos, { isForced: explicit, autocompleteMode: MACRO_AUTOCOMPLETE_MODE.ALWAYS })) return undefined;
        const result = await getMacroAutoCompleteAt(text, pos, { isForced: explicit });
        if (!result) return undefined;
        const name = result.name ?? '';
        const from = result.start;
        const to = Math.max(pos, from + name.length);
        /** @type {Option[]} */
        const options = result.optionList.filter(option => option.isSelectable !== false).map((option) => {
            const replacer = option.valueProvider ? option.valueProvider(name) : option.value;
            return {
                label: option.name,
                ...(option.type ? { detail: String(option.type) } : {}),
                info: () => {
                    const box = document.createElement('div');
                    box.className = 'live-macro-info';
                    const details = option.renderDetails?.();
                    if (details) box.append(details);
                    const value = valueOf(`{{${option.name}}}`);
                    if (value !== undefined) {
                        const line = document.createElement('div');
                        line.className = 'live-macro-value';
                        line.textContent = value === null ? t`Runs when sent` : t`Now: ${value}`;
                        box.append(line);
                    }
                    return box;
                },
                apply: (view) => put(view, from + (option.replacementStartOffset ?? 0), to, String(replacer ?? option.name)),
            };
        });
        return options.length === 0 ? undefined : { from, to, options };
    };
}

/**
 * @typedef {{ name: string, start: number, optionList: any[], getSecondaryNameAt?: (text: string, index: number, isSelect: boolean) => any }} NameResult
 *   a name the slash command parser found at a position, and what it could be
 */

/**
 * Slash commands, their arguments and their values, from the slash command parser, in a text that starts with `/`
 * @param {() => { getNameAt: (text: string, index: number) => Promise<NameResult | null> }} parser
 * @param {(text: string) => boolean} wanted whether suggestions are shown for the text as typed (the autocomplete
 *   setting)
 * @returns {Suggest}
 */
export function slashSuggestions(parser, wanted) {
    return async (read, pos, explicit) => {
        const text = read(0, END);
        if (!text.startsWith('/') || !(explicit || wanted(text))) return undefined;
        let result = await parser().getNameAt(text, pos);
        if (result && pos > result.start + result.name.length && result.getSecondaryNameAt) {
            result = result.getSecondaryNameAt(text, pos, false) ?? null;
        }
        if (!result) return undefined;
        const name = result.name ?? '';
        const from = result.start;
        const to = Math.max(pos, from + name.length);
        /** @type {Option[]} */
        const options = result.optionList.filter(option => option.isSelectable !== false).map(option => ({
            label: option.name,
            ...(option.type ? { detail: String(option.type) } : {}),
            info: () => {
                const box = document.createElement('div');
                const details = option.renderDetails?.();
                if (details) box.append(details);
                return box;
            },
            apply: (/** @type {EditorView} */ view) => {
                const replacer = option.valueProvider ? option.valueProvider(name) : option.value;
                put(view, from + (option.replacementStartOffset ?? 0), to, String(replacer ?? option.name));
            },
        }));
        return options.length === 0 ? undefined : { from, to, options };
    };
}

const MENTIONABLE = ['user', 'char'];
const MENTION_BEFORE = /(?:^|[\s(["'*_])@[^\s@]*$/u;
const LINE_BEFORE = 200;

/**
 * People after `@`, written as the macro that names them
 * @param {(macroName: string) => import('../macro-pill.js').MacroPerson | null} person
 * @returns {Suggest}
 */
export function mentionSuggestions(person) {
    return (read, pos) => {
        const before = read(Math.max(0, pos - LINE_BEFORE), pos);
        const typed = MENTION_BEFORE.exec(before);
        if (!typed) return undefined;
        const at = pos - before.length + before.lastIndexOf('@');
        return {
            from: at + 1,
            to: pos,
            options: MENTIONABLE.map(macro => ({
                label: person(macro)?.name || macro,
                detail: `{{${macro}}}`,
                apply: (/** @type {EditorView} */ view, /** @type {number} */ _from, /** @type {number} */ to) => put(view, at, to, `{{${macro}}}`),
            })),
        };
    };
}
