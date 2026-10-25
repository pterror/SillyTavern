// The editor's toolbar and formatting keys. The keys insert the same characters as the app's markdown hotkeys
// (input-md-formatting.js) do in a plain textarea.

import { state as cmState, view as cmView, language as cmLanguage } from '../../live-editor-lib.js';
import { t } from '../i18n.js';
import { power_user } from '../power-user.js';
import { hasLiveMacros, toggleMacroSource } from './macros.js';
import { hasPresets, showPresets } from './search.js';

const { EditorSelection, Facet } = cmState;
const { keymap, showPanel } = cmView;
const { ensureSyntaxTree, syntaxTree } = cmLanguage;

/**
 * @typedef {object} FormattingOptions
 * @property {() => boolean} [hotkeysEnabled] Whether the markdown keys are on; the user's setting by default.
 * @property {(file: File) => Promise<string>} [uploadImage] Uploads an image and gives its URL; without it there's no
 *   image button.
 */

const formattingOptions = Facet.define({
    combine: values => values[0] ?? {},
});

/**
 * The innermost `nodeName` (marked with one of `marks`) that holds the whole range, read from the syntax tree, so
 * italics aren't mistaken for half of bold (`**x**` holds `*x*`) and the marks are found wherever the cursor is in it.
 * @param {import('@codemirror/state').EditorState} state
 * @param {number} from
 * @param {number} to
 * @param {string} nodeName
 * @param {string[]} marks
 * @returns {{ open: { from: number, to: number }, close: { from: number, to: number } } | null}
 */
function formattingAround(state, from, to, nodeName, marks) {
    const tree = ensureSyntaxTree(state, to, 50) ?? syntaxTree(state);
    for (let node = tree.resolveInner(from, 1); node; node = node.parent) {
        if (node.name !== nodeName || node.from > from || node.to < to) continue;
        const open = node.firstChild;
        const close = node.lastChild;
        if (!open || !close || open.from === close.from || !open.name.endsWith('Mark') || !close.name.endsWith('Mark')) continue;
        const mark = state.sliceDoc(open.from, open.to);
        if (marks.includes(mark) && state.sliceDoc(close.from, close.to) === mark) {
            return { open: { from: open.from, to: open.to }, close: { from: close.from, to: close.to } };
        }
    }
    return null;
}

/**
 * Wraps the selection in `chars`, or unwraps the formatting it's in when it's already that formatting; with no
 * selection, the word around the cursor, or an empty pair at the cursor. The app's textarea markdown hotkeys wrap
 * the same way; whether the text already has the formatting is read from the syntax tree.
 * @param {string} chars
 * @param {string} nodeName The syntax node of this formatting.
 * @param {string[]} [marks] The marks that make it (`*` and `_` both make italics); `chars` by default.
 * @returns {import('@codemirror/view').Command}
 */
function toggleWrap(chars, nodeName, marks = [chars]) {
    return (view) => {
        const { state } = view;
        const doc = state.doc.toString();
        const transaction = state.changeByRange((range) => {
            let { from, to } = range;
            const existing = formattingAround(state, from, to, nodeName, marks);
            if (existing) {
                const { open, close } = existing;
                const openLength = open.to - open.from;
                // Where a position ends up once both marks are gone.
                const map = (/** @type {number} */ pos) => {
                    if (pos <= open.from) return pos;
                    if (pos <= open.to) return open.from;
                    if (pos <= close.from) return pos - openLength;
                    if (pos <= close.to) return close.from - openLength;
                    return pos - openLength - (close.to - close.from);
                };
                return {
                    changes: [{ from: open.from, to: open.to }, { from: close.from, to: close.to }],
                    range: EditorSelection.range(map(range.anchor), map(range.head)),
                };
            }
            if (from !== to) {
                const selected = doc.slice(from, to);
                let text = selected;
                let space = '';
                if (text.endsWith(' ')) {
                    text = text.slice(0, -1);
                    space = ' ';
                    to--;
                }
                return {
                    changes: { from, to: to + space.length, insert: chars + text + chars + space },
                    range: EditorSelection.range(from + chars.length, from + chars.length + text.length),
                };
            }
            const before = doc.slice(from - 1, from);
            const after = doc.slice(to, to + 1);
            if (before !== ' ' && after !== ' ' && before !== '' && after !== '' && before !== '\n' && after !== '\n') {
                let start = from - 1;
                let end = to + 1;
                while (start > 0 && !/[ \n]/.test(doc[start - 1])) start--;
                while (end < doc.length && !/[ \n]/.test(doc[end])) end++;
                const found = doc.slice(start, end);
                return {
                    changes: { from: start, to: end, insert: chars + found + chars },
                    range: EditorSelection.cursor(from + chars.length),
                };
            }
            return {
                changes: { from, insert: chars + chars },
                range: EditorSelection.cursor(from + chars.length),
            };
        });
        view.dispatch(state.update(transaction, { scrollIntoView: true, userEvent: 'input.format' }));
        return true;
    };
}

