import {
    getCurrentCharacter,
    getSelectionState,
    system_message_types,
    openCharacterChat,
    characterAvatar,
    characterThumbnail,
    updateMessage,
    hydrateSwipes,
    switchToNode,
    isStoredNodeId,
    isProvisionalNodeId,
    takeChatOpenAnswer,
    chatOpenAsk,
    adoptStored,
    openingForRequest,
} from '../script.js';
import { getCharacters } from './character-list.js';
import { chat_metadata, chat } from './chat-state.js';
import { setActiveGroup } from './app-selection-state.js';
import { getRequestHeaders } from './request-headers.js';
import { holdGroup } from './group-store.js';
import {
    DEFAULT_AUTO_MODE_DELAY,
    group_activation_strategy,
    group_generation_mode,
    groupsStore,
    openGroupById,
    openGroupChat,
    selected_group,
} from './group-chats.js';
import { loader } from './action-loader.js';
import { getLastMessageId } from './macros.js';
import { Popup } from './popup.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from './slash-commands/SlashCommandArgument.js';
import { commonEnumProviders } from './slash-commands/SlashCommandCommonEnumsProvider.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { createTagMapFromList } from './tags.js';
import { renderTemplateAsync } from './templates.js';
import { compressRequest } from './request-compression.js';
import { t } from './i18n.js';

import {
    isTrueBoolean,
} from './utils.js';
import { normalizeFav } from './hash-utils.js';

const bookmarkNameToken = 'Bookmark #';

/**
 * The names of the open character's or group's chats: each chat's label, or its compat id when it has none.
 * @returns {Promise<string[]>}
 */
async function getExistingChatNames() {
    const character = getCurrentCharacter();
    if (!selected_group && !character) {
        return [];
    }

    const response = selected_group
        ? await fetch('/api/chats/search', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ query: '', group_id: selected_group }),
        })
        : await fetch('/api/characters/chats', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: character.avatar, simple: true }),
        });

    if (response.ok) {
        const data = await response.json();
        if (!Array.isArray(data)) {
            return [];
        }
        return data.map(x => x.label ?? String(x.file_name).replace(/\.jsonl$/, ''));
    }

    return [];
}

async function getBookmarkName({ isReplace = false, forceName = null } = {}) {
    const suggestion = await fetch('/api/chats/bookmark-name', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(_labelOwner()) });
    if (!suggestion.ok) {
        toastr.error('Could not suggest a bookmark name.', 'Bookmark');
        return null;
    }
    const suggestedName = String((await suggestion.json()).name);

    const body = await renderTemplateAsync('createCheckpoint', { isReplace: isReplace, suggestedName: suggestedName });
    let name = forceName ?? await Popup.show.input('Bookmark', body, suggestedName);
    if (name === '') {
        name = suggestedName;
    }
    if (!name) {
        return null;
    }

    return name;
}

function getMainChatName() {
    if (chat_metadata) {
        if (chat_metadata.main_chat) {
            return chat_metadata.main_chat;
        } else if (selected_group) {
            // groups didn't support bookmarks before chat metadata was introduced
            return null;
        } else if (getCurrentCharacter().chat && getCurrentCharacter().chat.includes(bookmarkNameToken)) {
            const tokenIndex = getCurrentCharacter().chat.lastIndexOf(bookmarkNameToken);
            chat_metadata.main_chat = getCurrentCharacter().chat.substring(0, tokenIndex).trim();
            return chat_metadata.main_chat;
        }
    }
    return null;
}

export function showBookmarksButtons() {
    try {
        if (selected_group) {
            $('#option_convert_to_group').hide();
        } else {
            $('#option_convert_to_group').show();
        }

        if (chat_metadata.main_chat) {
            // In bookmark chat
            $('#option_back_to_main').show();
            $('#option_new_bookmark').show();
        } else if (!selected_group && !getCurrentCharacter().chat) {
            // No chat recorded on character
            $('#option_back_to_main').hide();
            $('#option_new_bookmark').hide();
        } else {
            // In main chat
            $('#option_back_to_main').hide();
            $('#option_new_bookmark').show();
        }
    } catch {
        $('#option_back_to_main').hide();
        $('#option_new_bookmark').hide();
        $('#option_convert_to_group').hide();
    }
}

