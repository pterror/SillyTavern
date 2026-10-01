import { SlashCommandParser } from '../SlashCommandParser.js';
import { SlashCommand } from '../SlashCommand.js';
import { Generate, addOneMessage, chatElement, chatOpAddAlternative, chatOpAppend, chatOpEdit, chatOpGraft, comment_avatar, default_avatar, deleteSwipe, extractMessageBias, getCurrentCharacter, getThumbnailUrl, is_send_press, neutralCharacterName, refreshSwipeButtons, reloadCurrentChat, saveChatConditional, sendMessageAsUser, setCharacterName, substituteParams, swipe, system_message_types, updateMessage, updateMessageElement, updateSwipeCounter } from '../../../script.js';
import { chat, chat_metadata } from '../../chat-state.js';
import { setActiveCharacter, setActiveGroup } from '../../app-selection-state.js';
import { charactersStore, setCharacterId } from '../../character-store.js';
import { eventSource, event_types } from '../../events.js';
import { getMessageTimeStamp } from '../../RossAscends-mods.js';
import { hideChatMessageRange } from '../../chats.js';
import { SWIPE_DIRECTION, SWIPE_SOURCE } from '../../constants.js';
import { getRegexedString, regex_placement } from '../../extensions/regex/engine.js';
import { groups } from '../../group-store.js';
import { findGroupMemberId, is_group_generating, openGroupById, regenerateGroup, resetSelectedGroup, selected_group } from '../../group-chats.js';
import { t } from '../../i18n.js';
import { user_avatar } from '../../personas.js';
import { chat_styles } from '../../power-user.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../SlashCommandArgument.js';
import { commonEnumProviders, enumIcons } from '../SlashCommandCommonEnumsProvider.js';
import { SlashCommandEnumValue, enumTypes } from '../SlashCommandEnumValue.js';
import { slashCommandReturnHelper } from '../SlashCommandReturnHelper.js';
import { delay, equalsIgnoreCaseAndAccents, findCharAsync, findPersona, isTrueBoolean, stringToRange, trimToEndSentence, trimToStartSentence, waitUntilCondition } from '../../utils.js';
import { COMMENT_NAME_DEFAULT, NARRATOR_NAME_DEFAULT, NARRATOR_NAME_KEY, generateSystemMessage, getNameAndAvatarForMessage, sendMessageAs, sendNarratorMessage } from '../core.js';

function trimStartCallback(_, value) {
    if (!value) {
        return '';
    }

    return trimToStartSentence(value);
}

function trimEndCallback(_, value) {
    if (!value) {
        return '';
    }

    return trimToEndSentence(value);
}

/**
 * @param {{switch?: string}} args - named arguments
 * @param {string} value - The swipe text to add (unnamed argument)
 */
async function addSwipeCallback(args, value) {
    const lastMessageId = chat.length - 1;
    const lastMessage = chat[chat.length - 1];

    if (!lastMessage) {
        toastr.warning(t`No messages to add swipes to.`);
        return '';
    }

    if (!value) {
        console.warn('WARN: No argument provided for /addswipe command');
        return '';
    }

    if (lastMessage.is_user) {
        toastr.warning(t`Can't add swipes to user messages.`);
        return '';
    }

    if (lastMessage.is_system) {
        toastr.warning(t`Can't add swipes to system messages.`);
        return '';
    }

    // Messages are deep-frozen; mutating in place throws "object is not extensible", so build new
    // arrays and hand them to updateMessage() instead.
    const hadSlots = Array.isArray(lastMessage.swipes);
    const swipes = hadSlots ? [...lastMessage.swipes] : [lastMessage.mes];
    const swipeInfo = Array.isArray(lastMessage.swipe_info)
        ? [...lastMessage.swipe_info]
        : swipes.map(() => ({}));

    swipes.push(value);
    swipeInfo.push({
        send_date: getMessageTimeStamp(),
        gen_started: null,
        gen_finished: null,
        extra: {
            bias: extractMessageBias(value),
            gen_id: Date.now(),
            api: 'manual',
            model: 'slash command',
        },
    });

    updateMessage(lastMessageId, {
        swipes,
        swipe_info: swipeInfo,
        ...(hadSlots ? {} : { swipe_id: 0 }),
    });

    const newSwipeId = swipes.length - 1;

    // Recorded before the switch check below, since selecting onto it needs the row's node_id already set.
    const createdId = await chatOpAddAlternative(lastMessageId, value).catch(error => {
        console.error('Could not save the new swipe as an alternative:', error);
        return null;
    });
    if (createdId) {
        const info = [...chat[lastMessageId].swipe_info];
        info[newSwipeId] = { ...(info[newSwipeId] || {}), node_id: createdId };
        updateMessage(lastMessageId, { swipe_info: info });
    }

    if (isTrueBoolean(args.switch)) {
        await swipe(null, SWIPE_DIRECTION.RIGHT, { source: SWIPE_SOURCE.SLASH_COMMAND, repeated: false, forceMesId: lastMessageId, forceSwipeId: newSwipeId });
    } else {
        // Re-read: updateMessage() above replaced the message, so the copy captured earlier is stale.
        await updateSwipeCounter(lastMessageId, { message: chat[lastMessageId] });
        refreshSwipeButtons();
    }

    return String(newSwipeId);
}

