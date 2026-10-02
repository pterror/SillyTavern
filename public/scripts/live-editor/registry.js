// Importable without loading CodeMirror: what the rest of the app needs to know about mounted editors.

/**
 * What, open inside an editor, takes Escape before anything else does: the suggestion list, the find and presets
 * panels, and the paste picker.
 */
export const EDITOR_ESCAPE_TAKERS = '.cm-tooltip-autocomplete, .cm-panels .cm-search, .cm-panels .live-presets, .live-paste-picker';

/** @type {WeakMap<Element, HTMLTextAreaElement>} An editor's root element to the textarea it's mounted on. */
const mounted = new WeakMap();

/**
 * @typedef {object} MountedEditorInfo
 * @property {Element} root The editor's root element: the field's box on screen while the editor is mounted.
 * @property {() => DOMRect | null} caretRect Where the cursor is on screen.
 * @property {boolean} macroSuggestions Whether the editor suggests macros itself.
 */

/** @type {WeakMap<HTMLTextAreaElement, MountedEditorInfo>} A textarea to the editor mounted on it. */
const byTextarea = new WeakMap();

/** @type {WeakSet<Event>} Events the editor dispatched on its textarea on behalf of the user. */
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
 * @returns {MountedEditorInfo | null} The editor mounted on this textarea, if any.
 */
export function getMountedEditor(textarea) {
    return textarea instanceof HTMLTextAreaElement ? byTextarea.get(textarea) ?? null : null;
}

/**
 * Marks an event the editor dispatched on its textarea: a copy of what the user did in the editor (typing, keys,
 * clicks, focus), so code that tells the user's input from writes by other code can count it as the user's.
 * @param {Event} event
 */
export function markEditorEvent(event) {
    editorEvents.add(event);
}

/**
 * @param {Event} event
 * @returns {boolean} Whether a mounted editor dispatched this event on its textarea, as the user's own input.
 */
export function isEditorEvent(event) {
    return editorEvents.has(event);
}

/**
 * @param {Event} event
 * @returns {boolean} Whether the user did this: a trusted event, or the editor's copy of one.
 */
export function isUserEvent(event) {
    return Boolean(event?.isTrusted) || isEditorEvent(event);
}

/**
 * @param {Element | null} element
 * @returns {HTMLTextAreaElement | null} The textarea of the mounted editor `element` is in, if any.
 */
export function getMountedTextarea(element) {
    const root = element?.closest?.('.cm-editor');
    return root ? mounted.get(root) ?? null : null;
}

/**
 * The text field that has focus: the focused textarea itself, or, when focus is in a mounted editor, the textarea
 * that editor is mounted on.
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
 * Mounts a live editor on a textarea, loading the editor's code the first time.
 * @param {HTMLTextAreaElement} textarea
 * @param {import('./mount.js').LiveEditorOptions} [options]
 * @returns {Promise<import('./mount.js').LiveEditor>}
 */
export async function mountLiveEditor(textarea, options = {}) {
    const { mountLiveEditor: mount } = await loadLiveEditor();
    return mount(textarea, options);
}

/**
 * Loads the editor's code, so a caller can mount it at a moment it picks, in the same task as a check.
 * @returns {Promise<typeof import('./mount.js')>}
 */
export function loadLiveEditor() {
    return import('./mount.js');
}
