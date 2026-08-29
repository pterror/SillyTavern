import {
    getCurrentCharacter,
    getSelectionState,
    saveChat,
    system_message_types,
    syncSwipeToMes,
    openCharacterChat,
    chat_metadata,
    getRequestHeaders,
    getThumbnailUrl,
    getCharacters,
    chat,
    saveChatConditional,
    saveItemizedPrompts,
    setActiveGroup,
    getCurrentChatDetails,
    updateMessage,
    hydrateSwipes,
} from '../script.js';
import { humanizedDateTime } from './RossAscends-mods.js';
import {
    DEFAULT_AUTO_MODE_DELAY,
    group_activation_strategy,
    group_generation_mode,
    groups,
    groupsStore,
    openGroupById,
    openGroupChat,
    saveGroupBookmarkChat,
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
    getUniqueName,
    isTrueBoolean,
    uuidv4,
} from './utils.js';

const bookmarkNameToken = 'Checkpoint #';

/**
 * Gets the names of existing chats for the current character or group.
 * @returns {Promise<string[]>} - Returns a promise that resolves to an array of existing chat names.
 */
async function getExistingChatNames() {
    if (selected_group) {
        const group = groupsStore.get(selected_group);
        if (group && Array.isArray(group.chats)) {
            return [...group.chats];
        }

        return [];
    }

    const character = getCurrentCharacter();
    if (!character) {
        return [];
    }

    const response = await fetch('/api/characters/chats', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ avatar_url: character.avatar, simple: true }),
    });

    if (response.ok) {
        const data = await response.json();
        const chats = Object.values(data).map(x => x.file_name.replace('.jsonl', ''));
        return [...chats];
    }

    return [];
}

async function getBookmarkName({ isReplace = false, forceName = null } = {}) {
    const mainChatName = (getCurrentChatDetails()).sessionName;

    function buildCheckpointName(name, i) {
        // Strip off existing suffixes, then build new name
        let cleanName = name.replace(new RegExp(` - ${bookmarkNameToken}\\d+$`), '');
        // Strip off legacy old name prefix too
        cleanName = cleanName.replace(new RegExp(`^${bookmarkNameToken}\\d+ - `), '');
        return `${cleanName} - ${bookmarkNameToken}${i}`;
    }
    const existingChats = await getExistingChatNames();
    const suggestedName = getUniqueName(mainChatName, (x) => existingChats.includes(x), { nameBuilder: buildCheckpointName, startIndex: 1 });

    const body = await renderTemplateAsync('createCheckpoint', { isReplace: isReplace, suggestedName: suggestedName });
    let name = forceName ?? await Popup.show.input('Create Checkpoint', body, suggestedName);
    // Special handling for confirmed empty input (=> auto-generate name)
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
        toastr.warning('The chat is empty.', 'Checkpoint creation failed');
        return;
    }

    return await createNewBookmark(chat.length - 1);
}

/**
 * Builds the branch chat snapshot, optionally selecting a specific swipe for the target message.
 * @param {number} mesId
 * @param {{swipeId?: number|null}} [options={}]
 * @returns {ChatMessage[]|null}
 */
async function getBranchChatSnapshot(mesId, { swipeId = null } = {}) {
    if (swipeId !== null) {
        // The snapshot is cloned from the live chat, so the alternative has to be in hand BEFORE the
        // clone - a hole would make syncSwipeToMes bail and the branch silently fail to be created.
        await hydrateSwipes(Number(mesId), { index: Number(swipeId) });
    }

    const snapshot = structuredClone(chat.slice(0, Number(mesId) + 1));

    if (swipeId === null) {
        return snapshot;
    }

    if (!syncSwipeToMes(null, swipeId, snapshot[mesId])) {
        return null;
    }

    return snapshot;
}

/**
 * Checks if the current chat is stored in the message tree DB (vs flat JSONL files).
 * Tree-stored chats support O(1) forking and node labeling.
 * @returns {boolean}
 */
function isTreeStored() {
    return !!chat_metadata?._tree_stored;
}

