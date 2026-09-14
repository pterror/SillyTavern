import { IGNORE_SYMBOL } from './prompt-line-formatting.js';

/**
 * Server-side port of public/scripts/chat-completion-settings.js's setOpenAIMessages(),
 * setOpenAIMessageExamples(), and parseExampleIntoIndividual() (the last already exported by the
 * client itself). These build the chat-completion `messages` array from chat history - a separate,
 * self-contained piece from src/chat-completion-generation-data.js, which already takes that array
 * as a pre-built input.
 *
 * Like src/prompt-line-formatting.js and src/character-card-fields.js, every piece of context the
 * client reads from globals/settings (name1, name2, selected_group, oai_settings.names_behavior,
 * the current API/model, getGroupNames()) is taken as an explicit parameter instead.
 */

// Mirrored from public/scripts/system-messages.js's system_message_types - same mirroring pattern
// as src/prompt-line-formatting.js's local copy.
const system_message_types = {
    NARRATOR: 'narrator',
};

/**
 * Mirrors public/scripts/chat-completion-settings.js's character_names_behavior enum.
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
 * Mirrors public/scripts/constants.js's MEDIA_DISPLAY enum (only the values getMediaDisplay()
 * needs to validate against).
 * @readonly
 * @enum {string}
 */
export const MEDIA_DISPLAY = {
    LIST: 'list',
    GALLERY: 'gallery',
};

/**
 * @typedef {object} ChatMessageExtra
 * @property {string} [type] e.g. system_message_types.NARRATOR
 * @property {boolean} [ignore] Set to true to mirror the client's IGNORE_SYMBOL flag
 * @property {string} [media_display]
 * @property {number} [media_index]
 * @property {string[]} [media]
 * @property {object[]} [tool_invocations]
 * @property {string} [api] Origin chat-completion source the message was generated with
 * @property {string} [model] Origin model the message was generated with
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
 * Port of public/script.js's getMediaDisplay(mes) (~line 3247-3250).
 * @param {ChatMessage} mes Message object
 * @param {object} [options]
 * @param {string} [options.mediaDisplaySetting] Equivalent of the client's global power_user.media_display
 * @returns {string} A MEDIA_DISPLAY value
 */
export function getMediaDisplay(mes, { mediaDisplaySetting } = {}) {
    const value = mes?.extra?.media_display || mediaDisplaySetting || MEDIA_DISPLAY.LIST;
    return Object.values(MEDIA_DISPLAY).includes(value) ? value : MEDIA_DISPLAY.LIST;
}

/**
 * Port of public/script.js's getMediaIndex(mes) (~line 3257-3266).
 * @param {ChatMessage} mes Message object
 * @returns {number} Media index
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
 * @property {boolean} [isGroup] Equivalent of the client's `selected_group` truthiness check
 * @property {string} name1
 * @property {string} name2
 * @property {number} namesBehavior One of the character_names_behavior values (oai_settings.names_behavior)
 * @property {string} [currentApi] Equivalent of oai_settings.chat_completion_source
 * @property {string} [currentModel] Equivalent of getChatCompletionModel()
 * @property {string} [mediaDisplaySetting] Equivalent of power_user.media_display
 */

/**
 * Port of public/scripts/chat-completion-settings.js's setOpenAIMessages(chat) (~line 570-647).
 *
 * Judgment call: the client loop iterates `i` from `chat.length - 1` down to `0` (decrementing
 * every iteration) while reading `chat[j]` with `j` starting at 0 and only incrementing when a
 * message is NOT skipped by IGNORE_SYMBOL... wait, actually `j` increments on EVERY loop body exit
 * (including the `continue` for a skipped message), while `messages[i]` is only ever *written* when
 * the message is not skipped. Since `i` still decrements on every iteration regardless, an
 * IGNORE_SYMBOL-skipped message leaves `messages[i]` completely unwritten (a genuine gap/hole in
 * the resulting array, not `undefined` assigned - `i in messages` is false there), rather than
 * shifting later entries down to fill it. This is preserved exactly here: the skip path does not
 * write anything to `messages[i]`.
 * @param {ChatMessage[]} chat Array containing all messages, oldest first (as stored in chat history)
 * @param {BuildChatCompletionMessagesContext} context
 * @returns {object[]} Array containing all messages formatted for chat completion. May contain holes.
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

        // Hides the message without affecting the chat's message count.
        if (chat[j].extra?.[IGNORE_SYMBOL]) {
            j++;
            continue;
        }

        // 100% legal way to send a message as system
        if (chat[j].extra?.type === system_message_types.NARRATOR) {
            role = 'system';
        }

        // for groups or sendas command - prepend a character's name
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

        // remove caret return (waste of tokens)
        content = content.replace(/\r/gm, '');

        const name = chat[j].name;
        const media = chat[j]?.extra?.media;
        const mediaDisplay = getMediaDisplay(chat[j], { mediaDisplaySetting });
        const mediaIndex = getMediaIndex(chat[j]);
        const invocations = chat[j]?.extra?.tool_invocations?.slice();

        // Only send thought signatures if they were generated by the same API and model
        const originApi = chat[j]?.extra?.api;
        const originModel = chat[j]?.extra?.model;
        const isSameModel = originApi === currentApi && originModel === currentModel;
        // In group chats, only include reasoning from the currently generating character
        const isOtherGroupMember = isGroup && chat[j].name !== name2;
        const signature = isSameModel && !isOtherGroupMember ? chat[j]?.extra?.reasoning_signature : null;
        const reasoning = isSameModel && !isOtherGroupMember ? String(chat[j]?.extra?.reasoning ?? '') : '';

        // Remove reasoning metadata from invocations if the API/model don't match
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
 * @property {boolean} [appendNamesForGroup] Whether to append the character name for group chats
 * @property {boolean} [isGroup] Equivalent of the client's `selected_group` truthiness check
 * @property {string} name1
 * @property {string} name2
 * @property {string[]} [groupBotNames] Equivalent of getGroupNames().map(name => `${name}:`) - pass
 *  already-suffixed `name:` strings, matching the client's own precomputation
 */

