// The live editor on the chat's own text boxes: a message being edited, and a reasoning block being edited.
// Each editor lives exactly as long as its textarea's edit: mounted when the edit starts, taken away before the
// textarea is removed.

import { showdown } from '../lib.js';
import { evaluateSafeMacro } from './safe-macros.js';
import { mountLiveEditor } from './live-editor/registry.js';

/**
 * @typedef {object} ChatEditorDeps
 * @property {(mes: string, chName: string, isSystem: boolean, isUser: boolean, messageId: number, sanitizerOverrides?: object, isReasoning?: boolean) => string} messageFormatting
 * @property {(content: string, options?: object) => string} substituteParams
 * @property {{ encode_tags?: boolean }} power_user
 * @property {(file: File) => Promise<string>} uploadImage
 */

/** @type {ChatEditorDeps | null} */
let deps = null;

/** @param {ChatEditorDeps} chatEditorDeps */
export function initChatLiveEditor(chatEditorDeps) {
    deps = chatEditorDeps;
}

/** @type {Map<HTMLTextAreaElement, { editor: import('./live-editor/mount.js').LiveEditor | null, ended: boolean }>} */
const editors = new Map();

/**
 * @typedef {object} ChatEditorTarget
 * @property {string} name The speaker's name, as the message renders with it.
 * @property {boolean} isSystem
 * @property {boolean} isUser
 * @property {number} messageId
 * @property {boolean} [isReasoning] A reasoning block, rendered as messageFormatting renders reasoning.
 */

/**
 * Puts the live editor on a chat text box that's being edited, set up as that message renders.
 * @param {HTMLTextAreaElement} textarea
 * @param {ChatEditorTarget} target
 */
export async function mountChatEditor(textarea, target) {
    if (!deps || editors.has(textarea)) return;
    takeDetachedEditorsAway();
    const holder = { editor: null, ended: false };
    editors.set(textarea, holder);
    const { name, isSystem, isUser, messageId } = target;
    const isReasoning = Boolean(target.isReasoning);
    const { messageFormatting, substituteParams, power_user, uploadImage } = deps;
    // messageFormatting fills in macros only on the first message of a character (not reasoning); a reasoning edit
    // fills them in when it's saved. Elsewhere the text renders with its macros as written.
    const fillsMacros = isReasoning || (Number(messageId) === 0 && !isSystem && !isUser);
    try {
        const editor = await mountLiveEditor(textarea, {
            render: text => messageFormatting(text, name, isSystem, isUser, messageId, {}, isReasoning),
            grammar: {
                emojis: showdown.helper.emojis,
                dialogueQuotes: !isSystem,
                encodeTags: !isSystem && Boolean(power_user.encode_tags),
            },
            // A reasoning block's own class also draws its box (border, padding), which the edit box doesn't have.
            contentClass: isReasoning ? '' : 'mes_text',
            macros: { evaluate: text => (fillsMacros ? evaluateSafeMacro(text, substituteParams, { name2Override: name }) : null) },
            formatting: { uploadImage },
            search: { context: () => ({ characterName: name }) },
        });
        if (holder.ended || !textarea.isConnected) {
            editor.destroy();
            editors.delete(textarea);
            return;
        }
        holder.editor = editor;
        if (document.activeElement === textarea) editor.view.focus();
    } catch (error) {
        editors.delete(textarea);
        console.error('The editor could not be loaded; the text box stays a plain text box', error);
    }
}

/**
 * Takes the editor away from a chat text box. Call before the textarea is removed; the textarea keeps the text.
 * @param {HTMLTextAreaElement | null | undefined} textarea
 */
export function unmountChatEditor(textarea) {
    if (!textarea) return;
    const holder = editors.get(textarea);
    if (!holder) return;
    holder.ended = true;
    holder.editor?.destroy();
    editors.delete(textarea);
}

/** Editors whose text box left the page without its edit closing (e.g. the chat was redrawn) are taken away. */
export function takeDetachedEditorsAway() {
    for (const textarea of [...editors.keys()]) {
        if (!textarea.isConnected) unmountChatEditor(textarea);
    }
}