// Export is used by Timelines extension. Do not remove.
export async function createBranch(mesId, { swipeId = null } = {}) {
    if (!chat.length) {
        toastr.warning('The chat is empty.', 'Branch creation failed');
        return;
    }

    if (mesId < 0 || mesId >= chat.length) {
        toastr.warning('Invalid message ID.', 'Branch creation failed');
        return;
    }

    const lastMes = chat[mesId];
    const mainChatName = (getCurrentChatDetails()).sessionName;
    const selectedSwipeId = swipeId === null ? null : Number(swipeId);

    if (selectedSwipeId !== null && (!Number.isInteger(selectedSwipeId) || selectedSwipeId < 0 || selectedSwipeId >= (lastMes?.swipes?.length ?? 0))) {
        toastr.warning('Invalid swipe ID.', 'Branch creation failed');
        return;
    }

    const resolvedSwipeId = selectedSwipeId ?? Number(lastMes.swipe_id ?? 0);

    function buildBranchName(name, i) {
        let cleanName = name.replace(/ - Branch #\d+$/, '');
        cleanName = cleanName.replace(/^Branch #\d+ - /, '');
        return `${cleanName} - Branch #${i}`;
    }
    const existingChats = await getExistingChatNames();
    const name = getUniqueName(mainChatName, (x) => existingChats.includes(x), { nameBuilder: buildBranchName, startIndex: 1 });
    if (!name) {
        console.error('Could not generate a unique branch name.');
        toastr.error('Could not generate a unique branch name.', 'Branch creation failed');
        return;
    }

    // Tree DB path: O(1) fork via the fork API — no data is copied
    if (isTreeStored() && !selected_group && lastMes.node_id) {
        // If a specific swipe was selected, save the current chat first so the swipe state is
        // persisted to the tree, then fork at the node.
        if (selectedSwipeId !== null) {
            const snapshot = await getBranchChatSnapshot(mesId, { swipeId: selectedSwipeId });
            if (!snapshot) {
                toastr.warning('Could not prepare the selected swipe for branching.', 'Branch creation failed');
                return;
            }
            await saveChat({ mesId, chatData: snapshot });
        }

        const character = getCurrentCharacter();
        const response = await fetch('/api/chats/fork', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                avatar_url: character?.avatar,
                node_id: lastMes.node_id,
                branch_name: name,
                metadata: { ...chat_metadata },
            }),
        });

        if (!response.ok) {
            toastr.error('Fork failed.', 'Branch creation failed');
            return;
        }

        // Update local branch tracking for the UI - a flat list of sibling branch names, not
        // grouped by swipe id (the tree has nowhere to keep per-branch fork-time swipe context;
        // see the matching comment in loadBranch()'s server-side reconstruction).
        const extra = typeof lastMes.extra === 'object' ? { ...lastMes.extra } : {};
        const branches = Array.isArray(extra.branches) ? [...extra.branches] : [];
        if (!branches.includes(name)) branches.push(name);
        extra.branches = branches;
        updateMessage(mesId, { extra });
        return name;
    }

    // Legacy JSONL path: copy the chat prefix into a new file
    const newMetadata = { main_chat: mainChatName, integrity: uuidv4(), fork_point: { mesId: Number(mesId), swipeId: resolvedSwipeId } };

    const branchChatSnapshot = await getBranchChatSnapshot(mesId, { swipeId: selectedSwipeId });
    if (!branchChatSnapshot) {
        toastr.warning('Could not prepare the selected swipe for branching.', 'Branch creation failed');
        return;
    }

    if (selected_group) {
        await saveGroupBookmarkChat(selected_group, name, newMetadata, mesId, branchChatSnapshot);
    } else {
        await saveChat({ chatName: name, withMetadata: newMetadata, mesId, chatData: branchChatSnapshot });
    }
    const extra = typeof lastMes.extra === 'object' ? { ...lastMes.extra } : {};
    const branches = (typeof extra.branches === 'object' && !Array.isArray(extra.branches)) ? { ...extra.branches } : {};
    const groupKey = String(resolvedSwipeId);
    branches[groupKey] = [...(Array.isArray(branches[groupKey]) ? branches[groupKey] : []), name];
    extra.branches = branches;
    updateMessage(mesId, { extra });
    return name;
}

/**
 * Reads the local sibling list for a fork point, without touching the network.
 * Only meaningful when the current chat is the one that natively hosts the message (the fork's
 * origin) - a branch's own copy of the message never carries this (it's read from the origin on
 * demand instead, see resolveForkRing).
 *
 * NOT scoped by swipe id - siblings off one fork point all share the same parent row, which has
 * exactly one swipe_id field, not one per branch, and /api/chats/fork records no per-branch
 * fork-time swipe context either. So every sibling at a fork point is returned together,
 * regardless of which swipe of this message happens to be selected right now.
 *
 * `extra.branches` is written as a flat array going forward (see createBranch() above); a plain
 * object is still read here too and flattened, purely for chats forked before this change whose
 * saved data still has the old swipe-id-keyed shape - no migration needed for those, this just
 * reads them correctly either way.
 * @param {ChatMessage} message
 * @returns {string[]} Sibling branch names, in creation order (deduped). Empty if none.
 */
