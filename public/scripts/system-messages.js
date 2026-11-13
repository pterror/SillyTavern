import { addOneMessage, displayVersion, setSendButtonState, system_avatar, systemUserName } from '../script.js';
import { chat } from './chat-state.js';
import { t } from './i18n.js';
import { getMessageTimeStamp } from './RossAscends-mods.js';
import { renderTemplateAsync } from './templates.js';

/** @type {Record<string, ChatMessage>} */
const system_messages = {};
/** @type {ChatMessage[]} */
export const SAFETY_CHAT = [];

/**
 * @enum {string} System message types
 */
export const system_message_types = {
    WELCOME: 'welcome',
    EMPTY: 'empty',
    GENERIC: 'generic',
    NARRATOR: 'narrator',
    COMMENT: 'comment',
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
        welcome: systemMessage({
            mes: await renderTemplateAsync('welcome', { displayVersion }),
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
                isSmallSys: true,
            },
        }),
        /** @type {ChatMessage} */
        assistant_note: systemMessage({
            mes: await renderTemplateAsync('assistantNote'),
            extra: {
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
}
