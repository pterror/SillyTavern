import { EMOJIS } from './emojis.js';
import { MacroValues } from './macro-values.js';
import { getFocusedField, loadLiveEditor } from './live-editor/registry.js';
import { drawnMessageText } from './message-text.js';

/**
 * @typedef {object} ChatEditorDeps
 * @property {() => import('./macro-values.js').MacroScope} macroScope
 * @property {{ encode_tags?: boolean }} power_user
 * @property {(file: File) => Promise<string>} uploadImage
 * @property {() => string} userName
 * @property {() => number} nextMessageId
 * @property {(macroName: string, characterName: string) => import('./macro-pill.js').MacroPerson | null} macroPerson
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
 * @property {string | (() => string)} name
 * @property {boolean} isSystem
 * @property {boolean} isUser
 * @property {number | (() => number)} messageId
 * @property {boolean} [isChatBox]
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
    const isChatBox = Boolean(target.isChatBox);
    const { power_user, uploadImage, macroPerson } = chatDeps;
    const fillsMacros = () => isChatBox || (Number(messageIdNow()) === 0 && !isSystem && !isUser);
    const values = new MacroValues(() => (isUser ? chatDeps.macroScope() : { ...chatDeps.macroScope(), name2: nameNow() }));
    return {
        draw: text => drawnMessageText(text, { name: nameNow(), isUser }),
        grammar: {
            emojis: EMOJIS,
            dialogueQuotes: !isSystem,
            encodeTags: !isSystem && Boolean(power_user.encode_tags),
        },
        contentClass: isChatBox ? '' : 'mes_text',
        editorClass: isChatBox ? 'live-chat-text' : '',
        macros: {
            values: {
                get: source => (fillsMacros() ? values.get(source) : null),
                wantMacros: sources => (fillsMacros() ? values.wantMacros(sources) : Promise.resolve(false)),
                refresh: () => (fillsMacros() ? values.refresh() : Promise.resolve(false)),
            },
            person: macroName => macroPerson(macroName, isUser ? '' : nameNow()),
        },
        formatting: { uploadImage },
        search: { context: () => ({ characterName: nameNow() }) },
    };
}

/**
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

/**
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