async function saveBookmarkMenu() {
    if (!chat.length) {
        toastr.warning('The chat is empty.', 'Bookmark creation failed');
        return;
    }

    return await createNewBookmark(chat.length - 1);
}

function _labelOwner() {
    return selected_group ? { group_id: selected_group } : { avatar_url: getCurrentCharacter()?.avatar };
}

/**
 * @typedef {object} BookmarkAnswer
 * @property {string} id The bookmark's chat id (its label).
 * @property {string} label The name the bookmark got.
 * @property {string[]} [chats] A group's chats, the bookmark among them.
 * @property {import('../script.js').ChatOpenAnswer} [opened] With `open`: the bookmark, opened.
 */

/**
 * @param {number} mesId
 * @param {object} options
 * @param {string} [options.label]
 * @param {string|null} [options.nodeId]
 * @param {boolean} [options.unique]
 * @param {string|null} [options.alsoNodeId]
 * @param {boolean} [options.open]
 * @returns {Promise<BookmarkAnswer|null>}
 */
async function requestBookmark(mesId, { label, nodeId = null, unique = false, alsoNodeId = null, open = false }) {
    const owner = _labelOwner();
    const message = chat[mesId];
    /** @type {Record<string, unknown>} */
    const body = {
        ...owner,
        ...(label === undefined ? {} : { label }),
        unique,
    };
    if (nodeId) {
        body.node_id = nodeId;
    } else if (isStoredNodeId(message?.node_id)) {
        body.node_id = message.node_id;
    } else if (isProvisionalNodeId(message?.node_id)) {
        const opening = openingForRequest(mesId);
        if (!opening) return null;
        Object.assign(body, opening);
    } else {
        return null;
    }
    if (alsoNodeId) body.also_node_id = alsoNodeId;
    if (open) {
        body.open = true;
        Object.assign(body, chatOpenAsk(owner));
    }
    const response = await fetch('/api/chats/bookmark', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
    if (!response.ok) return null;
    const answer = await response.json();
    adoptStored(answer.stored);
    if (selected_group && Array.isArray(answer.chats)) groupsStore.update(selected_group, { chats: answer.chats });
    if (answer.opened) takeChatOpenAnswer(owner, answer.opened);
    return answer;
}

export async function createBranch(mesId, { swipeId = null } = {}) {
    return (await makeBranch(mesId, { swipeId }))?.id ?? undefined;
}

/**
 * @param {number} mesId
 * @param {{ swipeId?: number|null, open?: boolean, alsoLabelShown?: boolean }} [options]
 * @returns {Promise<BookmarkAnswer|null|undefined>}
 */
async function makeBranch(mesId, { swipeId = null, open = false, alsoLabelShown = false } = {}) {
    if (!chat.length) {
        toastr.warning('The chat is empty.', 'Branch creation failed');
        return;
    }

    if (mesId < 0 || mesId >= chat.length) {
        toastr.warning('Invalid message ID.', 'Branch creation failed');
        return;
    }

    const lastMes = chat[mesId];
    const selectedSwipeId = swipeId === null ? null : Number(swipeId);

    if (selectedSwipeId !== null && (!Number.isInteger(selectedSwipeId) || selectedSwipeId < 0 || selectedSwipeId >= (lastMes?.swipes?.length ?? 0))) {
        toastr.warning('Invalid swipe ID.', 'Branch creation failed');
        return;
    }

    if (isStoredNodeId(lastMes?.node_id) || isProvisionalNodeId(lastMes?.node_id)) {
        /** @type {string|null} */
        let nodeId = null;
        if (selectedSwipeId !== null) {
            await hydrateSwipes(Number(mesId), { index: selectedSwipeId });
            const swipeNodeId = chat[mesId]?.swipe_info?.[selectedSwipeId]?.node_id;
            if (!isStoredNodeId(swipeNodeId)) {
                toastr.warning('Could not prepare the selected swipe for branching.', 'Branch creation failed');
                return;
            }
            nodeId = swipeNodeId;
        }
        const shownNodeId = chat[mesId]?.node_id;
        const answer = await requestBookmark(mesId, {
            nodeId,
            unique: true,
            alsoNodeId: alsoLabelShown && nodeId !== null && isStoredNodeId(shownNodeId) ? shownNodeId : null,
            open,
        });
        if (!answer) {
            toastr.error('Could not name that point.', 'Branch creation failed');
            return;
        }

        if (chat[mesId] === lastMes || chat[mesId]?.node_id === lastMes.node_id) {
            const extra = typeof lastMes.extra === 'object' ? { ...lastMes.extra } : {};
            const branches = Array.isArray(extra.branches) ? [...extra.branches] : [];
            if (!branches.includes(answer.id)) branches.push(answer.id);
            extra.branches = branches;
            updateMessage(mesId, { extra });
        }
        return answer;
    }

    toastr.warning('That message isn\'t saved yet. Try again once it is.', 'Branch creation failed');
    return;
}

/**
 * Creates a new bookmark for a message.
 * @param {number} mesId
 * @param {object} [options={}]
 * @param {string?} [options.forceName] - forced name instead of prompting.
 * @returns {Promise<string?>}
 */
export async function createNewBookmark(mesId, { forceName = null } = {}) {
    if (getSelectionState().type === 'none') {
        toastr.info('No character selected.', 'Bookmark');
        return null;
    }
    if (!chat.length) {
        toastr.warning('The chat is empty.', 'Bookmark');
        return null;
    }
    if (!chat[mesId]) {
        toastr.warning('Invalid message ID.', 'Bookmark');
        return null;
    }

    const lastMes = chat[mesId];

    if (typeof lastMes.extra !== 'object') {
        lastMes.extra = {};
    }

    const isReplace = lastMes.extra.bookmark_link;

    let name = await getBookmarkName({ isReplace: isReplace, forceName: forceName });
    if (!name) {
        return null;
    }

    if (isStoredNodeId(lastMes.node_id) || isProvisionalNodeId(lastMes.node_id)) {
        const answer = await requestBookmark(mesId, { label: name });
        if (!answer) {
            toastr.error('Could not save the bookmark.', 'Bookmark');
            return null;
        }

        const extra = typeof chat[mesId]?.extra === 'object' ? { ...chat[mesId].extra } : {};
        extra.bookmark_link = answer.id;
        updateMessage(mesId, { extra });
        toastr.success('Bookmarked. It shows up in the chat list.', 'Bookmark', { timeOut: 6000 });
        return answer.id;
    }

    toastr.warning('That message isn\'t saved yet. Try again once it is.', 'Bookmark');
    return null;
}


async function backToMainChat() {
    const mainChatName = getMainChatName();
    const allChats = await getExistingChatNames();

    if (allChats.includes(mainChatName)) {
        if (selected_group) {
            await openGroupChat(selected_group, mainChatName);
        } else {
            await openCharacterChat(mainChatName);
        }
        return mainChatName;
    }

    return null;
}

export async function convertSoloToGroupChat() {
    if (selected_group) {
        console.log('Already in group. No need for conversion');
        return;
    }

    if (!getCurrentCharacter()) {
        console.log('Need to have a character selected');
        return;
    }

    const confirm = await Popup.show.confirm(t`Convert to group chat`, t`Are you sure you want to convert this chat to a group chat?` + '<br />' + t`This cannot be reverted.`);
    if (!confirm) {
        return;
    }

    const character = getCurrentCharacter();

    const groupChat = [...chat].map(m => structuredClone(m));

    const name = `Group: ${character.name}`;
    const avatar = characterThumbnail(character);
    const members = [character.avatar];
    const favChecked = normalizeFav(character.fav);
    /** @type {ChatMetadata} */
    const metadata = Object.assign({}, chat_metadata);
    delete metadata.main_chat;
    /** @type {ChatHeader} */
    const chatHeader = {
        chat_metadata: metadata,
        user_name: 'unused',
        character_name: 'unused',
    };
    /** @type {Omit<Group, 'id' | 'chat_id' | 'chats'>} */
    const groupCreateModel = {
        name: name,
        members: members,
        avatar_url: avatar,
        allow_self_responses: false,
        activation_strategy: group_activation_strategy.NATURAL,
        disabled_members: [],
        fav: favChecked,
        hideMutedSprites: false,
        generation_mode: group_generation_mode.SWAP,
        auto_mode_delay: DEFAULT_AUTO_MODE_DELAY,
    };

    const createGroupResponse = await fetch('/api/groups/create', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(groupCreateModel),
    });

    if (!createGroupResponse.ok) {
        console.error('Group creation unsuccessful');
        toastr.error(t`The group was not created. Check the server console for details.`, t`Group could not be created`);
        return;
    }

    /** @type {Group} */
    const group = holdGroup(await createGroupResponse.json());

    // Convert tags list and assign to group
    createTagMapFromList('#tagList', group.id);

    // Update chars list
    await getCharacters();

    for (let index = 0; index < groupChat.length; index++) {
        const message = groupChat[index];

        delete message.node_id;
        if (Array.isArray(message.swipe_info)) {
            message.swipe_info = message.swipe_info.map(info =>
                (info && typeof info === 'object') ? { ...info, node_id: undefined } : info);
        }

        // Skip messages we don't care about
        if (message.is_user || message.is_system || message.extra?.type === system_message_types.NARRATOR || message.force_avatar !== undefined) {
            continue;
        }

        if (!message.extra || typeof message.extra !== 'object') {
            message.extra = {};
        }

        // Set force fields for solo character
        message.name = character.name;
        message.original_avatar = character.avatar;
        Object.assign(message, characterAvatar(character));
    }

    // Save group chat
    const createChatRequest = await compressRequest({
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id: group.chat_id, group_id: group.id, chat: [chatHeader, ...groupChat] }),
    });
    const createChatResponse = await fetch('/api/chats/group/save', createChatRequest);

    if (!createChatResponse.ok) {
        console.error('Group chat creation unsuccessful');
        toastr.error('Group chat creation unsuccessful');
        return;
    }

    // Click on the freshly selected group to open it
    setActiveGroup(group.id);
    await openGroupById(group.id);

    toastr.success(t`The chat has been successfully converted!`);
}