function getLocalForkSiblings(message) {
    const branches = message?.extra?.branches;
    if (Array.isArray(branches)) {
        return [...branches];
    }
    if (branches && typeof branches === 'object') {
        const seen = [];
        for (const group of Object.values(branches)) {
            if (Array.isArray(group)) {
                for (const name of group) {
                    if (!seen.includes(name)) seen.push(name);
                }
            }
        }
        return seen;
    }
    return [];
}

/**
 * Returns whether a message has fork branches, meaning branch navigation arrows should be shown.
 * Checks both the local case (current chat is the origin, so extra.branches has entries) and the
 * branch case (current chat was forked from this message, so chat_metadata.fork_point matches -
 * legacy JSONL branches still record their own fork-time swipe id independently, so that check
 * stays swipe-scoped for them; it just doesn't apply to the tree, which has nothing to check it
 * against).
 * @param {number} mesId
 * @param {ChatMessage} [message]
 * @returns {boolean}
 */
export function hasForkBranches(mesId, message) {
    message ??= chat[mesId];
    if (!message) return false;

    // Local case: this chat is the origin and has branches recorded
    const localSiblings = getLocalForkSiblings(message);
    if (localSiblings.length > 0) return true;

    // Branch case: we're on a branch that was forked from this message
    const swipeId = Number(message.swipe_id ?? 0);
    const forkPoint = chat_metadata?.fork_point;
    if (forkPoint && forkPoint.mesId === mesId && forkPoint.swipeId === swipeId) return true;

    return false;
}

/**
 * Fetches a single message from another chat file, without loading it into the active session.
 * Solo character chats only - group chats don't have an equivalent lightweight lookup endpoint.
 * @param {string} chatName
 * @param {number} mesId
 * @returns {Promise<ChatMessage?>}
 */
async function fetchChatMessage(chatName, mesId) {
    try {
        const character = getCurrentCharacter();
        const response = await fetch('/api/chats/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                ch_name: character?.name,
                file_name: chatName,
                avatar_url: character?.avatar,
            }),
        });
        if (!response.ok) {
            return null;
        }
        const data = await response.json();
        // Row 0 is the chat header (chat_metadata); messages start at row 1, same offset as getChatData().
        return Array.isArray(data) ? (data[mesId + 1] ?? null) : null;
    } catch (error) {
        console.error('Failed to fetch fork sibling data', error);
        return null;
    }
}

/**
 * Resolves the full sibling ring for a fork point: [originChatName, ...branchNames], in creation
 * order, plus which position in that ring is the currently open chat.
 *
 * The origin chat (whichever chat's message this fork point actually lives on) is the single source
 * of truth for the sibling list - branches never carry their own duplicate copy of it, so there's
 * nothing that can drift out of sync across N files. The current chat is the origin whenever mesId's
 * own extra.branches already lists this fork point (no fetch needed, the common case while browsing
 * the trunk). Otherwise, if the current chat IS a branch and this is exactly the message it was
 * forked from, the list is fetched from the origin file on demand.
 * @param {number} mesId
 * @param {number} swipeId
 * @returns {Promise<{ring: string[], selfIndex: number}?>} null when this isn't a recognized fork point
 */
export async function resolveForkRing(mesId, swipeId) {
    const message = chat[mesId];
    if (!message) {
        return null;
    }

    const currentChatName = selected_group ? groupsStore.get(selected_group)?.chat_id : getCurrentCharacter()?.chat;
    if (!currentChatName) {
        return null;
    }

    const localSiblings = getLocalForkSiblings(message, swipeId);
    if (localSiblings.length > 0) {
        return { ring: [currentChatName, ...localSiblings], selfIndex: 0 };
    }

    // Group chats don't have a lightweight single-message fetch, so cross-file lookup is solo-only.
    if (selected_group) {
        return null;
    }

    const forkPoint = chat_metadata?.fork_point;
    const originChatName = chat_metadata?.main_chat;
    if (!forkPoint || !originChatName || forkPoint.mesId !== mesId || forkPoint.swipeId !== swipeId) {
        return null;
    }

    const originMessage = await fetchChatMessage(originChatName, mesId);
    const originSiblings = getLocalForkSiblings(originMessage, swipeId);
    if (originSiblings.length === 0) {
        return null;
    }

    const ring = [originChatName, ...originSiblings];
    const selfIndex = ring.indexOf(currentChatName);
    return selfIndex === -1 ? null : { ring, selfIndex };
}

