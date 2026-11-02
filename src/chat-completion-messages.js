import { IGNORE_SYMBOL } from './prompt-line-formatting.js';
import { reasoningOf } from '../public/scripts/reasoning-block.js';

const system_message_types = {
    NARRATOR: 'narrator',
};

/**
 * @readonly
 * @enum {number}
 */
export const character_names_behavior = {
    NONE: -1,
    DEFAULT: 0,
    COMPLETION: 1,
    CONTENT: 2,
};

/**
 * @readonly
 * @enum {string}
 */
export const MEDIA_DISPLAY = {
    LIST: 'list',
    GALLERY: 'gallery',
};

/**
 * @typedef {object} ChatMessageExtra
 * @property {string} [type]
 * @property {boolean} [ignore]
 * @property {string} [media_display]
 * @property {number} [media_index]
 * @property {string[]} [media]
 * @property {object[]} [tool_invocations]
 * @property {string} [api]
 * @property {string} [model]
 * @property {string} [reasoning_signature]
 * @property {string} [reasoning]
 */

/**
 * @typedef {object} ChatMessage
 * @property {boolean} [is_user]
 * @property {string} [mes]
 * @property {string} [name]
 * @property {string} [force_avatar]
 * @property {ChatMessageExtra} [extra]
 */

/**
 * @param {ChatMessage} mes
 * @param {object} [options]
 * @param {string} [options.mediaDisplaySetting]
 * @returns {string}
 */
export function getMediaDisplay(mes, { mediaDisplaySetting } = {}) {
    const value = mes?.extra?.media_display || mediaDisplaySetting || MEDIA_DISPLAY.LIST;
    return Object.values(MEDIA_DISPLAY).includes(value) ? value : MEDIA_DISPLAY.LIST;
}

/**
 * @param {ChatMessage} mes
 * @returns {number}
 */
export function getMediaIndex(mes) {
    if (!Array.isArray(mes?.extra?.media)) {
        return 0;
    }
    const value = mes.extra?.media_index;
    if (isNaN(value) || value < 0 || value >= mes.extra.media.length) {
        return 0;
    }
    return value;
}

/**
 * @typedef {object} BuildChatCompletionMessagesContext
 * @property {boolean} [isGroup]
 * @property {string} name1
 * @property {string} name2
 * @property {number} namesBehavior
 * @property {string} [currentApi]
 * @property {string} [currentModel]
 * @property {string} [mediaDisplaySetting]
 */

/**
 * @param {ChatMessage[]} chat
 * @param {BuildChatCompletionMessagesContext} context
 * @returns {object[]}
 */
export function buildChatCompletionMessages(chat, {
    isGroup = false,
    name1,
    name2,
    namesBehavior,
    currentApi,
    currentModel,
    mediaDisplaySetting,
} = {}) {
    let j = 0;
    const messages = [];

    for (let i = chat.length - 1; i >= 0; i--) {
        let role = chat[j].is_user ? 'user' : 'assistant';
        let content = chat[j].mes;

        if (chat[j].extra?.[IGNORE_SYMBOL]) {
            j++;
            continue;
        }

        if (chat[j].extra?.type === system_message_types.NARRATOR) {
            role = 'system';
        }

        switch (namesBehavior) {
            case character_names_behavior.NONE:
                break;
            case character_names_behavior.DEFAULT:
                if ((isGroup && chat[j].name !== name1) || (chat[j].force_avatar && chat[j].name !== name1 && chat[j].extra?.type !== system_message_types.NARRATOR)) {
                    content = `${chat[j].name}: ${content}`;
                }
                break;
            case character_names_behavior.CONTENT:
                if (chat[j].extra?.type !== system_message_types.NARRATOR) {
                    content = `${chat[j].name}: ${content}`;
                }
                break;
            case character_names_behavior.COMPLETION:
                break;
            default:
                break;
        }

        content = content.replace(/\r/gm, '');

        const name = chat[j].name;
        const media = chat[j]?.extra?.media;
        const mediaDisplay = getMediaDisplay(chat[j], { mediaDisplaySetting });
        const mediaIndex = getMediaIndex(chat[j]);
        const invocations = chat[j]?.extra?.tool_invocations?.slice();

        const originApi = chat[j]?.extra?.api;
        const originModel = chat[j]?.extra?.model;
        const isSameModel = originApi === currentApi && originModel === currentModel;
        const isOtherGroupMember = isGroup && chat[j].name !== name2;
        const signature = isSameModel && !isOtherGroupMember ? chat[j]?.extra?.reasoning_signature : null;
        const reasoning = isSameModel && !isOtherGroupMember ? (reasoningOf(chat[j]?.extra) ?? '') : '';

        if (Array.isArray(invocations) && invocations.length > 0) {
            invocations.forEach((invocation, index) => {
                if (!isSameModel && (invocation.signature || invocation.reasoning)) {
                    const cloneInvocation = structuredClone(invocation);
                    delete cloneInvocation.signature;
                    delete cloneInvocation.reasoning;
                    invocations[index] = cloneInvocation;
                }
            });
        }

        messages[i] = { 'role': role, 'content': content, name: name, 'media': media, 'mediaDisplay': mediaDisplay, 'mediaIndex': mediaIndex, 'invocations': invocations, 'signature': signature, 'reasoning': reasoning };
        j++;
    }

    return messages;
}