/**
 * Creates a new branch from the message with the given ID
 * @param {number} mesId Message ID
 * @param {{swipeId?: number|null}} [options={}] Branch options
 * @returns {Promise<string?>} Branch file name
 */
export async function branchChat(mesId, { swipeId = null } = {}) {
    if (getSelectionState().type === 'none') {
        toastr.info('No character selected.', 'Create Branch');
        return null;
    }

    return openBranch(await makeBranch(mesId, { swipeId, open: true }));
}

/**
 * @param {BookmarkAnswer|null|undefined} made
 * @returns {Promise<string|null>}
 */
async function openBranch(made) {
    if (!made?.id) {
        return null;
    }
    if (selected_group) {
        await openGroupChat(selected_group, made.id, { opened: made.opened ?? null });
    } else {
        await openCharacterChat(made.id, { opened: made.opened ?? null });
    }
    return made.id;
}

/**
 * @param {number} mesId
 * @param {{swipeId?: number|null}} [options={}]
 * @returns {Promise<string?>}
 */
export async function forkChat(mesId, { swipeId = null } = {}) {
    if (getSelectionState().type === 'none') {
        toastr.info('No character selected.', 'Create Fork');
        return null;
    }

    return openBranch(await makeBranch(mesId, { swipeId, open: true, alsoLabelShown: !selected_group }));
}

