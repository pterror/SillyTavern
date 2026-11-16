import { getCurrentChatId, getCurrentCharacter,
    redisplayChat, updateViewMessageIds, refreshSwipeButtons,
} from '../script.js';
import { chat } from './chat-state.js';
import { selected_group } from './group-chats.js';
import { updateMessage, _setCurrentTarget, rememberCardOpening } from './chat-store.js';
import { isProvisionalNodeId } from './node-identity.js';
import { _snapshotMessages } from './generation.js';
import { chatBoxLeft, moveChatBox } from './chat-box.js';
import { takeChatLinks } from './chat-links.js';
import { t } from './i18n.js';
import { askSwitch } from './switch-answer.js';
import { getRequestHeaders } from './request-headers.js';

/**
 * @param {{ chat_metadata?: ChatMetadata } | null | undefined} answer
 */
async function takeStateFrom(answer) {
    if (!answer?.chat_metadata) return;
    const { takeServerState } = await import('./metadata-store.js');
    takeServerState(answer.chat_metadata);
}

/** @returns {{ avatar_url: string } | { group_id: string } | null} the chat open now, as the chat box names it */
function openChat() {
    if (selected_group != null && selected_group !== '') return { group_id: String(selected_group) };
    const avatar = getCurrentCharacter()?.avatar;
    return avatar != null ? { avatar_url: avatar } : null;
}

/**
 * @typedef {{ messages?: ChatMessage[], ancestry?: ChatMessage[], draft?: import('./chat-box.js').Draft, left?: unknown, links?: unknown, chat_metadata?: ChatMetadata }} SelectAnswer
 */

/**
 * Says the switch to an alternative wasn't saved and why, the message being back as it was; an outdated page's own
 * notice says it for every write (`showReloadNotice`)
 * @param {Exclude<import('./switch-answer.js').SwitchAnswer, { answer: any }>} why
 */
function noticeSwitchNotSaved(why) {
    if ('refused' in why && why.refused === 'outdated') return;
    toastr.warning(switchNotSavedText(why), t`Not saved`, { preventDuplicates: true });
}

/**
 * @param {Exclude<import('./switch-answer.js').SwitchAnswer, { answer: any }>} why
 * @returns {string}
 */
function switchNotSavedText(why) {
    if ('unreachable' in why) return t`The switch to this alternative wasn't saved, because the server couldn't be reached. The message is back as it was.`;
    switch (why.refused) {
        case 'the greeting changed': return t`The switch to this greeting wasn't saved, because its text was changed elsewhere since this page showed it. The message is back as it was; reopen the chat to see the greeting as it is now.`;
        case 'no such greeting': return t`The switch to this greeting wasn't saved, because the greeting was deleted from the character's card. The message is back as it was.`;
        case 'not in this chat': return t`The switch to this greeting wasn't saved, because its character is no longer in this chat. The message is back as it was.`;
        case 'unknown node': return t`The switch to this alternative wasn't saved, because the alternative was deleted. The message is back as it was.`;
        case 'unknown chat': return t`The switch to this alternative wasn't saved, because this chat was deleted. The message is back as it was.`;
        default: return t`The switch to this alternative wasn't saved, because the server ran into an error; its console has the details. The message is back as it was.`;
    }
}

/**
 * Switches message `mesId` to its alternative `swipeId`, at once: the message names the alternative's node, and the
 * chat box is at the chat's new end, before the server is asked. Its answer brings the path below the alternative; a
 * refusal puts the message back as `before` and the box where it was, and says the switch wasn't saved and why. The
 * caller has shown the alternative's text and `swipe_id` already.
 * @param {number} mesId
 * @param {number} swipeId
 * @param {{ redraw?: boolean, before?: ChatMessage }} [options] `before`: the message as it was before the switch
 * @returns {Promise<'switched' | 'same' | 'refused'>} `same` when there is no other node to switch to, or another change
 *   took the message's place while the server answered
 */