/**
 * @typedef {object} ParseExampleContext
 * @property {boolean} [appendNamesForGroup]
 * @property {boolean} [isGroup]
 * @property {string} name1
 * @property {string} name2
 * @property {string[]} [groupBotNames]
 */

/**
 * @param {string} messageExampleString
 * @param {ParseExampleContext} context
 * @returns {object[]}
 */
export function parseExampleIntoIndividual(messageExampleString, {
    appendNamesForGroup = true,
    isGroup = false,
    name1,
    name2,
    groupBotNames = [],
} = {}) {
    let result = [];
    let tmp = messageExampleString.split('\n');
    let cur_msg_lines = [];
    let in_user = false;
    let in_bot = false;
    let botName = name2;

    function add_msg(name, role, system_name) {
        let parsed_msg = cur_msg_lines.join('\n').replace(name + ':', '').trim();

        if (appendNamesForGroup && isGroup && ['example_user', 'example_assistant'].includes(system_name)) {
            parsed_msg = `${name}: ${parsed_msg}`;
        }

        result.push({ 'role': role, 'content': parsed_msg, 'name': system_name });
        cur_msg_lines = [];
    }
    for (let i = 1; i < tmp.length; i++) {
        let cur_str = tmp[i];
        if (cur_str.startsWith(name1 + ':')) {
            in_user = true;
            if (in_bot) {
                add_msg(botName, 'system', 'example_assistant');
            }
            in_bot = false;
        } else if (cur_str.startsWith(name2 + ':') || groupBotNames.some(n => cur_str.startsWith(n))) {
            if (!cur_str.startsWith(name2 + ':') && groupBotNames.length) {
                botName = cur_str.split(':')[0];
            }

            in_bot = true;
            if (in_user) {
                add_msg(name1, 'system', 'example_user');
            }
            in_user = false;
        }
        cur_msg_lines.push(cur_str);
    }
    if (in_user) {
        add_msg(name1, 'system', 'example_user');
    } else if (in_bot) {
        add_msg(botName, 'system', 'example_assistant');
    }
    return result;
}

/**
 * @param {string[]} mesExamplesArray
 * @param {ParseExampleContext} context
 * @returns {object[][]}
 */
export function buildChatCompletionMessageExamples(mesExamplesArray, context = {}) {
    const examples = [];
    for (let item of mesExamplesArray) {
        let replaced = item.replace(/<START>/i, '{Example Dialogue:}').replace(/\r/gm, '');
        let parsed = parseExampleIntoIndividual(replaced, { ...context, appendNamesForGroup: context.appendNamesForGroup ?? true });
        examples.push(parsed);
    }
    return examples;
}