async function deleteSwipeCallback(_, arg) {
    // Take the provided argument. Null if none provided, which will target the current swipe.
    const swipeId = arg && !isNaN(Number(arg)) ? (Number(arg) - 1) : null;

    const newSwipeId = await deleteSwipe(swipeId);

    return String(newSwipeId);
}

async function askCharacter(args, text) {
    // Prevent generate recursion
    $('#send_textarea').val('')[0].dispatchEvent(new Event('input', { bubbles: true }));

    // Not supported in group chats
    if (selected_group) {
        toastr.warning(t`Cannot run /ask command in a group chat!`);
        return '';
    }

    if (!args.name) {
        toastr.warning(t`You must specify a name of the character to ask.`);
        return '';
    }

    // Captured by avatar, not this_chid: this_chid is an array index that can go stale by the time
    // restoreCharacter runs, since it's only called back after the async Generate() below.
    const prevAvatar = getCurrentCharacter()?.avatar;

    const character = await findCharAsync({ name: args?.name });
    if (!character) {
        toastr.error(t`Character not found.`);
        return '';
    }

    if (text) {
        const mesText = getRegexedString(text.trim(), regex_placement.SLASH_COMMAND);
        // Sending implicitly saves the chat, so this must happen before changing the character
        await sendMessageAsUser(mesText, '');
    }

    setCharacterId(character);

    const { name, force_avatar, original_avatar } = getNameAndAvatarForMessage(character, args?.name);

    setCharacterName(name);

    const restoreCharacter = () => {
        if (getCurrentCharacter()?.avatar !== character.avatar) {
            return;
        }

        if (prevAvatar !== undefined) {
            setCharacterId(charactersStore.get(prevAvatar));
            setCharacterName(charactersStore.get(prevAvatar)?.name);
        } else {
            setCharacterId(undefined);
            setCharacterName(neutralCharacterName);
        }

        // Only force the new avatar if the character name matches
        const lastMessage = chat[chat.length - 1];
        if (lastMessage && lastMessage?.name === name) {
            lastMessage.force_avatar = force_avatar;
            lastMessage.original_avatar = original_avatar;
        }
    };

    let askResult = '';

    try {
        eventSource.once(event_types.MESSAGE_RECEIVED, restoreCharacter);
        toastr.info(t`Asking ${name} something...`);
        askResult = await Generate('normal');
    } catch (error) {
        restoreCharacter();
        console.error('Error running /ask command', error);
    } finally {
        if (getCurrentCharacter()?.avatar === prevAvatar) {
            await saveChatConditional();
        } else {
            toastr.error(t`It is strongly recommended to reload the page.`, t`Something went wrong`);
        }
    }

    const message = askResult ? chat[chat.length - 1] : null;

    return await slashCommandReturnHelper.doReturn(args.return ?? 'pipe', message, { objectToStringFunc: x => x.mes });
}

async function hideMessageCallback(args, value) {
    const range = value ? stringToRange(value, 0, chat.length - 1) : { start: chat.length - 1, end: chat.length - 1 };

    if (!range) {
        console.warn(`WARN: Invalid range provided for /hide command: ${value}`);
        return '';
    }

    const nameFilter = String(args.name ?? '').trim();
    await hideChatMessageRange(range.start, range.end, false, nameFilter);
    return '';
}

async function unhideMessageCallback(args, value) {
    const range = value ? stringToRange(value, 0, chat.length - 1) : { start: chat.length - 1, end: chat.length - 1 };

    if (!range) {
        console.warn(`WARN: Invalid range provided for /unhide command: ${value}`);
        return '';
    }

    const nameFilter = String(args.name ?? '').trim();
    await hideChatMessageRange(range.start, range.end, true, nameFilter);
    return '';
}

async function triggerGenerationCallback(args, value) {
    const shouldAwait = isTrueBoolean(args?.await);
    const outerPromise = new Promise((outerResolve) => setTimeout(async () => {
        try {
            await waitUntilCondition(() => !is_send_press && !is_group_generating, 10000, 100);
        } catch {
            console.warn('Timeout waiting for generation unlock');
            toastr.warning(t`Cannot run /trigger command while the reply is being generated.`);
            outerResolve(Promise.resolve(''));
            return '';
        }

        // Prevent generate recursion
        $('#send_textarea').val('')[0].dispatchEvent(new Event('input', { bubbles: true }));

        let avatar = undefined;

        if (selected_group && value) {
            avatar = findGroupMemberId(value);

            if (avatar === undefined) {
                console.warn(`WARN: No group member found for argument ${value}`);
            }
        }

        outerResolve(new Promise(innerResolve => setTimeout(() => innerResolve(Generate('normal', { force_avatar: avatar })), 100)));
    }, 1));

    if (shouldAwait) {
        const innerPromise = await outerPromise;
        await innerPromise;
    }

    return '';
}