/**
 * @param {import('@codemirror/view').Command} command
 * @returns {import('@codemirror/view').Command}
 */
const whenHotkeysOn = command => (view) => {
    const { hotkeysEnabled } = view.state.facet(formattingOptions);
    return (hotkeysEnabled ? hotkeysEnabled() : power_user.enable_md_hotkeys) ? command(view) : false;
};

const bold = toggleWrap('**', 'StrongEmphasis');
const italic = toggleWrap('*', 'Emphasis', ['*', '_']);
const underline = toggleWrap('__', 'StrongEmphasis');
const code = toggleWrap('`', 'InlineCode');
const strikethrough = toggleWrap('~~', 'Strikethrough');

/** @type {import('@codemirror/view').Command} */
function link(view) {
    const { state } = view;
    const transaction = state.changeByRange((range) => {
        const text = state.sliceDoc(range.from, range.to) || t`text`;
        const insert = `[${text}](url)`;
        const urlFrom = range.from + text.length + 3;
        return {
            changes: { from: range.from, to: range.to, insert },
            range: EditorSelection.range(urlFrom, urlFrom + 3),
        };
    });
    view.dispatch(state.update(transaction, { scrollIntoView: true, userEvent: 'input.format' }));
    view.focus();
    return true;
}

const BLOCK_PREFIX = /^(?: {0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+))/;

/**
 * Sets the block type of the lines the selection touches: a paragraph (no prefix), a heading, a quote or a list item,
 * or wraps them in a code block.
 * @param {'paragraph'|'h1'|'h2'|'h3'|'quote'|'list'|'code'} type
 * @returns {import('@codemirror/view').Command}
 */
function setBlockType(type) {
    return (view) => {
        const { state } = view;
        const range = state.selection.main;
        const first = state.doc.lineAt(range.from);
        const last = state.doc.lineAt(range.to);
        if (type === 'code') {
            const body = state.sliceDoc(first.from, last.to);
            view.dispatch({
                changes: { from: first.from, to: last.to, insert: '```\n' + body + '\n```' },
                selection: { anchor: first.from + 4, head: first.from + 4 + body.length },
                userEvent: 'input.format',
            });
            view.focus();
            return true;
        }
        const prefix = { paragraph: '', h1: '# ', h2: '## ', h3: '### ', quote: '> ', list: '- ' }[type];
        /** @type {{ from: number, to: number, insert: string }[]} */
        const changes = [];
        for (let n = first.number; n <= last.number; n++) {
            const line = state.doc.line(n);
            const existing = BLOCK_PREFIX.exec(line.text)?.[0] ?? '';
            changes.push({ from: line.from, to: line.from + existing.length, insert: prefix });
        }
        view.dispatch({ changes, userEvent: 'input.format' });
        view.focus();
        return true;
    };
}

/**
 * Picks an image, puts a placeholder where the cursor is, uploads the image and puts its markdown in place of the
 * placeholder. A failed upload takes the placeholder away and says why.
 * @param {import('@codemirror/view').EditorView} view
 */
