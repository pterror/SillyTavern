import { chat, chat_metadata, getCurrentCharacter, getRequestHeaders } from '../script.js';
import { groupsStore, selected_group } from './group-chats.js';
import { delay } from './utils.js';
import { t } from './i18n.js';
import { isStoredNodeId } from './node-identity.js';

// Mirrors _messageSnapshots (generation.js), but for chat_metadata's own content (author's note, custom
// extension keys, `tainted`, etc.) rather than message rows - so a tree op that only changed the message
// tree (already persisted via its own chatOp*/degraft/endPath call) doesn't also trigger a redundant
// /api/chats/metadata POST that would write back the exact same metadata unchanged. `null` always
// means "unknown state, save unconditionally" - every metadata reset in this file clears it to that,
// so this can only ever cause an extra save, never a dropped one.
/** @type {string|null} */
let _lastSavedMetadataJSON = null;

/** @typedef {Error & {status: number}} HttpError */

/**
 * @param {unknown} error
 * @returns {error is HttpError}
 */
function _hasHttpStatus(error) {
    return error instanceof Error && typeof (/** @type {*} */ (error).status) === 'number';
}

// `integrity` is excluded on purpose: the server rotates it on every metadata write (even a true
// no-op one), so comparing it would make every save look "dirty" and defeat the whole point.
/** @param {ChatMetadata|null|undefined} metadata */
function _metadataContentJSON(metadata) {
    if (!metadata || typeof metadata !== 'object') {
        return JSON.stringify(metadata);
    }
    const rest = { ...metadata };
    delete rest.integrity;
    return JSON.stringify(rest);
}

// Forces the next tree-chat metadata save to go through unconditionally, e.g. after chat_metadata
// is wholesale reset/reassigned (new chat, chat switch, import) rather than merged in place - in
// those cases the previous snapshot no longer describes what the server has, so treat it as unknown.
export function _resetMetadataSaveSnapshot() {
    _lastSavedMetadataJSON = null;
}

// Retries the SAME direct op on a transient failure (network error, 5xx) instead of falling through
// to a different, generic persistence mechanism - a dropped write is still that exact write. A 4xx
// is a real, immediate refusal and is never retried, since a retry can't change it. Mirrors
// chat-store.js's own _retryTransient(), for the one caller here (_postChatMetadata()) that posts
// directly instead of going through a chatOp*().
/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{attempts?: number, baseDelayMs?: number}} [options]
 * @returns {Promise<T>}
 */
async function _retryOp(fn, { attempts = 3, baseDelayMs = 500 } = {}) {
    /** @type {unknown} */
    let lastError;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (_hasHttpStatus(error) && error.status >= 400 && error.status < 500) throw error;
            if (i < attempts - 1) {
                await delay(baseDelayMs * Math.pow(2, i));
            }
        }
    }
    throw lastError;
}

// Shared conflict UX for a metadata write rejected because the node's `integrity` changed elsewhere since this
// client last saw it - same toast+refresh convention as the settings save-partial 409 (see saveSettingsDebounced/
// savePartialSettings), adapted to chat metadata: there's no equivalent of getSettings() to silently refetch into,
// so this just tells the user to reload rather than risk clobbering the other session's write.
function _handleMetadataIntegrityConflict() {
    console.warn('Chat metadata save rejected: it was changed by another session since this client last saw it.');
    toastr.warning(t`This chat's metadata was changed in another tab or session. Reload the page to see the latest version.`, t`Metadata save rejected`);
}

// Every metadata-saving call (saveMetadata()'s solo/group branches, and saveChat()'s (generation.js)
// tree-chat branch) funnels through _postChatMetadata() below, and every call chains onto this same
// promise - so a second call built while the first is still in flight WAITS for the first's write (and
// its chat_metadata.integrity update) to land before it even decides whether it still has anything new
// to send. Without this, two saves fired close together (e.g. one from a generation's normal
// finish path and another from an abort-cleanup path racing it) both read the SAME stale
// chat_metadata.integrity before either response applied, so the second one's `expected_integrity`
// is already wrong by the time the server sees it - a false-positive "changed in another session"
// 409 against ITS OWN prior write, not a real conflict.
let _metadataSaveChain = Promise.resolve();

/**
 * POSTs one owner's chat_metadata to /api/chats/metadata, with the same retry-then-toast policy for
 * both solo and group chats. Queued behind any already-in-flight call via `_metadataSaveChain` - see
 * that variable's own doc comment above.
 * @param {{avatar_url: string}|{group_id: string}} owner
 * @param {string} target The node/label this chat is addressed by (character.chat, or group.chat_id).
 * @param {ChatMetadata} metadata
 */
export async function _postChatMetadata(owner, target, metadata) {
    const run = async () => {
        // Re-derive the integrity to assert from the LIVE chat_metadata.integrity, not
        // metadata.integrity as it was captured by the caller (possibly before this call was even
        // queued) - an earlier call chained ahead of this one may have already rotated it. The
        // content comparison below (_metadataContentJSON) already excludes `integrity` for the
        // same underlying reason, so this only affects what's actually sent on the wire.
        const freshMetadata = metadata?.integrity === chat_metadata.integrity ? metadata : { ...metadata, integrity: chat_metadata.integrity };
        const metadataContentJSON = _metadataContentJSON(freshMetadata);
        if (metadataContentJSON === _lastSavedMetadataJSON) {
            return;
        }

        /** @returns {Promise<{integrity?: string}|null>} */
        const postMetadata = async () => {
            const response = await fetch('/api/chats/metadata', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ ...owner, file_name: target, metadata: freshMetadata, expected_integrity: freshMetadata?.integrity }),
            });
            if (response.status === 409) {
                _handleMetadataIntegrityConflict();
                return null;
            }
            if (!response.ok) {
                const error = /** @type {HttpError} */ (new Error(`/api/chats/metadata responded ${response.status}`));
                error.status = response.status;
                throw error;
            }
            return response.json().catch(() => ({}));
        };

        try {
            const result = await _retryOp(postMetadata);
            if (result && typeof result.integrity === 'string') {
                chat_metadata.integrity = result.integrity;
            }
            if (result) {
                _lastSavedMetadataJSON = metadataContentJSON;
            }
        } catch (error) {
            console.error('[saveMetadata] Failed to save metadata after retrying:', error);
            toastr.error(t`Could not save chat metadata. Check your connection and try again.`, t`Save failed`);
        }
    };

    const chained = _metadataSaveChain.then(run, run);
    // Never let one failed/aborted link break the chain for saves queued after it.
    _metadataSaveChain = chained.catch(() => { });
    return chained;
}

// Persists chat_metadata alone, without dragging the per-message diff (or, for a group, the whole-array
// resave) a full save would do.
export async function saveMetadata() {
    const metadata = chat_metadata;

    if (selected_group) {
        const group = groupsStore.get(selected_group);
        if (!group?.chat_id) {
            console.warn('[saveMetadata] Group has no current chat_id - nothing to save metadata onto yet.');
            return;
        }
        return await _postChatMetadata({ group_id: selected_group }, group.chat_id, metadata);
    }

    const avatar = getCurrentCharacter()?.avatar;
    if (!avatar || !metadata?._tree_stored) {
        return;
    }

    const position = getCurrentCharacter()?.chat;
    const opening = chat[0]?.node_id;
    const target = chat.some(m => m.node_id === position) ? position : (isStoredNodeId(opening) ? opening : null);
    if (!target) {
        console.warn('[saveMetadata] No valid node to address this chat by - nothing to save metadata onto yet.');
        return;
    }

    return await _postChatMetadata({ avatar_url: avatar }, target, metadata);
}
