// The live editor on the chat's own text boxes: a message being edited, a reasoning block being edited, and the chat
// box. A message or reasoning editor lives exactly as long as its edit: mounted when the edit starts, taken away
// before the textarea is removed. The chat box keeps its editor once it has one.

import { showdown } from '../lib.js';
import { evaluateSafeMacro } from './safe-macros.js';
import { getFocusedField, loadLiveEditor, mountLiveEditor } from './live-editor/registry.js';

/**
 * @typedef {object} ChatEditorDeps
 * @property {(mes: string, chName: string, isSystem: boolean, isUser: boolean, messageId: number, sanitizerOverrides?: object, isReasoning?: boolean) => string} messageFormatting
 * @property {(content: string, options?: object) => string} substituteParams
 * @property {{ encode_tags?: boolean }} power_user
 * @property {(file: File) => Promise<string>} uploadImage
 * @property {() => string} userName The user's name, as a message they send renders with it.
 * @property {() => number} nextMessageId The id the chat box's message gets when it's sent.
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
 * @property {string | (() => string)} name The speaker's name, as the message renders with it.
 * @property {boolean} isSystem
 * @property {boolean} isUser
 * @property {number | (() => number)} messageId
 * @property {boolean} [isReasoning] A reasoning block, rendered as messageFormatting renders reasoning.
 * @property {boolean} [isChatBox] The chat box: it keeps its own look, and its toolbar shows only while it has focus.
 */

/**
 * @param {ChatEditorDeps} chatDeps
 * @param {ChatEditorTarget} target
 * @returns {import('./live-editor/mount.js').LiveEditorOptions}
 */
function chatEditorOptions(chatDeps, target) {
    const { isSystem, isUser } = target;
    const nameNow = () => (typeof target.name === 'function' ? target.name() : target.name);
    const messageIdNow = () => (typeof target.messageId === 'function' ? target.messageId() : target.messageId);
    const isReasoning = Boolean(target.isReasoning);
    const isChatBox = Boolean(target.isChatBox);
    const { messageFormatting, substituteParams, power_user, uploadImage } = chatDeps;
    // messageFormatting fills in macros only on the first message of a character (not reasoning); a reasoning edit
    // fills them in when it's saved, and the chat box's text when it's sent. Elsewhere the text renders with its
    // macros as written.
    const fillsMacros = () => isReasoning || isChatBox || (Number(messageIdNow()) === 0 && !isSystem && !isUser);
    return {
        render: text => messageFormatting(text, nameNow(), isSystem, isUser, messageIdNow(), {}, isReasoning),
        grammar: {
            emojis: showdown.helper.emojis,
            dialogueQuotes: !isSystem,
            encodeTags: !isSystem && Boolean(power_user.encode_tags),
        },
        // A reasoning block's own class also draws its box (border, padding), which the edit box doesn't have; the
        // chat box keeps its own text look.
        contentClass: isReasoning || isChatBox ? '' : 'mes_text',
        editorClass: isChatBox ? 'live-toolbar-when-focused' : '',
        // {{char}} is the speaker only where a character speaks.
        macros: { evaluate: text => (fillsMacros() ? evaluateSafeMacro(text, substituteParams, isUser ? {} : { name2Override: nameNow() }) : null) },
        formatting: { uploadImage },
        search: { context: () => ({ characterName: nameNow() }) },
    };
}

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
    try {
        const editor = await mountLiveEditor(textarea, chatEditorOptions(deps, target));
        if (holder.ended || !textarea.isConnected) {
            editor.destroy();
            editors.delete(textarea);
            return;
        }
        holder.editor = editor;
        if (document.activeElement === textarea) editor.takeFocus();
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

/**
 * Gives the chat box the live editor once the page is idle after loading, and only at a moment the chat box doesn't
 * have focus: focus never moves while the user types, so no keystroke can land between the plain box and the editor.
 * If the chat box has focus when the editor is ready, the editor goes on when the chat box loses it. The check and
 * the mount happen in one task, so no input can arrive in between. If the editor can't load, the chat box stays a
 * plain text box.
 * @param {HTMLTextAreaElement} textarea
 */
export function initChatBoxEditor(textarea) {
    const whenIdle = window.requestIdleCallback ?? (callback => setTimeout(callback, 1));
    whenIdle(() => {
        loadLiveEditor().then((module) => {
            const mountWhenUnfocused = () => {
                if (!deps || editors.has(textarea) || !textarea.isConnected) return;
                if (getFocusedField() === textarea) {
                    textarea.addEventListener('blur', mountWhenUnfocused, { once: true });
                    return;
                }
                try {
                    const editor = module.mountLiveEditor(textarea, chatEditorOptions(deps, {
                        name: deps.userName,
                        isSystem: false,
                        isUser: true,
                        messageId: deps.nextMessageId,
                        isChatBox: true,
                    }));
                    editors.set(textarea, { editor, ended: false });
                } catch (error) {
                    console.error('The editor could not be put on the chat box; it stays a plain text box', error);
                }
            };
            mountWhenUnfocused();
        }).catch((error) => {
            console.error('The editor could not be loaded; the chat box stays a plain text box', error);
        });
    });
}
