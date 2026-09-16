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
    ensureOpeningRow,
    switchToNode,
    isStoredNodeId,
} from '../script.js';
import {
    DEFAULT_AUTO_MODE_DELAY,
    group_activation_strategy,
    group_generation_mode,
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
} from './utils.js';

const bookmarkNameToken = 'Bookmark #';

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
        // /api/characters/chats sends { error: true } (not an array) on a real read failure - guard against
        // that here instead of crashing on x.file_name of an object that isn't a chat entry.
        if (!Array.isArray(data)) {
            return [];
        }
        const chats = Object.values(data).map(x => x.file_name.replace('.jsonl', ''));
        return [...chats];
    }

    return [];
}

async function getBookmarkName({ isReplace = false, forceName = null } = {}) {
    const mainChatName = (getCurrentChatDetails()).sessionName;

    function buildCheckpointName(name, i) {
        let cleanName = name.replace(new RegExp(` - ${bookmarkNameToken}\\d+$`), '');
        cleanName = cleanName.replace(new RegExp(`^${bookmarkNameToken}\\d+ - `), '');
        return `${cleanName} - ${bookmarkNameToken}${i}`;
    }
    const existingChats = await getExistingChatNames();
    const suggestedName = getUniqueName(mainChatName, (x) => existingChats.includes(x), { nameBuilder: buildCheckpointName, startIndex: 1 });

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

/** The tree owner for /api/chats/label while a group is open: its own id, never getCurrentCharacter() - see chat-store.js's _currentOwner() for why a mid-generation "current character" is the wrong owner for a group. */
function _labelOwner() {
    return selected_group ? { group_id: selected_group } : { avatar_url: getCurrentCharacter()?.avatar };
}

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

    // A card-only greeting has no node yet - being branched at is what earns it one.
    const branchNodeId = await ensureOpeningRow(mesId);

    if (branchNodeId) {
        // Default to the currently-selected swipe's node; an alt-swipe branch resolves its own node
        // below instead. A swipe alternative that already exists is *already a row in the tree* (it was
        // generated and persisted, or fetched from /api/chats/alternatives) - branching it is naming
        // that row, the same "nothing to copy" case as the non-alt-swipe path just below. There is no
        // snapshot to build or save here: doing so used to send a plain-array chatData through saveChat(),
        // which saveChat() itself only recognizes as tree-shaped when chatData is NOT an array - so it
        // silently fell through to the legacy whole-chat /api/chats/save route for a chat that is in fact
        // tree-stored, and it labeled the wrong node besides (the pre-computed branchNodeId, i.e. the
        // *currently selected* swipe, never the alternate one actually requested).
        let targetNodeId = branchNodeId;
        if (selectedSwipeId !== null) {
            // The alternative may still be a hole (never fetched into swipe_info) - hydrate before
            // resolving its node id, same as getBranchChatSnapshot() did for the old snapshot-swap.
            await hydrateSwipes(Number(mesId), { index: selectedSwipeId });
            const swipeNodeId = chat[mesId]?.swipe_info?.[selectedSwipeId]?.node_id;
            if (!isStoredNodeId(swipeNodeId)) {
                toastr.warning('Could not prepare the selected swipe for branching.', 'Branch creation failed');
                return;
            }
            targetNodeId = swipeNodeId;
        }

        // Nothing to copy - the node already exists, so branching is just naming it.
        const response = await fetch('/api/chats/label', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                ..._labelOwner(),
                node_id: targetNodeId,
                label: mainChatName,
                unique: true,
            }),
        });

        if (!response.ok) {
            toastr.error('Could not name that point.', 'Branch creation failed');
            return;
        }

        const { ok, label: name } = await response.json();
        if (!ok || !name) {
            toastr.error('Could not name that point.', 'Branch creation failed');
            return;
        }

        // Kept as a flat list, not grouped by swipe id - the tree has no per-branch swipe context to key by.
        const extra = typeof lastMes.extra === 'object' ? { ...lastMes.extra } : {};
        const branches = Array.isArray(extra.branches) ? [...extra.branches] : [];
        if (!branches.includes(name)) branches.push(name);
        extra.branches = branches;
        updateMessage(mesId, { extra });
        return name;
    }

    // Legacy JSONL path: copy the chat prefix into a new file. Uniqueness is minted server-side (same
    // "<name> - Branch #N" scheme /api/chats/label's unique:true already uses for the tree path above),
    // not by asserting a name uniquified against a client-fetched chat list.
    const newMetadata = { main_chat: mainChatName, fork_point: { mesId: Number(mesId), swipeId: resolvedSwipeId } };

    const branchChatSnapshot = await getBranchChatSnapshot(mesId, { swipeId: selectedSwipeId });
    if (!branchChatSnapshot) {
        toastr.warning('Could not prepare the selected swipe for branching.', 'Branch creation failed');
        return;
    }

    const name = selected_group
        ? await saveGroupBookmarkChat(selected_group, mainChatName, newMetadata, mesId, branchChatSnapshot, { unique: true })
        : await saveChat({ chatName: mainChatName, withMetadata: newMetadata, mesId, chatData: branchChatSnapshot, unique: true });

    if (!name) {
        console.error('Could not create the branch.');
        toastr.error('Could not create the branch.', 'Branch creation failed');
        return;
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
 * Reads the local sibling list for a fork point, without touching the network. Not scoped by swipe id -
 * all siblings at a fork point share one parent row, so they're returned together regardless of which
 * swipe is currently selected. Also flattens the older swipe-id-keyed object shape for chats forked
 * before `extra.branches` became a flat array.
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
 * Whether a message has fork branches, i.e. branch navigation arrows should be shown for it.
 * @param {number} mesId
 * @param {ChatMessage} [message]
 * @returns {boolean}
 */
export function hasForkBranches(mesId, message) {
    message ??= chat[mesId];
    if (!message) return false;

    const localSiblings = getLocalForkSiblings(message);
    if (localSiblings.length > 0) return true;

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
 * order, plus which position in that ring is the currently open chat. The origin chat is the single
 * source of truth for the sibling list, fetched on demand when the current chat is a branch rather
 * than the origin itself.
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

    const bookmarkNodeId = await ensureOpeningRow(mesId);

    if (bookmarkNodeId) {
        const response = await fetch('/api/chats/label', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                ..._labelOwner(),
                node_id: bookmarkNodeId,
                label: name,
            }),
        });

        if (!response.ok) {
            toastr.error('Could not save the bookmark.', 'Bookmark');
            return null;
        }

        // The label IS the bookmark link - rowToMessage() (message-tree-db.js) re-synthesizes
        // extra.bookmark_link from the node's `label` column on every read, and sanitizeForStorage()
        // strips extra.bookmark_link before any content write for the same reason - so the label
        // response above is already the full persistence step. Mirror it into the in-memory chat array
        // for immediate UI use; no second write needed.
        const { label: resolvedName } = await response.json();
        const extra = typeof lastMes.extra === 'object' ? { ...lastMes.extra } : {};
        extra.bookmark_link = resolvedName;
        updateMessage(mesId, { extra });
        toastr.success('Bookmarked. It shows up in the chat list.', 'Bookmark', { timeOut: 6000 });
        return resolvedName;
    }

    // Legacy JSONL path. `integrity` isn't set here - the server mints and rotates it on every
    // successful save regardless of what's sent, same as the already-fixed getChat()/getGroupChat() fills.
    const mainChat = selected_group ? groupsStore.get(selected_group)?.chat_id : getCurrentCharacter().chat;
    const newMetadata = { main_chat: mainChat };
    await saveItemizedPrompts(name);

    if (selected_group) {
        await saveGroupBookmarkChat(selected_group, name, newMetadata, mesId);
    } else {
        await saveChat({ chatName: name, withMetadata: newMetadata, mesId });
    }

    const extra = typeof lastMes.extra === 'object' ? { ...lastMes.extra } : {};
    extra.bookmark_link = name;
    updateMessage(mesId, { extra });

    await saveChatConditional();
    toastr.success('Bookmarked. It shows up in the chat list.', 'Bookmark', { timeOut: 10000 });
    return name;
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

    // Snapshot now, before the getCharacters() reload below runs - that reload can itself react to a
    // changed character list (e.g. resetChatState()/clearChat() on a resident character disappearing),
    // and `chat` is the live, mutable array the rest of the app reads/writes - not a copy already in hand.
    const groupChat = [...chat].map(m => structuredClone(m));

    // Populate group required fields. A plain, non-unique default name - same as group-chats.js's
    // createGroup() - the server's /api/groups/create doesn't key groups by name (it mints its own
    // Date.now()-based id), so there's nothing to uniquify against.
    const name = `Group: ${character.name}`;
    const avatar = getThumbnailUrl('avatar', character.avatar);
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
        return;
    }

    /** @type {Group} */
    const group = await createGroupResponse.json();

    // Convert tags list and assign to group
    createTagMapFromList('#tagList', group.id);

    // Update chars list
    await getCharacters();

    for (let index = 0; index < groupChat.length; index++) {
        const message = groupChat[index];

        // These node_id/swipe_info[].node_id values name rows in the CHARACTER's own tree (owner_id =
        // character.avatar) - the new group is a different owner entirely. saveChatToTree()'s node-id
        // matching only ever reuses a claimed id when its stored parent_id equals the id this write is
        // currently building against, so in practice a brand-new group's freshly-minted anchor/chain
        // never collides with the old chain's real parents and fresh rows get created regardless - but
        // that safety is incidental to id-namespace divergence, not a stated contract. Strip them so this
        // write is unambiguously "new rows, new owner" the same way _messageContent() (chat-store.js)
        // strips them from every other write that means the same thing.
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
        message.force_avatar = getThumbnailUrl('avatar', character.avatar);
        // Allow regens of a single message in group. gen_id isn't set here - /api/chats/group/save mints
        // one for any message that doesn't already carry a real one from the solo chat, since the whole
        // array is already going to the server in this one request.
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
 * Creates a branch from the message with the given ID and navigates to it, also labeling the fork
 * point with the branch name so it acts as a checkpoint on the source chat.
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
    // Resolved before the branch is made, not after: createBranch() may move the client to the new
    // chat, and by then chat[mesId] is a different conversation's message.
    const nodeId = await ensureOpeningRow(mesId);

    const fileName = await createBranch(mesId, { swipeId });
    if (!fileName) {
        return null;
    }

    // Label the fork point with the branch name, so it also acts as a checkpoint on the source chat.
    // When forking the currently-selected swipe (swipeId === null, the only path anything calls this
    // with today), nodeId IS the node createBranch() just labeled with this exact fileName while
    // minting the branch - re-POSTing the same label to the same node here would be a redundant
    // round trip for a no-op write. Mirror that already-persisted label into the in-memory chat
    // array instead, same as createNewBookmark() does with its own label response. Forking an
    // alternate swipe labels THAT swipe's own node instead (see createBranch()'s targetNodeId), so
    // nodeId - the currently-viewed row - still needs its own checkpoint label in that case.
    if (!selected_group && nodeId) {
        if (swipeId !== null) {
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
        }

        const extra = typeof lastMes.extra === 'object' ? { ...lastMes.extra } : {};
        extra.bookmark_link = fileName;
        updateMessage(mesId, { extra });
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
        // `label` isn't unique per owner, so a name alone would pick whichever row sorts first -
        // prefer the node id; the name is only a fallback for file-backed chats, which have no nodes.
        const nodeId = $(this).attr('node_id');
        const target = nodeId || $(this).attr('file_name');

        if (!target) {
            return;
        }

        // switchToNode() reuses whatever ancestry this chat already shares with the target and only
        // replaces the difference; falls through to a full open when there's nothing to share.
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