async function sendUserMessageCallback(args, text) {
    text = String(text ?? '').trim();
    const compact = isTrueBoolean(args?.compact);
    const bias = extractMessageBias(text);

    let insertAt = Number(args?.at);

    if (!isNaN(insertAt) && (insertAt < 0 || Object.is(insertAt, -0))) {
        // Negative depth counts back from chat length (e.g. 8 messages, depth 1 = index 7)
        insertAt = chat.length + insertAt;
    }

    let message;
    if ('name' in args) {
        const name = args.name || '';
        const avatar = findPersona({ name })?.avatar || user_avatar;
        message = await sendMessageAsUser(text, bias, insertAt, compact, name, avatar);
    } else {
        message = await sendMessageAsUser(text, bias, insertAt, compact);
    }

    return await slashCommandReturnHelper.doReturn(args.return ?? 'none', message, { objectToStringFunc: x => x.mes });
}

async function goToCharacterCallback(_, name) {
    if (!name) {
        console.warn('WARN: No character name provided for /go command');
        return;
    }

    const character = await findCharAsync({ name: name });
    if (character) {
        await openChat(character.avatar);
        setActiveCharacter(character.avatar);
        setActiveGroup(null);
        return character.name;
    }
    const group = groups.find(it => equalsIgnoreCaseAndAccents(it.name, name));
    if (group) {
        await openGroupById(group.id);
        setActiveCharacter(null);
        setActiveGroup(group.id);
        return group.name;
    }
    console.warn(`No matches found for name "${name}"`);
    return '';
}

async function openChat(avatar) {
    resetSelectedGroup();
    setCharacterId(avatar);
    await delay(1);
    await reloadCurrentChat();
}

async function continueChatCallback(args, prompt) {
    const shouldAwait = isTrueBoolean(args?.await);

    const outerPromise = new Promise(async (resolve, reject) => {
        try {
            await waitUntilCondition(() => !is_send_press && !is_group_generating, 10000, 100);
        } catch {
            console.warn('Timeout waiting for generation unlock');
            toastr.warning(t`Cannot run /continue command while the reply is being generated.`);
            return reject();
        }

        try {
            // Prevent infinite recursion
            $('#send_textarea').val('')[0].dispatchEvent(new Event('input', { bubbles: true }));

            const options = prompt?.trim() ? { quiet_prompt: prompt.trim(), quietToLoud: true } : {};
            await Generate('continue', options);

            resolve();
        } catch (error) {
            console.error('Error running /continue command:', error);
            reject(error);
        }
    });

    if (shouldAwait) {
        await outerPromise;
    }

    return '';
}

async function regenerateChatCallback(args) {
    const shouldAwait = isTrueBoolean(args?.await);

    const outerPromise = new Promise((outerResolve) => setTimeout(async () => {
        try {
            await waitUntilCondition(() => !is_send_press && !is_group_generating, 10000, 100);
        } catch {
            console.warn('Timeout waiting for generation unlock');
            toastr.warning(t`Cannot run /regenerate command while the reply is being generated.`);
            outerResolve(Promise.resolve(''));
            return '';
        }

        if (selected_group) {
            outerResolve(Promise.resolve(regenerateGroup()));
            return '';
        }

        outerResolve(new Promise(innerResolve => setTimeout(() => {
            innerResolve(Generate('regenerate'));
        }, 1)));
        return '';
    }, 1));

    if (shouldAwait) {
        const innerPromise = await outerPromise;
        await innerPromise;
    }

    return '';
}

async function swipeChatCallback(args) {
    const shouldAwait = isTrueBoolean(args?.await);
    const direction = args?.direction === SWIPE_DIRECTION.LEFT ? SWIPE_DIRECTION.LEFT : SWIPE_DIRECTION.RIGHT;

    const outerPromise = new Promise((outerResolve) => setTimeout(async () => {
        try {
            await waitUntilCondition(() => !is_send_press && !is_group_generating, 10000, 100);
        } catch {
            console.warn('Timeout waiting for generation unlock');
            toastr.warning(t`Cannot run /swipe command while the reply is being generated.`);
            outerResolve(Promise.resolve(''));
            return '';
        }

        outerResolve(Promise.resolve(swipe(null, direction, { source: SWIPE_SOURCE.SLASH_COMMAND, repeated: false })));
        return '';
    }, 1));

    if (shouldAwait) {
        const innerPromise = await outerPromise;
        await innerPromise;
    }

    return '';
}

function setStoryModeCallback() {
    $('#chat_display').val(chat_styles.DOCUMENT).trigger('change');
    return '';
}

function setBubbleModeCallback() {
    $('#chat_display').val(chat_styles.BUBBLES).trigger('change');
    return '';
}