/**
 * Cycles to the next/previous sibling branch at a fork point, in place - the swipe equivalent for
 * whole branch files instead of alternate generations of one message.
 * @param {number} mesId
 * @param {1|-1} direction
 */
export async function branchSwipe(mesId, direction) {
    const message = chat[mesId];
    if (!message) {
        return;
    }

    const swipeId = Number(message.swipe_id ?? 0);
    const resolved = await resolveForkRing(mesId, swipeId);
    if (!resolved || resolved.ring.length < 2) {
        return;
    }

    const { ring, selfIndex } = resolved;
    const targetIndex = (selfIndex + direction + ring.length) % ring.length;
    const targetName = ring[targetIndex];
    if (targetIndex === selfIndex) {
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
            await openGroupChat(selected_group, targetName);
        } else {
            await openCharacterChat(targetName);
        }
    } finally {
        await loaderHandle.hide();
    }

    document.querySelector(`.mes[mesid="${mesId}"]`)?.scrollIntoView({ block: 'center' });
}


/**
 * Creates a new bookmark for a message.
 *
 * @param {number} mesId - The ID of the message.
 * @param {Object} [options={}] - Optional parameters.
 * @param {string?} [options.forceName=null] - The name to force for the bookmark.
 * @returns {Promise<string?>} - A promise that resolves to the bookmark name when the bookmark is created.
 */
export async function createNewBookmark(mesId, { forceName = null } = {}) {
    if (getSelectionState().type === 'none') {
        toastr.info('No character selected.', 'Create Checkpoint');
        return null;
    }
    if (!chat.length) {
        toastr.warning('The chat is empty.', 'Create Checkpoint');
        return null;
    }
    if (!chat[mesId]) {
        toastr.warning('Invalid message ID.', 'Create Checkpoint');
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

    // Tree DB path: checkpoint = fork + label (O(1), no data copy)
    if (isTreeStored() && !selected_group && lastMes.node_id) {
        const character = getCurrentCharacter();

        // Label the node (the checkpoint name)
        await fetch('/api/chats/label', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                avatar_url: character?.avatar,
                node_id: lastMes.node_id,
                label: name,
            }),
        });

        // Create a fork branch (so the checkpoint is openable as a separate chat)
        const forkResponse = await fetch('/api/chats/fork', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                avatar_url: character?.avatar,
                node_id: lastMes.node_id,
                branch_name: name,
                metadata: { ...chat_metadata },
            }),
        });

        if (forkResponse.ok) {
            lastMes.extra.bookmark_link = name;
            const mes = $(`.mes[mesid="${mesId}"]`);
            updateBookmarkDisplay(mes, name);
            await saveChatConditional();
            toastr.success('Click the flag icon next to the message to open the checkpoint chat.', 'Create Checkpoint', { timeOut: 10000 });
            return name;
        }

        toastr.error('Failed to create checkpoint.', 'Create Checkpoint');
        return null;
    }

    // Legacy JSONL path
    const mainChat = selected_group ? groupsStore.get(selected_group)?.chat_id : getCurrentCharacter().chat;
    const newMetadata = { main_chat: mainChat, integrity: uuidv4() };
    await saveItemizedPrompts(name);

    if (selected_group) {
        await saveGroupBookmarkChat(selected_group, name, newMetadata, mesId);
    } else {
        await saveChat({ chatName: name, withMetadata: newMetadata, mesId });
    }

    lastMes.extra.bookmark_link = name;

    const mes = $(`.mes[mesid="${mesId}"]`);
    updateBookmarkDisplay(mes, name);

    await saveChatConditional();
    toastr.success('Click the flag icon next to the message to open the checkpoint chat.', 'Create Checkpoint', { timeOut: 10000 });
    return name;
}


/**
 * Updates the display of the bookmark on a chat message.
 * @param {JQuery<HTMLElement>} mes - The message element
 * @param {string?} [newBookmarkLink=null] - The new bookmark link (optional)
 */