/**
 * @param {JQuery<HTMLElement>} mes
 * @param {string?} [newBookmarkLink=null]
 */
export function updateBookmarkDisplay(mes, newBookmarkLink = null) {
    newBookmarkLink && mes.attr('bookmark_link', newBookmarkLink);
    const bookmarkFlag = mes.find('.mes_bookmark');
    bookmarkFlag.attr('title', `Checkpoint\n${mes.attr('bookmark_link')}\n\n${bookmarkFlag.data('tooltip')}`);
}

function registerBookmarksSlashCommands() {
    /**
     * @param {string} context - used as the toast title on failure.
     */
    function validateMessageId(mesId, context) {
        if (isNaN(mesId)) {
            toastr.warning('Invalid message ID was provided', context);
            return false;
        }
        if (!chat[mesId]) {
            toastr.warning(`Message for id ${mesId} not found`, context);
            return false;
        }
        return true;
    }

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'branch-create',
        returns: 'Name of the new branch',
        callback: async (args, text) => {
            const mesId = Number(args.mesId ?? text ?? getLastMessageId());
            if (!validateMessageId(mesId, 'Create Branch')) return '';

            const branchName = await branchChat(mesId);
            return branchName ?? '';
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Message ID',
                typeList: [ARGUMENT_TYPE.NUMBER],
                enumProvider: commonEnumProviders.messages(),
            }),
        ],
        helpString: `
        <div>
            Create a new branch from the selected message. If no message id is provided, will use the last message.
        </div>
        <div>
            Creating a branch will automatically choose a name for the branch.<br />
            After creating the branch, the branch chat will be automatically opened.
        </div>
        <div>
            Use Checkpoints and <code>/checkpoint-create</code> instead if you do not want to jump to the new chat.
        </div>`,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'checkpoint-create',
        returns: 'Name of the new checkpoint',
        callback: async (args, text) => {
            const mesId = Number(args.mesId ?? getLastMessageId());
            if (!validateMessageId(mesId, 'Create Checkpoint')) return '';

            if (typeof text !== 'string') {
                toastr.warning('Checkpoint name must be a string or empty', 'Create Checkpoint');
                return '';
            }

            const checkPointName = await createNewBookmark(mesId, { forceName: text });
            return checkPointName ?? '';
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'mesId',
                description: 'Message ID',
                typeList: [ARGUMENT_TYPE.NUMBER],
                enumProvider: commonEnumProviders.messages(),
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Checkpoint name',
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        helpString: `
        <div>
            Create a new checkpoint for the selected message with the provided name. If no message id is provided, will use the last message.<br />
            Leave the checkpoint name empty to auto-generate one.
        </div>
        <div>
            A created checkpoint will be permanently linked with the message.<br />
            If a checkpoint already exists, the link to it will be overwritten.<br />
            After creating the checkpoint, the checkpoint chat can be opened with the checkpoint flag,
            using the <code>/go</code> command with the checkpoint name or the <code>/checkpoint-go</code> command on the message.
        </div>
        <div>
            Use Branches and <code>/branch-create</code> instead if you do want to jump to the new chat.
        </div>
        <div>
            <strong>Example:</strong>
            <ul>
                <li>
                    <pre><code>/checkpoint-create mes={{lastCharMessage}} Checkpoint for char reply | /setvar key=rememberCheckpoint {{pipe}}</code></pre>
                    Will create a new checkpoint to the latest message of the current character, and save it as a local variable for future use.
                </li>
            </ul>
        </div>`,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'checkpoint-go',
        returns: 'Name of the checkpoint',
        callback: async (args, text) => {
            const mesId = Number(args.mesId ?? text ?? getLastMessageId());
            if (!validateMessageId(mesId, 'Open Checkpoint')) return '';

            const checkPointName = chat[mesId].extra?.bookmark_link;
            if (!checkPointName) {
                toastr.warning('No checkpoint is linked to the selected message', 'Open Checkpoint');
                return '';
            }

            if (selected_group) {
                await openGroupChat(selected_group, checkPointName);
            } else {
                await openCharacterChat(checkPointName);
            }

            return checkPointName;
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Message ID',
                typeList: [ARGUMENT_TYPE.NUMBER],
                enumProvider: commonEnumProviders.messages(),
            }),
        ],
        helpString: `
        <div>
            Open the checkpoint linked to the selected message. If no message id is provided, will use the last message.
        </div>
        <div>
            Use <code>/checkpoint-get</code> if you want to make sure that the selected message has a checkpoint.
        </div>`,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'checkpoint-exit',
        returns: 'The name of the chat exited to. Returns an empty string if not in a checkpoint chat.',
        callback: async () => {
            const mainChat = await backToMainChat();
            return mainChat ?? '';
        },
        helpString: 'Exit the checkpoint chat.<br />If not in a checkpoint chat, returns empty string.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'checkpoint-parent',
        returns: 'Name of the parent chat for this checkpoint',
        callback: async () => {
            const mainChatName = getMainChatName();
            return mainChatName ?? '';
        },
        helpString: 'Get the name of the parent chat for this checkpoint.<br />If not in a checkpoint chat, returns empty string.',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'checkpoint-get',
        returns: 'Name of the chat',
        callback: async (args, text) => {
            const mesId = Number(args.mesId ?? text ?? getLastMessageId());
            if (!validateMessageId(mesId, 'Get Checkpoint')) return '';

            const checkPointName = chat[mesId].extra?.bookmark_link;
            return checkPointName ?? '';
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Message ID',
                typeList: [ARGUMENT_TYPE.NUMBER],
                enumProvider: commonEnumProviders.messages(),
            }),
        ],
        helpString: `
        <div>
            Get the name of the checkpoint linked to the selected message. If no message id is provided, will use the last message.<br />
            If no checkpoint is linked, the result will be empty.
        </div>`,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'checkpoint-list',
        returns: 'JSON array of all existing checkpoints in this chat, as an array',
        /** @param {{links?: string}} args @returns {Promise<string>} */
        callback: async (args, _) => {
            const result = Object.entries(chat)
                .filter(([_, message]) => message.extra?.bookmark_link)
                .map(([mesId, message]) => isTrueBoolean(args.links) ? message.extra.bookmark_link : Number(mesId));
            return JSON.stringify(result);
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'links',
                description: 'Get a list of all links / chat names of the checkpoints, instead of the message ids',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                enumList: commonEnumProviders.boolean('trueFalse')(),
                defaultValue: 'false',
            }),
        ],
        helpString: `
        <div>
            List all existing checkpoints in this chat.
        </div>
        <div>
            Returns a list of all message ids that have a checkpoint, or all checkpoint links if <code>links</code> is set to <code>true</code>.<br />
            The value will be a JSON array.
        </div>`,
    }));
}