function setFlatModeCallback() {
    $('#chat_display').val(chat_styles.DEFAULT).trigger('change');
    return '';
}

async function setNarratorName(_, text) {
    const name = text || NARRATOR_NAME_DEFAULT;
    chat_metadata[NARRATOR_NAME_KEY] = name;
    toastr.info(t`System narrator name set to ${name}`);
    await saveChatConditional();
    return '';
}

/**
 * @param {string} role - Role to change to.
 *
 * @returns {Promise<string>} The updated message role.
 */
async function messageRoleCallback(args, role) {
    let modifyAt = Number(args?.at ?? (chat.length - 1));
    if (!isNaN(modifyAt) && (modifyAt < 0 || Object.is(modifyAt, -0))) {
        // Negative depth counts back from chat length (e.g. 8 messages, depth 1 = index 7)
        modifyAt = chat.length + modifyAt;
    }

    const message = chat[modifyAt];
    if (!message) {
        toastr.warning(t`No message found at the specified index.`);
        return '';
    }

    role = String(role ?? '').trim().toLowerCase();
    if (!role || !['user', 'assistant', 'system'].includes(role)) {
        return message?.extra?.type === system_message_types.NARRATOR
            ? 'system'
            : message.is_user ? 'user' : 'assistant';
    }

    const extra = { ...(message.extra ?? {}) };
    if (role === 'system') {
        extra.type = system_message_types.NARRATOR;
    } else {
        delete extra.type;
    }
    updateMessage(modifyAt, { extra, is_user: role === 'user' });

    await eventSource.emit(event_types.MESSAGE_EDITED, modifyAt);
    const existingMessage = chatElement.find(`.mes[mesid="${modifyAt}"]`);
    if (existingMessage.length) {
        const newMessageElement = updateMessageElement(message, { messageId: modifyAt });
        existingMessage.after(newMessageElement);
        existingMessage.remove();
    }
    await eventSource.emit(event_types.MESSAGE_UPDATED, modifyAt);
    await chatOpEdit(modifyAt).catch(error =>
        console.error('Could not save the role change for that message:', error));

    return role;
}

/**
 * @param {string} name - Name to change to.
 *
 * @returns {Promise<string>} The updated message name.
 */
async function messageNameCallback(args, name) {
    let modifyAt = Number(args?.at ?? (chat.length - 1));
    if (!isNaN(modifyAt) && (modifyAt < 0 || Object.is(modifyAt, -0))) {
        // Negative depth counts back from chat length (e.g. 8 messages, depth 1 = index 7)
        modifyAt = chat.length + modifyAt;
    }

    const message = chat[modifyAt];
    if (!message) {
        toastr.warning(t`No message found at the specified index.`);
        return '';
    }

    name = String(name ?? '').trim();
    if (!name) {
        return message.name;
    }

    let newName = '';
    const updates = {};

    if (message.is_user) {
        const persona = findPersona({ name: name });
        if (persona) {
            updates.name = newName = persona.name;
            updates.force_avatar = getThumbnailUrl('persona', persona.avatar);
            updates.original_avatar = persona.avatar;
        } else {
            updates.name = newName = name;
            updates.force_avatar = default_avatar;
            updates.original_avatar = default_avatar;
        }
    } else {
        const character = await findCharAsync({ name: name });
        if (character) {
            const characterInfo = getNameAndAvatarForMessage(character, name);
            updates.name = newName = characterInfo.name;
            updates.force_avatar = characterInfo.force_avatar;
            updates.original_avatar = characterInfo.original_avatar;
        } else {
            updates.name = newName = name;
            updates.force_avatar = default_avatar;
            updates.original_avatar = default_avatar;
        }
    }
    updateMessage(modifyAt, updates);

    await eventSource.emit(event_types.MESSAGE_EDITED, modifyAt);
    const existingMessage = chatElement.find(`.mes[mesid="${modifyAt}"]`);
    if (existingMessage.length) {
        const newMessageElement = updateMessageElement(chat[modifyAt], { messageId: modifyAt });
        existingMessage.after(newMessageElement);
        existingMessage.remove();
    }
    await eventSource.emit(event_types.MESSAGE_UPDATED, modifyAt);
    await chatOpEdit(modifyAt).catch(error =>
        console.error('Could not save the name change for that message:', error));

    return newName;
}

