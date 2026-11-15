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

/** The id of the page's command for an editor's tool */
export const formatCommandId = (/** @type {string} */ id) => `format.${id}`;
