import { MacroRegistry, MacroCategory, MacroValueType } from '../engine/MacroRegistry.js';

/**
 * Registers macros that inspect the current chat log and swipe state
 * (message texts, indices, swipes, and context boundaries).
 */
export function registerChatMacros() {
    MacroRegistry.registerMacro('lastMessage', {
        category: MacroCategory.CHAT,
        description: 'Last message in the chat.',
        returns: 'Last message in the chat.',
        handler: ({ env }) => String(getLastMessage(env.state.chat) ?? ''),
    });

    MacroRegistry.registerMacro('lastMessageId', {
        category: MacroCategory.CHAT,
        description: 'Index of the last message in the chat.',
        returns: 'Index of the last message in the chat.',
        returnType: MacroValueType.INTEGER,
        handler: ({ env }) => String(getLastMessageId(env.state.chat) ?? ''),
    });

    MacroRegistry.registerMacro('lastUserMessage', {
        category: MacroCategory.CHAT,
        description: 'Last user message in the chat.',
        returns: 'Last user message in the chat.',
        handler: ({ env }) => String(getLastUserMessage(env.state.chat) ?? ''),
    });

    MacroRegistry.registerMacro('lastCharMessage', {
        category: MacroCategory.CHAT,
        description: 'Last character/bot message in the chat.',
        returns: 'Last character/bot message in the chat.',
        handler: ({ env }) => String(getLastCharMessage(env.state.chat) ?? ''),
    });

    MacroRegistry.registerMacro('firstIncludedMessageId', {
        category: MacroCategory.CHAT,
        description: 'Index of the first message included in the current context.',
        returns: 'Index of the first message included in the context.',
        returnType: MacroValueType.INTEGER,
        handler: ({ env }) => String(getFirstIncludedMessageId(env.state.chatMetadata) ?? ''),
    });

    MacroRegistry.registerMacro('firstDisplayedMessageId', {
        category: MacroCategory.CHAT,
        description: 'Index of the first displayed message in the chat.',
        returns: 'Index of the first displayed message in the chat.',
        returnType: MacroValueType.INTEGER,
        handler: ({ env }) => String(env.state.firstDisplayedMessageId ?? ''),
    });

    MacroRegistry.registerMacro('lastSwipeId', {
        category: MacroCategory.CHAT,
        description: '1-based index of the last swipe for the last message.',
        returns: '1-based index of the last swipe.',
        returnType: MacroValueType.INTEGER,
        handler: ({ env }) => String(getLastSwipeId(env.state.chat) ?? ''),
    });

    MacroRegistry.registerMacro('currentSwipeId', {
        category: MacroCategory.CHAT,
        description: '1-based index of the current swipe.',
        returns: '1-based index of the current swipe.',
        returnType: MacroValueType.INTEGER,
        handler: ({ env }) => String(getCurrentSwipeId(env.state.chat) ?? ''),
    });

    MacroRegistry.registerMacro('allChatRange', {
        category: MacroCategory.CHAT,
        description: 'Range of all message IDs in the chat (e.g. "0-10"). Empty string if the chat is empty.',
        returns: 'Range string from 0 to last message ID, or empty string.',
        handler: ({ env }) => {
            const chat = env.state.chat;
            if (!Array.isArray(chat) || chat.length === 0) {
                return '';
            }
            return `0-${chat.length - 1}`;
        },
    });
}

/** @typedef {import('../engine/MacroEnv.types.js').MacroChatMessage[]} Chat */

/** @param {Chat} chat */
function getLastMessageId(chat, { exclude_swipe_in_propress = true, filter = null } = {}) {
    if (!Array.isArray(chat) || chat.length === 0) {
        return null;
    }

    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];

        if (exclude_swipe_in_propress && message.swipes && message.swipe_id >= message.swipes.length) {
            continue;
        }

        if (!filter || filter(message)) {
            return i;
        }
    }

    return null;
}

/** @param {Chat} chat */
function getLastMessage(chat) {
    const mid = getLastMessageId(chat);
    return typeof mid === 'number' ? (chat[mid]?.mes ?? '') : '';
}

/** @param {Chat} chat */
function getLastUserMessage(chat) {
    const mid = getLastMessageId(chat, { filter: m => m.is_user && !m.is_system });
    return typeof mid === 'number' ? (chat[mid]?.mes ?? '') : '';
}

/** @param {Chat} chat */
function getLastCharMessage(chat) {
    const mid = getLastMessageId(chat, { filter: m => !m.is_user && !m.is_system });
    return typeof mid === 'number' ? (chat[mid]?.mes ?? '') : '';
}

/** @param {Record<string, any>} [chatMetadata] */
function getFirstIncludedMessageId(chatMetadata) {
    const value = chatMetadata?.lastInContextMessageId;
    return typeof value === 'number' ? value : null;
}

/** @param {Chat} chat */
function getLastSwipeId(chat) {
    const mid = getLastMessageId(chat, { exclude_swipe_in_propress: false });
    if (typeof mid !== 'number') {
        return null;
    }
    const swipes = chat[mid]?.swipes;
    return Array.isArray(swipes) ? swipes.length : null;
}

/** @param {Chat} chat */
function getCurrentSwipeId(chat) {
    const mid = getLastMessageId(chat, { exclude_swipe_in_propress: false });
    if (typeof mid !== 'number') {
        return null;
    }
    const swipeId = chat[mid]?.swipe_id;
    return typeof swipeId === 'number' ? swipeId + 1 : null;
}