async function sendCommentMessage(args, text) {
    const compact = isTrueBoolean(args?.compact);
    const message = {
        name: COMMENT_NAME_DEFAULT,
        is_user: false,
        is_system: true,
        send_date: getMessageTimeStamp(),
        mes: substituteParams(String(text ?? '').trim()),
        force_avatar: comment_avatar,
        extra: {
            type: system_message_types.COMMENT,
            gen_id: Date.now(),
            isSmallSys: compact,
            api: 'manual',
            model: 'slash command',
        },
    };

    let insertAt = Number(args.at);

    if (!isNaN(insertAt) && (insertAt < 0 || Object.is(insertAt, -0))) {
        // Negative depth counts back from chat length (e.g. 8 messages, depth 1 = index 7)
        insertAt = chat.length + insertAt;
    }

    chat_metadata.tainted = true;

    if (!isNaN(insertAt) && insertAt >= 0 && insertAt <= chat.length) {
        chat.splice(insertAt, 0, message);
        // Mid-chain insert is a graft, not a diff-engine-visible change — see sendMessageAsUser()'s
        // own insertAt branch for the same reasoning.
        await chatOpGraft(insertAt).catch(error =>
            console.error('Could not save the inserted message:', error));
        await eventSource.emit(event_types.MESSAGE_SENT, insertAt);
        await reloadCurrentChat();
        await eventSource.emit(event_types.USER_MESSAGE_RENDERED, insertAt);
    } else {
        const newIndex = chat.length;
        chat.push(message);
        await eventSource.emit(event_types.MESSAGE_SENT, (chat.length - 1));
        addOneMessage(message);
        await eventSource.emit(event_types.USER_MESSAGE_RENDERED, (chat.length - 1));
        await chatOpAppend(newIndex).catch(error =>
            console.error('Could not save the new message:', error));
    }

    return await slashCommandReturnHelper.doReturn(args.return ?? 'none', message, { objectToStringFunc: x => x.mes });
}