export function updateBookmarkDisplay(mes, newBookmarkLink = null) {
    newBookmarkLink && mes.attr('bookmark_link', newBookmarkLink);
    const bookmarkFlag = mes.find('.mes_bookmark');
    bookmarkFlag.attr('title', `Checkpoint\n${mes.attr('bookmark_link')}\n\n${bookmarkFlag.data('tooltip')}`);
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

    // Populate group required fields
    const name = getUniqueName(`Group: ${character.name}`, y => groups.findIndex(x => x.name === y) !== -1);
    const avatar = getThumbnailUrl('avatar', character.avatar);
    const chatName = humanizedDateTime();
    const chats = [chatName];
    const members = [character.avatar];
    const favChecked = character.fav || character.fav == 'true';
    /** @type {ChatMetadata} */
    const metadata = Object.assign({}, chat_metadata);
    delete metadata.main_chat;
    /** @type {ChatHeader} */
    const chatHeader = {
        chat_metadata: metadata,
        user_name: 'unused',
        character_name: 'unused',
    };
    /** @type {Omit<Group, 'id'>} */
    const groupCreateModel = {
        name: name,
        members: members,
        avatar_url: avatar,
        allow_self_responses: false,
        activation_strategy: group_activation_strategy.NATURAL,
        disabled_members: [],
        fav: favChecked,
        chat_id: chatName,
        chats: chats,
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
        return;
    }

    /** @type {Group} */
    const group = await createGroupResponse.json();

    // Convert tags list and assign to group
    createTagMapFromList('#tagList', group.id);

    // Update chars list
    await getCharacters();

    // Convert chat to group format
    const groupChat = [...chat].map(m => structuredClone(m));
    const genIdFirst = Date.now();

    for (let index = 0; index < groupChat.length; index++) {
        const message = groupChat[index];

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
        message.force_avatar = getThumbnailUrl('avatar', character.avatar);
        // Allow regens of a single message in group
        message.extra.gen_id = genIdFirst + index;
    }

    // Save group chat
    const createChatRequest = await compressRequest({
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id: chatName, chat: [chatHeader, ...groupChat] }),
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

    const fileName = await createBranch(mesId, { swipeId });
    if (!fileName) {
        return null;
    }

    await saveItemizedPrompts(fileName);

    if (selected_group) {
        await openGroupChat(selected_group, fileName);
    } else {
        await openCharacterChat(fileName);
    }

    return fileName;
}

/**
 * Creates a fork (branch) from the message with the given ID and navigates to it.
 * This is the merged checkpoint+branch action: branching is the primary behavior, and the
 * fork point is automatically labeled with the branch name so it can still be found again
 * on the source chat, the same way a checkpoint used to work.
 * @param {number} mesId Message ID
 * @param {{swipeId?: number|null}} [options={}] Branch options
 * @returns {Promise<string?>} Branch file name
 */
export async function forkChat(mesId, { swipeId = null } = {}) {
    if (getSelectionState().type === 'none') {
        toastr.info('No character selected.', 'Create Fork');
        return null;
    }

    const lastMes = chat[mesId];
    const nodeId = lastMes?.node_id;

    const fileName = await createBranch(mesId, { swipeId });
    if (!fileName) {
        return null;
    }

    // Label the fork point with the branch name, so it also acts as a checkpoint on the source chat.
    if (isTreeStored() && !selected_group && nodeId) {
        const character = getCurrentCharacter();
        await fetch('/api/chats/label', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                avatar_url: character?.avatar,
                node_id: nodeId,
                label: fileName,
            }),
        });

        const extra = typeof lastMes.extra === 'object' ? { ...lastMes.extra } : {};
        extra.bookmark_link = fileName;
        updateMessage(mesId, { extra });
        updateBookmarkDisplay($(`.mes[mesid="${mesId}"]`), fileName);
    }

    await saveItemizedPrompts(fileName);

    if (selected_group) {
        await openGroupChat(selected_group, fileName);
    } else {
        await openCharacterChat(fileName);
    }

    return fileName;
}

function registerBookmarksSlashCommands() {
    /**
     * Validates a message ID. (Is a number, exists as a message)
     *
     * @param {number} mesId - The message ID to validate.
     * @param {string} context - The context of the slash command. Will be used as the title of any toasts.
     * @returns {boolean} - Returns true if the message ID is valid, otherwise false.
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

    $(document).on('click', '.select_chat_block, .mes_bookmark', async function (e) {
        // If shift is held down, we are not following the bookmark, but creating a new one
        const mes = $(this).closest('.mes');
        if (e.shiftKey && mes.length) {
            const selectedMesId = mes.attr('mesid');
            await createNewBookmark(Number(selectedMesId));
            return;
        }

        // Prefer the node. A name is not an identifier - `label` is not unique per owner, so opening
        // by name picks whichever row sorts first. The name is the fallback for file-backed chats,
        // which have no nodes at all.
        const target = $(this).hasClass('mes_bookmark')
            ? $(this).closest('.mes').attr('bookmark_link')
            : ($(this).attr('node_id') || $(this).attr('file_name'));

        if (!target) {
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
