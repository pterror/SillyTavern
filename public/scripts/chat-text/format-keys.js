import { byPlatform } from '../../live-editor-lib.js';

/**
 * The formatting commands' keys and names, which the page binds before any editor is loaded
 * @type {readonly Readonly<{ id: string, keys: string, label: (t: import('../macro-pill.js').Translate) => string, hotkeys: boolean }>[]}
 */
export const FORMAT_KEYS = [
    { id: 'bold', keys: '$mod+b', label: t => t`Bold`, hotkeys: true },
    { id: 'italic', keys: '$mod+i', label: t => t`Italic`, hotkeys: true },
    { id: 'underline', keys: '$mod+u', label: t => t`Underline`, hotkeys: true },
    { id: 'code', keys: '$mod+e', label: t => t`Code`, hotkeys: true },
    { id: 'strike', keys: '$mod+shift+backquote', label: t => t`Strikethrough`, hotkeys: true },
    { id: 'macros', keys: '$mod+shift+m', label: t => t`Show macros as written`, hotkeys: false },
];

/** The id of the page's command for an editor's formatting tool */
export const formatCommandId = (/** @type {string} */ id) => `format.${id}`;

/**
 * The editor's other actions, bound by the page like the formatting ones: each is the tool of that id, run on the
 * editor that has focus
 * @type {readonly Readonly<{ id: string, command: string, keys: readonly string[], label: (t: import('../macro-pill.js').Translate) => string }>[]}
 */
export const EDITOR_KEYS = [
    { id: 'find', command: 'editor.find', keys: ['$mod+f'], label: t => t`Find and replace` },
    { id: 'findNext', command: 'editor.findNext', keys: ['F3', '$mod+g'], label: t => t`Find the next match` },
    { id: 'findPrevious', command: 'editor.findPrevious', keys: ['shift+F3', '$mod+shift+g'], label: t => t`Find the previous match` },
    { id: 'selectMatches', command: 'editor.selectMatches', keys: ['$mod+shift+l'], label: t => t`Select every match of the selection` },
    { id: 'selectNextOccurrence', command: 'editor.selectNextOccurrence', keys: ['$mod+d'], label: t => t`Select the next match of the selection` },
    { id: 'gotoLine', command: 'editor.gotoLine', keys: ['$mod+alt+g'], label: t => t`Go to a line` },
    { id: 'undo', command: 'editor.undo', keys: ['$mod+z'], label: t => t`Undo` },
    { id: 'redo', command: 'editor.redo', keys: ['$mod+shift+z', ...byPlatform({ mac: [], other: ['ctrl+y'] })], label: t => t`Redo` },
    { id: 'selectAll', command: 'editor.selectAll', keys: ['$mod+a'], label: t => t`Select all` },
    { id: 'pasteMode', command: 'editor.pasteMode', keys: ['$mod+alt+v'], label: t => t`Change how the paste is kept` },
];

/** @param {string} id a tool's id @returns {string} the id of the page's command for it */
export const commandIdOfTool = id => EDITOR_KEYS.find(key => key.id === id)?.command ?? formatCommandId(id);
