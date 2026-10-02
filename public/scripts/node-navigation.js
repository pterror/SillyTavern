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
 * Switches to a sibling's path; nothing is removed from the database, so swiping back reaches the old alternative's children again.
 * With `redraw: false` only the data moves (node, selection, the continuation in `chat`); the caller redraws
 * from mesId + 1 itself, e.g. mid-animation, so the old text stays on screen until the swipe hides it.
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

    // An unstored greeting has nothing to select or fetch; no row is minted here (ensureOpeningRow() does that when needed).
    const unstored = isProvisionalNodeId(targetNodeId);
    /** @type {{messages?: ChatMessage[]}} */
    let payload = { messages: [] };
    const avatar = getCurrentCharacter()?.avatar;
    if (!unstored) {
        try {
            const response = await fetch('/api/chats/message/select', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar, node_id: targetNodeId, activate: true, chat_name: getCurrentChatId() }),
            });
            if (!response.ok) {
                console.warn(`[switchToAlternativePath] HTTP ${response.status} selecting ${targetNodeId}`);
                return false;
            }
            payload = await response.json();
            if (avatar != null) {
                _setCurrentTarget(targetNodeId, null);
            }
        } catch (error) {
            console.warn('[switchToAlternativePath] Failed to select the alternative:', error);
            return false;
        }
    }

    // Re-check: the await means the chat may have moved on while the fetch was in flight.
    if (chat[mesId] !== message) {
        return false;
    }

    updateMessage(mesId, { node_id: targetNodeId, swipe_id: swipeId });
    chat.splice(mesId + 1, chat.length - (mesId + 1), ...(payload.messages ?? []));

    // Without this the freshly-fetched messages read as changed against the snapshot on the next save.
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
 * Moves the character's chat pointer onto targetNodeId. An unstored (provisional) node has nothing
 * persisted server-side to point at yet, so it's skipped, matching switchToAlternativePath()'s guard.
 * @param {string} targetNodeId
 */
async function _persistNodeSelection(targetNodeId) {
    const avatar = getCurrentCharacter()?.avatar;
    if (avatar == null || isProvisionalNodeId(targetNodeId)) {
        return;
    }
    _setCurrentTarget(targetNodeId, null);
    try {
        await fetch('/api/chats/message/select', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, node_id: targetNodeId, activate: true }),
        });
    } catch (error) {
        console.warn('[switchToNode] Failed to persist the selection:', error);
    }
}

/**
 * Jumps to any node in the open tree-backed chat without a full reload. Solo tree-backed chats only; returns false so the caller can fall back to a full open.
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

    let ancestry;
    try {
        const response = await fetch('/api/chats/ancestry', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ node_id: targetNodeId, chat_name: getCurrentChatId() }),
        });
        if (!response.ok) {
            return false;
        }
        ancestry = (await response.json())?.messages;
    } catch (error) {
        console.warn('[switchToNode] Failed to fetch ancestry:', error);
        return false;
    }
    if (!Array.isArray(ancestry) || ancestry.length === 0) {
        return false;
    }

    // Deepest already-loaded ancestor of the target, walked backward so the closest fork point is found first.
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
    // No shared ancestry at all - a genuinely different chat. Let the caller do a full open.
    if (forkPos < 0) {
        return false;
    }

    const between = ancestry.slice(forkAncestryIdx + 1);

    let below = [];
    const avatar = getCurrentCharacter()?.avatar;
    if (avatar != null && !isProvisionalNodeId(targetNodeId)) {
        try {
            const response = await fetch('/api/chats/message/select', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatar_url: avatar, node_id: targetNodeId, activate: true, chat_name: getCurrentChatId() }),
            });
            if (response.ok) {
                below = (await response.json())?.messages ?? [];
                _setCurrentTarget(targetNodeId, null);
            }
        } catch (error) {
            // Not fatal - the segment through the target is still correct, it just won't carry on past it.
            console.warn('[switchToNode] Failed to select the target and fetch what follows it:', error);
        }
    }

    chat.splice(forkPos + 1, chat.length - (forkPos + 1), ...between, ...below);

    _snapshotMessages();

    await redisplayChat({ startIndex: forkPos + 1 });
    updateViewMessageIds();
    refreshSwipeButtons(true);
    return true;
}
