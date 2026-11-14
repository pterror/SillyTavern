import { view as cmView } from '../../live-editor-lib.js';

const { EditorView } = cmView;

/**
 * The caret and selection drawn in the text's own colour, so they follow the theme. CodeMirror's base theme draws a
 * black caret.
 * @returns {import('@codemirror/state').Extension}
 */
export function caretInTextColor() {
    return EditorView.theme({
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'currentColor' },
        '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
            background: 'color-mix(in srgb, Highlight 55%, transparent)',
        },
    });
}