/**
 * Port of public/scripts/chat-completion-settings.js's parseExampleIntoIndividual() (~line 727-785),
 * already exported by the client.
 * @param {string} messageExampleString The string containing the example messages
 * @param {ParseExampleContext} context
 * @returns {object[]} Array of message objects
 */
export function parseExampleIntoIndividual(messageExampleString, {
    appendNamesForGroup = true,
    isGroup = false,
    name1,
    name2,
    groupBotNames = [],
} = {}) {
    let result = []; // array of msgs
    let tmp = messageExampleString.split('\n');
    let cur_msg_lines = [];
    let in_user = false;
    let in_bot = false;
    let botName = name2;

    // DRY my cock and balls :)
    function add_msg(name, role, system_name) {
        // join different newlines (we split them by \n and join by \n)
        // remove char name
        // strip to remove extra spaces
        let parsed_msg = cur_msg_lines.join('\n').replace(name + ':', '').trim();

        if (appendNamesForGroup && isGroup && ['example_user', 'example_assistant'].includes(system_name)) {
            parsed_msg = `${name}: ${parsed_msg}`;
        }

        result.push({ 'role': role, 'content': parsed_msg, 'name': system_name });
        cur_msg_lines = [];
    }
    // skip first line as it'll always be "This is how {bot name} should talk"
    for (let i = 1; i < tmp.length; i++) {
        let cur_str = tmp[i];
        // if it's the user message, switch into user mode and out of bot mode
        // yes, repeated code, but I don't care
        if (cur_str.startsWith(name1 + ':')) {
            in_user = true;
            // we were in the bot mode previously, add the message
            if (in_bot) {
                add_msg(botName, 'system', 'example_assistant');
            }
            in_bot = false;
        } else if (cur_str.startsWith(name2 + ':') || groupBotNames.some(n => cur_str.startsWith(n))) {
            if (!cur_str.startsWith(name2 + ':') && groupBotNames.length) {
                botName = cur_str.split(':')[0];
            }

            in_bot = true;
            // we were in the user mode previously, add the message
            if (in_user) {
                add_msg(name1, 'system', 'example_user');
            }
            in_user = false;
        }
        // push the current line into the current message array only after checking for presence of user/bot
        cur_msg_lines.push(cur_str);
    }
    // Special case for last message in a block because we don't have a new message to trigger the switch
    if (in_user) {
        add_msg(name1, 'system', 'example_user');
    } else if (in_bot) {
        add_msg(botName, 'system', 'example_assistant');
    }
    return result;
}

/**
 * Port of public/scripts/chat-completion-settings.js's setOpenAIMessageExamples(mesExamplesArray)
 * (~line 654-665).
 * @param {string[]} mesExamplesArray Array containing all examples
 * @param {ParseExampleContext} context
 * @returns {object[][]} Array containing all examples formatted for chat completion (array of arrays)
 */
export function buildChatCompletionMessageExamples(mesExamplesArray, context = {}) {
    // get a nice array of all blocks of all example messages = array of arrays (important!)
    const examples = [];
    for (let item of mesExamplesArray) {
        // remove <START> {Example Dialogue:} and replace \r\n with just \n
        let replaced = item.replace(/<START>/i, '{Example Dialogue:}').replace(/\r/gm, '');
        let parsed = parseExampleIntoIndividual(replaced, { ...context, appendNamesForGroup: context.appendNamesForGroup ?? true });
        // add to the example message blocks array
        examples.push(parsed);
    }
    return examples;
}
