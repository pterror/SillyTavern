import { addOneMessage, displayVersion, setSendButtonState, system_avatar, systemUserName } from '../script.js';
import { chat } from './chat-state.js';
import { t } from './i18n.js';
import { getMessageTimeStamp } from './RossAscends-mods.js';
import { getSlashCommandsHelp } from './slash-commands.js';
import { SlashCommandBrowser } from './slash-commands/SlashCommandBrowser.js';
import { MacroBrowser, getMacrosHelp } from './macros/engine/MacroBrowser.js';
import { renderTemplateAsync } from './templates.js';

/** @type {Record<string, ChatMessage>} */
const system_messages = {};
/** @type {ChatMessage[]} */
export const SAFETY_CHAT = [];

/**
 * @enum {string} System message types
 */
export const system_message_types = {
    HELP: 'help',
    WELCOME: 'welcome',
    EMPTY: 'empty',
    GENERIC: 'generic',
    NARRATOR: 'narrator',
    COMMENT: 'comment',
    SLASH_COMMANDS: 'slash_commands',
    FORMATTING: 'formatting',
    HOTKEYS: 'hotkeys',
    MACROS: 'macros',
    WELCOME_PROMPT: 'welcome_prompt',
    ASSISTANT_NOTE: 'assistant_note',
    ASSISTANT_MESSAGE: 'assistant_message',
};

export async function initSystemMessages() {
    /** @type {ChatMessage} */
    const defaultMessage = {
        name: systemUserName,
        force_avatar: system_avatar,
        is_user: false,
        is_system: true,
        extra: { swipeable: false },
    };
    /**
     * @param {Partial<ChatMessage>} fields
     * @returns {ChatMessage}
     */
    const systemMessage = (fields) => ({ ...structuredClone(defaultMessage), ...fields, extra: { ...defaultMessage.extra, ...fields.extra } });
    /** @type {Record<string, ChatMessage>} */
    const result = {
        /** @type {ChatMessage} */
        help: systemMessage({
            mes: await renderTemplateAsync('help'),
        }),
        /** @type {ChatMessage} */
        slash_commands: systemMessage({
            mes: '',
        }),
        /** @type {ChatMessage} */
        hotkeys: systemMessage({
            mes: await renderTemplateAsync('hotkeys'),
        }),
        /** @type {ChatMessage} */
        formatting: systemMessage({
            mes: await renderTemplateAsync('formatting'),
        }),
        /** @type {ChatMessage} */
        macros: systemMessage({
            mes: '',
        }),
        /** @type {ChatMessage} */
        welcome: systemMessage({
            mes: await renderTemplateAsync('welcome', { displayVersion }),
            extra: {
                uses_system_ui: true,
            },
        }),
        /** @type {ChatMessage} */
        empty: systemMessage({
            mes: 'No one hears you. <b>Hint&#58;</b> add more members to the group!',
        }),
        /** @type {ChatMessage} */
        generic: systemMessage({
            mes: 'Generic system message. User `text` parameter to override the contents',
        }),
        /** @type {ChatMessage} */
        welcome_prompt: systemMessage({
            mes: await renderTemplateAsync('welcomePrompt'),
            extra: {
                uses_system_ui: true,
                isSmallSys: true,
            },
        }),
        /** @type {ChatMessage} */
        assistant_note: systemMessage({
            mes: await renderTemplateAsync('assistantNote'),
            extra: {
                uses_system_ui: true,
                isSmallSys: true,
            },
        }),
    };

    Object.assign(system_messages, result);

    /** @type {ChatMessage} */
    const safetyMessage = {
        name: systemUserName,
        force_avatar: system_avatar,
        is_system: true,
        is_user: false,
        send_date: getMessageTimeStamp(),
        mes: t`You deleted a character/chat and arrived back here for safety reasons! Pick another character!`,
    };
    SAFETY_CHAT.splice(0, SAFETY_CHAT.length, safetyMessage);
}


/**
 * Not swipeable by default; override via extra.swipeable.
 * @param {string} type
 * @param {string} [text]
 * @param {ChatMessageExtra} [extra]
 * @returns {ChatMessage}
 */
export function getSystemMessageByType(type, text, extra = {}) {
    const systemMessage = system_messages[type];

    if (!systemMessage) {
        return;
    }

    const newMessage = { ...systemMessage, send_date: getMessageTimeStamp() };

    if (text) {
        newMessage.mes = text;
    }

    if (type === system_message_types.SLASH_COMMANDS) {
        newMessage.mes = getSlashCommandsHelp();
    }

    if (type === system_message_types.MACROS) {
        newMessage.mes = getMacrosHelp();
    }

    if (!newMessage.extra || typeof newMessage.extra !== 'object') {
        newMessage.extra = {};
    }

    newMessage.extra = Object.assign(newMessage.extra, extra);
    newMessage.extra.type = type;
    return newMessage;
}

/**
 * @param {string} type
 * @param {string} [text]
 * @param {ChatMessageExtra} [extra]
 */
export function sendSystemMessage(type, text, extra = {}) {
    const newMessage = getSystemMessageByType(type, text, extra);
    chat.push(newMessage);
    addOneMessage(newMessage);
    setSendButtonState(false);
    if (type === system_message_types.SLASH_COMMANDS) {
        const browser = new SlashCommandBrowser();
        const spinner = document.querySelector('#chat .last_mes .custom-slashHelp');
        const parent = spinner.parentElement;
        spinner.remove();
        browser.renderInto(parent);
        browser.search.focus();
    }

    if (type === system_message_types.MACROS) {
        const browser = new MacroBrowser();
        const spinner = document.querySelector('#chat .last_mes .custom-macroHelp');
        if (spinner) {
            const parent = spinner.parentElement;
            spinner.remove();
            browser.renderInto(parent);
            browser.searchInput?.focus();
        }
    }
}
