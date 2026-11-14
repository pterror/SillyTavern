import { view as cmView } from '../../live-editor-lib.js';
import { OVERLAYS_CHANGED_EVENT } from '../drawer-stack.js';
import { unclippedSpace } from '../util/unclipped-space.js';

const { tooltips, showTooltip, ViewPlugin } = cmView;

/** Says to the drawer stack that the overlays in the page changed, once the editor has drawn its tooltips */
const announced = ViewPlugin.fromClass(class {
    /** @param {import('@codemirror/view').ViewUpdate} update */
    update(update) {
        if (update.state.facet(showTooltip) === update.startState.facet(showTooltip)) return;
        update.view.requestMeasure({ key: this, read: () => null, write: () => document.dispatchEvent(new Event(OVERLAYS_CHANGED_EVENT)) });
    }

    destroy() {
        document.dispatchEvent(new Event(OVERLAYS_CHANGED_EVENT));
    }
});

/**
 * An editor's tooltips (its suggestions) placed in the space no element around it clips, and announced to the drawer
 * stack as overlays
 * @returns {import('@codemirror/state').Extension}
 */
export function editorTooltips() {
    return [tooltips({ tooltipSpace: view => unclippedSpace(view.dom) }), announced];
}
