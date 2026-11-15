/**
 * Editors are loaded when one is first opened, with the editor library, so the page loads without CodeMirror.
 */

/** @type {import('./editor.js').EditorPage | undefined} */
let page;

/** @type {Promise<typeof import('./editor.js')> | undefined} */
let loading;

/** @type {typeof import('./editor.js') | undefined} */
let loaded;

/**
 * @param {import('./editor.js').EditorPage} dependencies what editors read from the page
 */
export function initChatEditors(dependencies) {
    page = dependencies;
}

/**
 * @returns {Promise<typeof import('./editor.js')>} the editor module, ready to make editors
 */
export function loadChatEditor() {
    loading ??= import('./editor.js').then((module) => {
        if (page) module.initChatEditors(page);
        loaded = module;
        return module;
    });
    return loading;
}

/** @returns {typeof import('./editor.js') | undefined} the editor module, once an editor has loaded it */
export function loadedChatEditor() {
    return loaded;
}
