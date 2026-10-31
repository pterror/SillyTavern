import { collectMessageTitles, isSystemChatItem } from '../public/scripts/core-chat-predicates.js';

/**
 * @typedef {object} CoreChatMessageExtraMedia
 * @property {string} [title]
 * @property {boolean} [append_title]
 */

/**
 * @typedef {object} CoreChatMessageExtra
 * @property {boolean} [append_title]
 * @property {string} [title]
 * @property {CoreChatMessageExtraMedia[]} [media]
 * @property {unknown[]} [tool_invocations]
 */

/**
 * @typedef {object} CoreChatMessage
 * @property {boolean} [is_system]
 * @property {boolean} [is_user]
 * @property {string} [mes]
 * @property {CoreChatMessageExtra} [extra]
 */

/**
 * @param {CoreChatMessage[]} chat
 * @param {object} options
 * @param {boolean} options.canUseTools
 * @param {boolean} options.isSwipe
 * @returns {CoreChatMessage[]}
 */
export function buildCoreChat(chat, { canUseTools, isSwipe }) {
    const coreChat = chat.filter(x => !isSystemChatItem(x) || (canUseTools && Array.isArray(x.extra?.tool_invocations)));
    if (isSwipe) {
        coreChat.pop();
    }
    return coreChat;
}

/**
 * @param {CoreChatMessage} chatItem
 * @returns {string}
 */
export function applyMessageTitles(chatItem) {
    return collectMessageTitles(chatItem);
}

/**
 * @param {CoreChatMessage} chatItem
 * @param {number} index
 * @param {string} resolvedMessage
 * @returns {CoreChatMessage & { mes: string, index: number }}
 */
export function finalizeCoreChatMessage(chatItem, index, resolvedMessage) {
    return {
        ...chatItem,
        mes: `${resolvedMessage}${applyMessageTitles(chatItem)}`,
        index,
    };
}