export async function switchToAlternativePath(mesId, swipeId, { redraw = true, before = chat[mesId] } = {}) {
    const message = chat[mesId];
    const targetNodeId = message.swipe_info?.[swipeId]?.node_id;

    if (targetNodeId == null || targetNodeId.length === 0 || message.node_id === targetNodeId) {
        return 'same';
    }

    const unstored = isProvisionalNodeId(targetNodeId);
    const avatar = getCurrentCharacter()?.avatar;
    updateMessage(mesId, { node_id: targetNodeId, swipe_id: swipeId });
    const atEnd = mesId === chat.length - 1;

    /** @type {import('./switch-answer.js').SwitchAnswer} */
    let asked = { answer: { messages: [] } };
    if (!unstored) {
        const move = moveChatBox({ chat: openChat(), owner: atEnd ? undefined : null });
        asked = await askSwitch('/api/chats/message/select', { ...openChat(), node_id: targetNodeId, chat_name: getCurrentChatId(), leaving: move.leaving });
        if ('answer' in asked) {
            chatBoxLeft(asked.answer.left);
            takeChatLinks(asked.answer.links);
            if (avatar != null) _setCurrentTarget(getCurrentChatId() ?? '', null);
            move.arrive(asked.answer.draft);
        } else {
            move.undo();
        }
    } else if (mesId === 0) {
        const remembered = await rememberCardOpening(message.swipe_info?.[swipeId]);
        if (!('answer' in remembered)) asked = remembered;
    }

    if (chat[mesId]?.node_id !== targetNodeId) {
        return 'same';
    }

    if (!('answer' in asked)) {
        updateMessage(mesId, before);
        _snapshotMessages();
        noticeSwitchNotSaved(asked);
        if (redraw) {
            await redisplayChat({ startIndex: mesId });
            updateViewMessageIds();
            refreshSwipeButtons(true);
        }
        return 'refused';
    }
    /** @type {SelectAnswer} */
    const payload = asked.answer;

    chat.splice(mesId + 1, chat.length - (mesId + 1), ...(payload.messages ?? []));
    await takeStateFrom(payload);

    _snapshotMessages();

    if (redraw) {
        await redisplayChat({ startIndex: mesId });
        updateViewMessageIds();
        refreshSwipeButtons(true);
    }
    return 'switched';
}

/**
 * @param {string} targetNodeId
 */
async function _persistNodeSelection(targetNodeId) {
    const avatar = getCurrentCharacter()?.avatar;
    if (avatar == null || isProvisionalNodeId(targetNodeId)) {
        return;
    }
    const move = moveChatBox({ chat: { avatar_url: avatar } });
    try {
        const response = await fetch('/api/chats/message/select', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, node_id: targetNodeId, leaving: move.leaving }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        _setCurrentTarget(getCurrentChatId() ?? '', null);
        const answer = await response.json();
        chatBoxLeft(answer.left);
        takeChatLinks(answer.links);
        await takeStateFrom(answer);
        move.arrive(answer.draft);
    } catch (error) {
        move.undo();
        console.warn('[switchToNode] Failed to persist the selection:', error);
    }
}

/**
 * @param {string} targetNodeId
 * @returns {Promise<boolean>}
 */
export async function switchToNode(targetNodeId) {
    if (selected_group != null || chat.length === 0) {
        return false;
    }

    const alreadyLoadedAt = chat.findIndex(m => m.node_id === targetNodeId);
    if (alreadyLoadedAt >= 0) {
        await _persistNodeSelection(targetNodeId);
        return true;
    }

    const avatar = getCurrentCharacter()?.avatar;
    if (avatar == null || isProvisionalNodeId(targetNodeId)) {
        return false;
    }
    /** @type {ChatMessage[]|undefined} */
    let ancestry;
    /** @type {ChatMessage[]} */
    let below = [];
    const move = moveChatBox({ chat: { avatar_url: avatar }, owner: null });
    try {
        const response = await fetch('/api/chats/message/select', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, node_id: targetNodeId, chat_name: getCurrentChatId(), with_ancestry: true, leaving: move.leaving }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const answer = await response.json();
        chatBoxLeft(answer?.left);
        ancestry = answer?.ancestry;
        below = answer?.messages ?? [];
        takeChatLinks(answer?.links, { replace: true });
        _setCurrentTarget(getCurrentChatId() ?? '', null);
        await takeStateFrom(answer);
        move.arrive(answer?.draft);
    } catch (error) {
        move.undo();
        console.warn('[switchToNode] Failed to go to the message:', error);
        return false;
    }
    if (!Array.isArray(ancestry) || ancestry.length === 0) {
        return false;
    }

    let forkPos = -1;
    let forkAncestryIdx = -1;
    for (let j = ancestry.length - 1; j >= 0; j--) {
        const idx = chat.findIndex(m => m.node_id === ancestry[j].node_id);
        if (idx >= 0) {
            forkPos = idx;
            forkAncestryIdx = j;
            break;
        }
    }
    if (forkPos < 0) {
        return false;
    }

    const between = ancestry.slice(forkAncestryIdx + 1);

    chat.splice(forkPos + 1, chat.length - (forkPos + 1), ...between, ...below);

    _snapshotMessages();

    await redisplayChat({ startIndex: forkPos + 1 });
    updateViewMessageIds();
    refreshSwipeButtons(true);
    return true;
}