export function registerMessageCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'message-role',
        callback: messageRoleCallback,
        returns: 'The role of the message sender',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'at',
                description: 'the ID of the message to modify (index-based, corresponding to message id). If omitted, the last message is chosen.\nNegative values are accepted and will work similarly to how \'depth\' usually works. For example, -1 will modify the message right before the last message in chat. At must be nonzero.',
                typeList: [ARGUMENT_TYPE.NUMBER],
                defaultValue: '',
                enumProvider: commonEnumProviders.messages({ allowIdAfter: true }),
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Role to set for the message sender (user, assistant, system)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                enumProvider: commonEnumProviders.messageRoles,
            }),
        ],
        helpString: `
        <div>
            Changes the role of a message sender to one of your choice.
            If no role is provided, just gets the current role of the message sender.
            If no index is provided, the last message is chosen.
        </div>
        <div>
            <strong>Example:</strong>
            <ul>
                <li>
                    <pre><code>/message-role | /echo</code></pre>
                    Will output the role of the sender of the last message.
                </li>
                <li>
                    <pre><code>/message-role at=-2 assistant</code></pre>
                    Will change the third message from the bottom to be sent by the assistant.
                </li>
            </ul>
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'message-name',
        callback: messageNameCallback,
        returns: 'The name of the message sender',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'at',
                description: 'the ID of the message to modify (index-based, corresponding to message id). If omitted, the last message is chosen.\nNegative values are accepted and will work similarly to how \'depth\' usually works. For example, -1 will modify the message right before the last message in chat. At must be nonzero.',
                typeList: [ARGUMENT_TYPE.NUMBER],
                defaultValue: '',
                enumProvider: commonEnumProviders.messages({ allowIdAfter: true }),
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Persona name, character name, or unique character identifier (avatar key)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                enumProvider: (executor) => {
                    let modifyAt = Number(executor.namedArgumentList.find(arg => arg.name === 'at')?.value ?? (chat.length - 1));
                    if (!isNaN(modifyAt) && (modifyAt < 0 || Object.is(modifyAt, -0))) {
                        modifyAt = chat.length + modifyAt;
                    }
                    return chat[modifyAt]?.is_user
                        ? commonEnumProviders.personas()()
                        : commonEnumProviders.characters('character')();
                },
            }),
        ],
        helpString: `
        <div>
            Changes the name of a message sender to one of your choice.
            If no name is provided, just gets the current name of the message sender.
            If no index is provided, the last message is chosen.
        </div>
        <div>
            <strong>Example:</strong>
            <ul>
                <li>
                    <pre><code>/message-name | /echo</code></pre>
                    Will output the name of the sender of the last message.
                </li>
                <li>
                    <pre><code>/message-name at=-2 "Chloe"</code></pre>
                    Will change the third message from the bottom to be sent by "Chloe".
                </li>
            </ul>
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sendas',
        rawQuotes: true,
        callback: sendMessageAs,
        returns: t`Optionally the text of the sent message, if specified in the "return" argument`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: t`Character name - or unique character identifier (avatar key)`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.characters('character'),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'avatar',
                description: t`Character avatar override (Can be either avatar key or just the character name to pull the avatar from)`,
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: commonEnumProviders.characters('character'),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'compact',
                description: t`Use compact layout`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'at',
                description: t`position to insert the message (index-based, corresponding to message id). If not set, the message will be inserted at the end of the chat.\nNegative values (including -0) are accepted and will work similarly to how 'depth' usually works. For example, -1 will insert the message right before the last message in chat.`,
                typeList: [ARGUMENT_TYPE.NUMBER],
                enumProvider: commonEnumProviders.messages({ allowIdAfter: true }),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'return',
                description: t`The way how you want the return value to be provided`,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'none',
                enumList: slashCommandReturnHelper.enumList({ allowObject: true }),
                forceEnum: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'raw',
                description: t`If true, does not alter quoted literal unnamed arguments`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
                enumProvider: commonEnumProviders.boolean('trueFalse'),
                isRequired: false,
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'text', [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: `
        <div>
            ${t`Sends a message as a specific character. Uses the character avatar if it exists in the characters list.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/sendas name="Chloe" Hello, guys!</code></pre>
                    ${t`will send "Hello, guys!" from "Chloe".`}
                </li>
                <li>
                    <pre><code>/sendas name="Chloe" avatar="BigBadBoss" Hehehe, I am the big bad evil, fear me.</code></pre>
                    ${t`will send a message as the character "Chloe", but utilizing the avatar from a character named "BigBadBoss".`}
                </li>
            </ul>
        </div>
        <div>
            ${t`If "compact" is set to true, the message is sent using a compact layout.`}
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sys',
        rawQuotes: true,
        callback: sendNarratorMessage,
        aliases: ['nar'],
        returns: t`Optionally the text of the sent message, if specified in the "return" argument`,
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'compact',
                t`compact layout`,
                [ARGUMENT_TYPE.BOOLEAN],
                false,
                false,
                'false',
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'at',
                description: t`position to insert the message (index-based, corresponding to message id). If not set, the message will be inserted at the end of the chat.\nNegative values (including -0) are accepted and will work similarly to how 'depth' usually works. For example, -1 will insert the message right before the last message in chat.`,
                typeList: [ARGUMENT_TYPE.NUMBER],
                enumProvider: commonEnumProviders.messages({ allowIdAfter: true }),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: t`Optional custom display name to use for this system narrator message.`,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'return',
                description: t`The way how you want the return value to be provided`,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'none',
                enumList: slashCommandReturnHelper.enumList({ allowObject: true }),
                forceEnum: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'raw',
                description: t`If true, does not alter quoted literal unnamed arguments`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
                enumProvider: commonEnumProviders.boolean('trueFalse'),
                isRequired: false,
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'text', [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: `
        <div>
            ${t`Sends a message as a system narrator.`}
        </div>
        <div>
            ${t`If <code>compact</code> is set to <code>true</code>, the message is sent using a compact layout.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/sys The sun sets in the west.</code></pre>
                </li>
                <li>
                    <pre><code>/sys compact=true A brief note.</code></pre>
                </li>
            </ul>
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sysname',
        callback: setNarratorName,
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`name`, [ARGUMENT_TYPE.STRING], false,
            ),
        ],
        helpString: t`Sets a name for future system narrator messages in this chat (display only). Default: System. Leave empty to reset.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'comment',
        rawQuotes: true,
        callback: sendCommentMessage,
        returns: t`Optionally the text of the sent message, if specified in the "return" argument`,
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'compact',
                t`Whether to use a compact layout`,
                [ARGUMENT_TYPE.BOOLEAN],
                false,
                false,
                'false',
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'at',
                description: t`position to insert the message (index-based, corresponding to message id). If not set, the message will be inserted at the end of the chat.\nNegative values (including -0) are accepted and will work similarly to how 'depth' usually works. For example, -1 will insert the message right before the last message in chat.`,
                typeList: [ARGUMENT_TYPE.NUMBER],
                enumProvider: commonEnumProviders.messages({ allowIdAfter: true }),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'return',
                description: t`The way how you want the return value to be provided`,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'none',
                enumList: slashCommandReturnHelper.enumList({ allowObject: true }),
                forceEnum: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'raw',
                description: t`If true, does not alter quoted literal unnamed arguments`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
                enumProvider: commonEnumProviders.boolean('trueFalse'),
                isRequired: false,
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'text',
                [ARGUMENT_TYPE.STRING],
                true,
            ),
        ],
        helpString: `
        <div>
            ${t`Adds a note/comment message not part of the chat.`}
        </div>
        <div>
            ${t`If <code>compact</code> is set to <code>true</code>, the message is sent using a compact layout.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/comment This is a comment</code></pre>
                </li>
                <li>
                    <pre><code>/comment compact=true This is a compact comment</code></pre>
                </li>
            </ul>
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'single',
        callback: setStoryModeCallback,
        aliases: ['story'],
        helpString: t`Sets the message style to single document mode without names or avatars visible.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'bubble',
        callback: setBubbleModeCallback,
        aliases: ['bubbles'],
        helpString: t`Sets the message style to bubble chat mode.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'flat',
        callback: setFlatModeCallback,
        aliases: ['default'],
        helpString: t`Sets the message style to flat chat mode.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'continue',
        callback: continueChatCallback,
        aliases: ['cont'],
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'await',
                t`Whether to await for the continued generation before proceeding`,
                [ARGUMENT_TYPE.BOOLEAN],
                false,
                false,
                'false',
            ),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'prompt', [ARGUMENT_TYPE.STRING], false,
            ),
        ],
        helpString: `
        <div>
            ${t`Continues the last message in the chat, with an optional additional prompt.`}
        </div>
        <div>
            ${t`If <code>await=true</code> named argument is passed, the command will await for the continued generation before proceeding.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/continue</code></pre>
                    ${t`Continues the chat with no additional prompt and immediately proceeds to the next command.`}
                </li>
                <li>
                    <pre><code>/continue await=true Let's explore this further...</code></pre>
                    ${t`Continues the chat with the provided prompt and waits for the generation to finish.`}
                </li>
            </ul>
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'regenerate',
        callback: regenerateChatCallback,
        aliases: ['regen'],
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'await',
                t`Whether to await for the regeneration before proceeding`,
                [ARGUMENT_TYPE.BOOLEAN],
                false,
                false,
                'false',
            ),
        ],
        helpString: `
        <div>
            ${t`Regenerates the latest reply in the chat.`}
        </div>
        <div>
            ${t`If <code>await=true</code> named argument is passed, the command will await for the regeneration before proceeding.`}
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'swipe',
        callback: swipeChatCallback,
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'direction',
                t`Swipe direction`,
                [ARGUMENT_TYPE.STRING],
                false,
                false,
                SWIPE_DIRECTION.RIGHT,
                [
                    new SlashCommandEnumValue(SWIPE_DIRECTION.RIGHT, t`Swipe to the next reply`, enumTypes.enum, enumIcons.default),
                    new SlashCommandEnumValue(SWIPE_DIRECTION.LEFT, t`Swipe to the previous reply`, enumTypes.enum, enumIcons.default),
                ],
                [],
                null,
                true,
            ),
            new SlashCommandNamedArgument(
                'await',
                t`Whether to await for the swipe action before proceeding`,
                [ARGUMENT_TYPE.BOOLEAN],
                false,
                false,
                'false',
            ),
        ],
        helpString: `
        <div>
            ${t`Swipes the latest reply. Defaults to <code>direction=right</code>; use <code>direction=left</code> to go to the previous reply. If no next swipe exists, behavior depends on message context.`}
        </div>
        <div>
            ${t`If <code>await=true</code> named argument is passed, the command will await for the swipe action before proceeding.`}
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'go',
        callback: goToCharacterCallback,
        returns: t`The character/group name`,
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`Character name - or unique character identifier (avatar key)`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.characters('all'),
            }),
        ],
        helpString: t`Opens up a chat with the character or group by its name`,
        aliases: ['char'],
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sysgen',
        callback: generateSystemMessage,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'trim',
                description: t`Trim the output by the last sentence boundary`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                isRequired: false,
                enumProvider: commonEnumProviders.boolean('trueFalse'),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'compact',
                description: t`Use a compact layout for the message`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'false',
                isRequired: false,
                acceptsMultiple: false,
                enumProvider: commonEnumProviders.boolean('trueFalse'),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'at',
                description: t`Position to insert the message (index-based, corresponding to message id). If not set, the message will be inserted at the end of the chat.\nNegative values (including -0) are accepted and will work similarly to how 'depth' usually works. For example, -1 will insert the message right before the last message in chat.`,
                typeList: [ARGUMENT_TYPE.NUMBER],
                enumProvider: commonEnumProviders.messages({ allowIdAfter: true }),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: t`Optional custom display name to use for this system narrator message.`,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'return',
                description: t`The way how you want the return value to be provided`,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'none',
                enumList: slashCommandReturnHelper.enumList({ allowObject: true }),
                forceEnum: true,
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'prompt', [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: t`Generates a system message using a specified prompt.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'ask',
        callback: askCharacter,
        returns: t`Optionally the text of the sent message, if specified in the "return" argument`,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: t`Character name - or unique character identifier (avatar key)`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: commonEnumProviders.characters('character'),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'return',
                description: t`The way how you want the return value to be provided`,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'pipe',
                enumList: slashCommandReturnHelper.enumList({ allowObject: true }),
                forceEnum: true,
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'prompt', [ARGUMENT_TYPE.STRING], false, false,
            ),
        ],
        helpString: t`Asks a specified character card a prompt. Character name must be provided in a named argument.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'send',
        rawQuotes: true,
        callback: sendUserMessageCallback,
        returns: t`Optionally the text of the sent message, if specified in the "return" argument`,
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'compact',
                t`whether to use a compact layout`,
                [ARGUMENT_TYPE.BOOLEAN],
                false,
                false,
                'false',
            ),
            SlashCommandNamedArgument.fromProps({
                name: 'at',
                description: t`position to insert the message (index-based, corresponding to message id). If not set, the message will be inserted at the end of the chat.\nNegative values (including -0) are accepted and will work similarly to how 'depth' usually works. For example, -1 will insert the message right before the last message in chat.`,
                typeList: [ARGUMENT_TYPE.NUMBER],
                enumProvider: commonEnumProviders.messages({ allowIdAfter: true }),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: t`display name`,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: '{{user}}',
                enumProvider: commonEnumProviders.personas({ allowPersonaKey: true }),
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'return',
                description: t`The way how you want the return value to be provided`,
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'none',
                enumList: slashCommandReturnHelper.enumList({ allowObject: true }),
                forceEnum: true,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'raw',
                description: t`If true, does not alter quoted literal unnamed arguments`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                defaultValue: 'true',
                enumProvider: commonEnumProviders.boolean('trueFalse'),
                isRequired: false,
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'text',
                [ARGUMENT_TYPE.STRING],
                true,
            ),
        ],
        helpString: `
        <div>
            ${t`Adds a user message to the chat log without triggering a generation.`}
        </div>
        <div>
            ${t`If <code>compact</code> is set to <code>true</code>, the message is sent using a compact layout.`}
        </div>
        <div>
            ${t`If <code>name</code> is set, it will be displayed as the message sender. Can be an empty for no name.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/send Hello there!</code></pre>
                </li>
                <li>
                    <pre><code>/send compact=true Hi</code></pre>
                </li>
            </ul>
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'trigger',
        callback: triggerGenerationCallback,
        namedArgumentList: [
            new SlashCommandNamedArgument(
                'await',
                t`Whether to await for the triggered generation before continuing`,
                [ARGUMENT_TYPE.BOOLEAN],
                false,
                false,
                'false',
            ),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`group member index (starts with 0) or name`,
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.STRING],
                isRequired: false,
                enumProvider: commonEnumProviders.groupMembers(),
            }),
        ],
        helpString: `
        <div>
            ${t`Triggers a message generation. If in group, can trigger a message for the specified group member index or name.`}
        </div>
        <div>
            ${t`If <code>await=true</code> named argument is passed, the command will await for the triggered generation before continuing.`}
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'hide',
        callback: hideMessageCallback,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: t`only hide messages from a certain character or persona`,
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: commonEnumProviders.messageNames,
                isRequired: false,
                acceptsMultiple: false,
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`message index (starts with 0) or range, defaults to the last message index if not provided`,
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.RANGE],
                isRequired: false,
                enumProvider: commonEnumProviders.messages(),
            }),
        ],
        helpString: t`Hides a chat message from the prompt.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'unhide',
        callback: unhideMessageCallback,
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'name',
                description: t`only unhide messages from a certain character or persona`,
                typeList: [ARGUMENT_TYPE.STRING],
                enumProvider: commonEnumProviders.messageNames,
                isRequired: false,
                acceptsMultiple: false,
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`message index (starts with 0) or range, defaults to the last message index if not provided`,
                typeList: [ARGUMENT_TYPE.NUMBER, ARGUMENT_TYPE.RANGE],
                isRequired: false,
                enumProvider: commonEnumProviders.messages(),
            }),
        ],
        helpString: t`Unhides a message from the prompt.`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'delswipe',
        callback: deleteSwipeCallback,
        returns: t`the new, currently selected swipe id`,
        aliases: ['swipedel'],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: t`1-based swipe id`,
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: true,
                enumProvider: () => Array.isArray(chat[chat.length - 1]?.swipes) ?
                    chat[chat.length - 1].swipes.map((/** @type {string} */ swipe, /** @type {number} */ i) => new SlashCommandEnumValue(String(i + 1), swipe, enumTypes.enum, enumIcons.message))
                    : [],
            }),
        ],
        helpString: `
        <div>
            ${t`Deletes a swipe from the last chat message. If swipe id is not provided, it deletes the current swipe.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/delswipe</code></pre>
                    ${t`Deletes the current swipe.`}
                </li>
                <li>
                    <pre><code>/delswipe 2</code></pre>
                    ${t`Deletes the second swipe from the last chat message.`}
                </li>
            </ul>
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'addswipe',
        callback: addSwipeCallback,
        returns: t`the new swipe id`,
        aliases: ['swipeadd'],
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'switch',
                description: t`switch to the new swipe`,
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: commonEnumProviders.boolean()(),
            }),
        ],
        unnamedArgumentList: [
            new SlashCommandArgument(
                'text', [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: `
        <div>
            ${t`Adds a swipe to the last chat message.`}
        </div>
        <div>
            ${t`Use switch=true to switch to directly switch to the new swipe.`}
        </div>`,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'trimstart',
        callback: trimStartCallback,
        returns: t`trimmed text`,
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`text`, [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: `
        <div>
            ${t`Trims the text to the start of the first full sentence.`}
        </div>
        <div>
            <strong>${t`Example:`}</strong>
            <ul>
                <li>
                    <pre><code>/trimstart This is a sentence. And here is another sentence.</code></pre>
                </li>
            </ul>
        </div>
    `,
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'trimend',
        callback: trimEndCallback,
        returns: t`trimmed text`,
        unnamedArgumentList: [
            new SlashCommandArgument(
                t`text`, [ARGUMENT_TYPE.STRING], true,
            ),
        ],
        helpString: t`Trims the text to the end of the last full sentence.`,
    }));
}
