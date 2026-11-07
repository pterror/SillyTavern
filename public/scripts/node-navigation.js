import { getCurrentChatId, getCurrentCharacter,
    redisplayChat, updateViewMessageIds, refreshSwipeButtons,
} from '../script.js';
import { chat } from './chat-state.js';
import { getRequestHeaders } from './request-headers.js';
import { selected_group } from './group-chats.js';
import { updateMessage, _setCurrentTarget, rememberCardOpening } from './chat-store.js';
import { isProvisionalNodeId } from './node-identity.js';
import { _snapshotMessages } from './generation.js';

/**
 * @param {{ chat_metadata?: ChatMetadata } | null | undefined} answer
 */
async function takeStateFrom(answer) {
    if (!answer?.chat_metadata) return;
    const { takeServerState } = await import('./metadata-store.js');
    takeServerState(answer.chat_metadata);
}

/**
 * @param {number} mesId
 * @param {number} swipeId
 * @param {{redraw?: boolean}} [options]
 * @returns {Promise<boolean>}
 */
export async function switchToAlternativePath(mesId, swipeId, { redraw = true } = {}) {
    const message = chat[mesId];
    const targetNodeId = message.swipe_info?.[swipeId]?.node_id;

    if (targetNodeId == null || targetNodeId.length === 0 || message.node_id === targetNodeId) {
        return false;
    }

    const unstored = isProvisionalNodeId(targetNodeId);
    /** @type {{messages?: ChatMessage[]}} */
    let payload = { messages: [] };
    const avatar = getCurrentCharacter()?.avatar;
    if (!unstored) {
        try {
            const response = await fetch('/api/chats/message/select', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar, node_id: targetNodeId, chat_name: getCurrentChatId() }),
            });
            if (!response.ok) {
                console.warn(`[switchToAlternativePath] HTTP ${response.status} selecting ${targetNodeId}`);
                return false;
            }
            payload = await response.json();
            if (avatar != null) {
                _setCurrentTarget(getCurrentChatId() ?? '', null);
            }
        } catch (error) {
            console.warn('[switchToAlternativePath] Failed to select the alternative:', error);
            return false;
        }
    }

    if (chat[mesId] !== message) {
        return false;
    }

    updateMessage(mesId, { node_id: targetNodeId, swipe_id: swipeId });
    chat.splice(mesId + 1, chat.length - (mesId + 1), ...(payload.messages ?? []));
    await takeStateFrom(payload);

    _snapshotMessages();

    if (redraw) {
        await redisplayChat({ startIndex: mesId });
        updateViewMessageIds();
        refreshSwipeButtons(true);
    }
    if (unstored && mesId === 0) {
        await rememberCardOpening(message.swipes?.[swipeId]);
    }
    return true;
}

/**
 * @param {string} targetNodeId
 */
async function _persistNodeSelection(targetNodeId) {
    const avatar = getCurrentCharacter()?.avatar;
    if (avatar == null || isProvisionalNodeId(targetNodeId)) {
        return;
    }
    try {
        const response = await fetch('/api/chats/message/select', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, node_id: targetNodeId }),
        });
        if (response.ok) {
            _setCurrentTarget(getCurrentChatId() ?? '', null);
            await takeStateFrom(await response.json());
        }
    } catch (error) {
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
    try {
        const response = await fetch('/api/chats/message/select', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, node_id: targetNodeId, chat_name: getCurrentChatId(), with_ancestry: true }),
        });
        if (!response.ok) {
            return false;
        }
        const answer = await response.json();
        ancestry = answer?.ancestry;
        below = answer?.messages ?? [];
        _setCurrentTarget(getCurrentChatId() ?? '', null);
        await takeStateFrom(answer);
    } catch (error) {
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
