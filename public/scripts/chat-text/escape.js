import { autocomplete as cmAutocomplete, state as cmState, view as cmView } from '../../live-editor-lib.js';

const { completionStatus, closeCompletion } = cmAutocomplete;
const { Prec } = cmState;
const { keymap } = cmView;

/**
 * Escape is the page's while suggestions are only being asked for, none shown: CodeMirror would take it to stop the
 * asking, so an Escape right after typing would do nothing the person can see
 * @returns {import('@codemirror/state').Extension}
 */
export function escapePastPendingSuggestions() {
    return Prec.highest(keymap.of([{
        key: 'Escape',
        run(view) {
            if (completionStatus(view.state) === 'pending') closeCompletion(view);
            return false;
        },
    }]));
}
