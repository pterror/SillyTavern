import { view as cmView } from '../../live-editor-lib.js';
import { unclippedSpace } from '../util/unclipped-space.js';

const { tooltips } = cmView;

/**
 * An editor's tooltips (its suggestions) placed in the space no element around it clips
 * @returns {import('@codemirror/state').Extension}
 */
export function editorTooltips() {
    return tooltips({ tooltipSpace: view => unclippedSpace(view.dom) });
}