function insertImage(view) {
    const { uploadImage } = view.state.facet(formattingOptions);
    if (!uploadImage) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        const placeholder = `![${t`Uploading ${file.name}…`}]()`;
        const at = view.state.selection.main.head;
        view.dispatch({ changes: { from: at, insert: placeholder }, userEvent: 'input.format' });
        /** Where the placeholder is now: the text around it may have changed while uploading. */
        const find = () => {
            const index = view.state.doc.toString().indexOf(placeholder);
            return index === -1 ? null : { from: index, to: index + placeholder.length };
        };
        try {
            const url = await uploadImage(file);
            const spot = find();
            if (spot) {
                const markdown = `![${file.name}](${url})`;
                view.dispatch({ changes: { ...spot, insert: markdown }, selection: { anchor: spot.from + markdown.length }, userEvent: 'input.format' });
            }
        } catch (error) {
            const spot = find();
            if (spot) view.dispatch({ changes: { ...spot, insert: '' }, userEvent: 'input.format' });
            toastr.error(String(error?.message ?? error), t`The image could not be uploaded`);
        }
    });
    input.click();
}

/**
 * @param {import('@codemirror/view').EditorView} view
 * @returns {import('@codemirror/view').Panel}
 */
function toolbarPanel(view) {
    const dom = document.createElement('div');
    dom.className = 'live-toolbar';
    dom.setAttribute('role', 'toolbar');
    dom.setAttribute('aria-label', t`Formatting`);

    const blockType = document.createElement('select');
    blockType.className = 'live-toolbar-block text_pole';
    blockType.setAttribute('aria-label', t`Block type`);
    for (const [value, label] of [
        ['', t`Block type`], ['paragraph', t`Paragraph`], ['h1', t`Heading 1`], ['h2', t`Heading 2`],
        ['h3', t`Heading 3`], ['quote', t`Quote`], ['list', t`List`], ['code', t`Code block`],
    ]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        blockType.append(option);
    }
    blockType.addEventListener('change', () => {
        const value = /** @type {any} */ (blockType.value);
        blockType.value = '';
        if (value) setBlockType(value)(view);
    });
    dom.append(blockType);

    /**
     * @param {string} icon
     * @param {string} label
     * @param {(view: import('@codemirror/view').EditorView) => any} run
     */
    const button = (icon, label, run) => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = `live-toolbar-button menu_button fa-solid ${icon}`;
        el.title = label;
        el.setAttribute('aria-label', label);
        // Keep the editor's selection: the button shouldn't take focus on press.
        el.addEventListener('mousedown', event => event.preventDefault());
        el.addEventListener('click', () => {
            run(view);
            view.focus();
        });
        dom.append(el);
    };
    button('fa-italic', t`Italic (Ctrl+I)`, italic);
    button('fa-bold', t`Bold (Ctrl+B)`, bold);
    button('fa-link', t`Link`, link);
    button('fa-code', t`Code (Ctrl+K)`, code);
    if (view.state.facet(formattingOptions).uploadImage) {
        button('fa-image', t`Image`, insertImage);
    }
    if (hasLiveMacros(view.state)) {
        button('fa-file-code', t`Show macros as written (Ctrl+Shift+M)`, toggleMacroSource);
    }
    if (hasPresets(view.state)) {
        button('fa-wand-magic-sparkles', t`Find and replace presets`, v => showPresets(v));
    }
    return { dom, top: true };
}

/**
 * @param {FormattingOptions} [options]
 * @returns {import('@codemirror/state').Extension}
 */
export function liveFormatting(options = {}) {
    return [
        formattingOptions.of(options),
        showPanel.of(toolbarPanel),
        keymap.of([
            { key: 'Mod-b', run: whenHotkeysOn(bold) },
            { key: 'Mod-i', run: whenHotkeysOn(italic) },
            { key: 'Mod-u', run: whenHotkeysOn(underline) },
            { key: 'Mod-k', run: whenHotkeysOn(code) },
            { key: 'Mod-Shift-`', run: whenHotkeysOn(strikethrough) },
            { key: 'Mod-Shift-~', run: whenHotkeysOn(strikethrough) },
        ]),
    ];
}