export function initBookmarks() {
    $('#option_new_bookmark').on('click', saveBookmarkMenu);
    $('#option_back_to_main').on('click', backToMainChat);
    $('#option_convert_to_group').on('click', convertSoloToGroupChat);

    $(document).on('click', '.mes_bookmark_add', async function (e) {
        e.stopPropagation();
        const mesId = Number($(this).closest('.mes').attr('mesid'));
        if (!Number.isInteger(mesId)) {
            return;
        }
        await createNewBookmark(mesId);
    });

    $(document).on('click', '.select_chat_block', async function () {
        const nodeId = $(this).attr('node_id');
        const target = $(this).attr('file_name');

        if (!target) {
            return;
        }

        if (nodeId && await switchToNode(nodeId)) {
            $('#shadow_select_chat_popup').css('display', 'none');
            return;
        }

        const loaderHandle = loader.show({
            slug: 'chat-load',
            title: t`Chat History`,
            message: t`Loading chat…`,
            toastMode: loader.ToastMode.STATIC,
        });

        try {
            if (selected_group) {
                await openGroupChat(selected_group, target);
            } else {
                await openCharacterChat(target);
            }
        } finally {
            await loaderHandle.hide();
        }

        $('#shadow_select_chat_popup').css('display', 'none');
    });

    registerBookmarksSlashCommands();
}
