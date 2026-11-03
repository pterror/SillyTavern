import { showdown } from '../lib.js';
import { MacroValues } from './macro-values.js';
import { macrosIn } from './safe-macros.js';
import { getFocusedField, loadLiveEditor, mountLiveEditor } from './live-editor/registry.js';
import { drawerStackChanged } from './drawer-stack.js';

/**
 * @typedef {object} ChatEditorDeps
 * @property {(mes: string, chName: string, isSystem: boolean, isUser: boolean, messageId: number, sanitizerOverrides?: object, isReasoning?: boolean) => string} messageFormatting
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
 * @property {boolean} [isReasoning]
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
    const isReasoning = Boolean(target.isReasoning);
    const isChatBox = Boolean(target.isChatBox);
    const { messageFormatting, power_user, uploadImage, macroPerson } = chatDeps;
    const fillsMacros = () => isReasoning || isChatBox || (Number(messageIdNow()) === 0 && !isSystem && !isUser);
    const values = new MacroValues(() => (isUser ? chatDeps.macroScope() : { ...chatDeps.macroScope(), name2: nameNow() }));
    return {
        render: text => messageFormatting(text, nameNow(), isSystem, isUser, messageIdNow(), {}, isReasoning),
        grammar: {
            emojis: showdown.helper.emojis,
            dialogueQuotes: !isSystem,
            encodeTags: !isSystem && Boolean(power_user.encode_tags),
        },
        contentClass: isReasoning || isChatBox ? '' : 'mes_text',
        editorClass: isChatBox ? 'live-chat-text' : isReasoning ? 'live-chat-text live-reasoning-text' : '',
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
 * @param {HTMLTextAreaElement} textarea
 * @param {ChatEditorTarget} target
 */
export async function mountChatEditor(textarea, target) {
    if (!deps || editors.has(textarea)) return;
    takeDetachedEditorsAway();
    const holder = { editor: null, ended: false };
    editors.set(textarea, holder);
    drawerStackChanged();
    try {
        const options = chatEditorOptions(deps, target);
        await options.macros.values.wantMacros(macrosIn(textarea.value));
        if (holder.ended || !textarea.isConnected) {
            editors.delete(textarea);
            return;
        }
        const editor = await mountLiveEditor(textarea, options);
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
 * @param {HTMLTextAreaElement | null | undefined} textarea
 */
export function unmountChatEditor(textarea) {
    if (!textarea) return;
    const holder = editors.get(textarea);
    if (!holder) return;
    holder.ended = true;
    holder.editor?.destroy();
    editors.delete(textarea);
    drawerStackChanged();
}

function takeDetachedEditorsAway() {
    for (const textarea of [...editors.keys()]) {
        if (!textarea.isConnected) unmountChatEditor(textarea);
    }
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
