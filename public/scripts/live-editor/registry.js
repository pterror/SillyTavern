export const EDITOR_ESCAPE_TAKERS = '.cm-tooltip-autocomplete, .cm-panels .cm-search, .cm-panels .live-presets, .live-paste-picker';

/** @type {WeakMap<Element, HTMLTextAreaElement>} */
const mounted = new WeakMap();

/**
 * @typedef {object} MountedEditorInfo
 * @property {Element} root
 * @property {() => DOMRect | null} caretRect
 * @property {boolean} macroSuggestions
 */

/** @type {WeakMap<HTMLTextAreaElement, MountedEditorInfo>} */
const byTextarea = new WeakMap();

/** @type {WeakSet<Event>} */
const editorEvents = new WeakSet();

/**
 * @param {Element} editorRoot
 * @param {HTMLTextAreaElement} textarea
 * @param {Omit<MountedEditorInfo, 'root'>} info
 */
export function registerMountedEditor(editorRoot, textarea, info) {
    mounted.set(editorRoot, textarea);
    byTextarea.set(textarea, { root: editorRoot, ...info });
}

/** @param {Element} editorRoot */
export function unregisterMountedEditor(editorRoot) {
    const textarea = mounted.get(editorRoot);
    if (textarea && byTextarea.get(textarea)?.root === editorRoot) byTextarea.delete(textarea);
    mounted.delete(editorRoot);
}

/**
 * @param {Element | null | undefined} textarea
 * @returns {MountedEditorInfo | null}
 */
export function getMountedEditor(textarea) {
    return textarea instanceof HTMLTextAreaElement ? byTextarea.get(textarea) ?? null : null;
}

/**
 * @param {Event} event
 */
export function markEditorEvent(event) {
    editorEvents.add(event);
}

/**
 * @param {Event} event
 * @returns {boolean}
 */
export function isEditorEvent(event) {
    return editorEvents.has(event);
}

/**
 * @param {Event} event
 * @returns {boolean}
 */
export function isUserEvent(event) {
    return Boolean(event?.isTrusted) || isEditorEvent(event);
}

/**
 * @param {Element | null} element
 * @returns {HTMLTextAreaElement | null}
 */
export function getMountedTextarea(element) {
    const root = element?.closest?.('.cm-editor');
    return root ? mounted.get(root) ?? null : null;
}

/**
 * @returns {HTMLTextAreaElement | HTMLInputElement | null}
 */
export function getFocusedField() {
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
        return active;
    }
    return getMountedTextarea(active);
}

/**
 * @param {HTMLTextAreaElement} textarea
 * @param {import('./mount.js').LiveEditorOptions} [options]
 * @returns {Promise<import('./mount.js').LiveEditor>}
 */
export async function mountLiveEditor(textarea, options = {}) {
    const { mountLiveEditor: mount } = await loadLiveEditor();
    return mount(textarea, options);
}

/**
 * @returns {Promise<typeof import('./mount.js')>}
 */
export function loadLiveEditor() {
    return import('./mount.js');
}
