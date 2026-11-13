import { view as cmView } from '../../live-editor-lib.js';

const { EditorView } = cmView;

/**
 * An editor that grows with its text up to a height, and scrolls inside past it
 * @param {string} maxHeight a CSS length
 * @returns {import('@codemirror/state').Extension}
 */
export function boxSize(maxHeight) {
    return EditorView.theme({ '&': { maxHeight }, '.cm-scroller': { overflow: 'auto' } });
}
