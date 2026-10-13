import { getCurrentCharacter } from '../script.js';
import { chat, chat_metadata } from './chat-state.js';
import { getRequestHeaders } from './request-headers.js';
import { selected_group } from './group-chats.js';
import { setMetadataStoredListener } from './chat-store.js';
import { delay } from './utils.js';
import { t } from './i18n.js';
import { isStoredNodeId } from './node-identity.js';
import { applyChanges, baselineAfter, baselineOf, changesStateHere, metadataChanges, replaceInPlace, unsavedVariables } from './state-sync.js';
import { jsonHash } from './hash-utils.js';

/**
 * Each chat metadata key's value as JSON, as the page last had it from the server or last stored it.
 * @type {Map<string, string>}
 */
let _metadataBaseline = new Map();

/** Changes sent to the server under a ref, until it says it stored them. @type {Map<string, MetadataChanges>} */
const _sentMetadataChanges = new Map();

/** @typedef {{ set: Record<string, unknown>, unset: string[] }} MetadataChanges */


/**
 * What changed in `chat_metadata` since the page last had it from the server, per key and per variable.
 * @returns {import('./state-sync.js').MetadataChanges|null} Null when nothing changed.
 */
export function changedMetadata() {
    return metadataChanges(chat_metadata, _metadataBaseline);
}

/**
 * Takes on changes the server stored.
 * @param {import('./state-sync.js').MetadataChanges} changes
 */
export function noteMetadataChangesStored(changes) {
    _metadataBaseline = baselineAfter(_metadataBaseline, changes);
}

/**
 * Takes on the server's state at the pointer (the pointer moved, or another tab changed it), in place.
 * @param {ChatMetadata} state
 */
export function takeServerState(state) {
    replaceInPlace(chat_metadata, state);
    _metadataBaseline = baselineOf(state);
}

/**
 * A save of `changes` the server refused or that failed: the page takes the server's state back, and an error names
 * the variables not saved.
 * @param {ChatMetadata} state The server's state at the pointer.
 * @param {import('./state-sync.js').MetadataChanges} changes
 */
export function metadataChangesNotSaved(state, changes) {
    takeServerState(state);
    const names = unsavedVariables(changes);
    toastr.error(names.length ? t`Chat variables not saved: ${names.join(', ')}` : t`Chat metadata not saved.`, t`Save failed`);
}

/**
 * Whether a state change recorded at `at` (null: the tree's root) changes the state shown here, so the page reads
 * it again.
 * @param {string|null} at
 */
export function stateChangedHere(at) {
    return changesStateHere(at, chat);
}

/**
 * Takes on chat metadata the server stored whole (a compat chat save), so it is what the page last had from the
 * server and isn't saved again unchanged.
 * @param {ChatMetadata} metadata What was sent.
 */
export function noteMetadataStored(metadata) {
    _metadataBaseline = baselineOf(metadata);
}

/**
 * Remembers changes sent under `ref`, so they count as stored once the server says so.
 * @param {string} ref
 * @param {import('./state-sync.js').MetadataChanges} changes
 */
export function noteMetadataSent(ref, changes) {
    _sentMetadataChanges.set(ref, changes);
}

setMetadataStoredListener(({ ref, node_id: at, integrity, notSaved }) => {
    const changes = _sentMetadataChanges.get(ref);
    if (!changes) return;
    _sentMetadataChanges.delete(ref);
    if (notSaved) {
        void readStateAt(at === '' ? null : at).then(state => {
            if (state) metadataChangesNotSaved(state, changes);
        });
        return;
    }
    chat_metadata.integrity = integrity ?? undefined;
    noteMetadataChangesStored(changes);
});

/**
 * The open chat's owner as chat routes name it, or null.
 * @returns {{ avatar_url: string } | { group_id: string } | null}
 */
function openOwner() {
    if (selected_group != null) return { group_id: String(selected_group) };
    const avatar = getCurrentCharacter()?.avatar;
    return typeof avatar === 'string' && avatar !== '' ? { avatar_url: avatar } : null;
}

/**
 * Reads the server's state again after a change elsewhere (the changes stream's `state-changed`: `tree` the
 * character's avatar or group's id, null when every page reads again; `at` the message it hangs on, null at the
 * root) when it changes what this page shows. This page's own changes not saved yet stay on top of it.
 * @param {{ tree: string | null, at: string | null }} frame
 */
export async function onStateChanged({ tree, at }) {
    const owner = openOwner();
    if (!owner) return;
    const open = 'group_id' in owner ? owner.group_id : owner.avatar_url;
    if (tree !== null && (tree !== open || !stateChangedHere(at))) return;
    let position = null;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (isStoredNodeId(chat[i]?.node_id)) {
            position = chat[i].node_id;
            break;
        }
    }
    try {
        const response = await fetch('/api/state/at', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ ...owner, at: position, if_hash: jsonHash(chat_metadata) }),
        });
        if (!response.ok) return;
        const answer = await response.json();
        // The page may have opened another chat meanwhile.
        if (!answer?.state || JSON.stringify(openOwner()) !== JSON.stringify(owner)) return;
        const pending = changedMetadata();
        takeServerState(answer.state);
        if (pending) applyChanges(chat_metadata, pending);
    } catch (error) {
        console.error('Could not read the chat\'s state again:', error);
    }
}

/**
 * The server's state at a message of the open chat (null: its root), or null when it can't be read.
 * @param {string|null} at
 * @returns {Promise<ChatMetadata|null>}
 */
async function readStateAt(at) {
    const owner = openOwner();
    if (!owner) return null;
    try {
        const response = await fetch('/api/state/at', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ ...owner, at }) });
        if (!response.ok) return null;
        const answer = await response.json();
        return answer?.state ?? null;
    } catch (error) {
        console.error('Could not read the chat\'s state back:', error);
        return null;
    }
}

/** @typedef {Error & {status: number}} HttpError */

/**
 * @param {unknown} error
 * @returns {error is HttpError}
 */
function _hasHttpStatus(error) {
    return error instanceof Error && typeof (/** @type {*} */ (error).status) === 'number';
}

/**
 * Forgets what was sent and not answered yet, and takes `chat_metadata` as it is now as what the server has (the
 * chat was opened or replaced whole).
 */
export function _resetMetadataSaveSnapshot() {
    _metadataBaseline = baselineOf(chat_metadata);
    _sentMetadataChanges.clear();
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

// Saves are chained: one built while another is in flight waits for it, so it diffs against what that one stored.
let _metadataSaveChain = Promise.resolve();

/**
 * Saves what changed in `chat_metadata` (`changedMetadata()`) as state changes where the request's session is, with
 * the same retry-then-toast policy for solo and group chats. A refusal takes the server's state back and names the
 * variables not saved.
 * @param {{avatar_url: string}|{group_id: string}} owner
 */
export async function _postChatMetadata(owner) {
    const run = async () => {
        const changes = changedMetadata();
        if (!changes) return;
        /** @returns {Promise<{ ok?: boolean, state?: ChatMetadata }>} */
        const postMetadata = async () => {
            const response = await fetch('/api/chats/metadata', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ ...owner, ...changes }),
            });
            if (!response.ok && response.status !== 409) {
                const error = /** @type {HttpError} */ (new Error(`/api/chats/metadata responded ${response.status}`));
                error.status = response.status;
                throw error;
            }
            return response.json().catch(() => ({}));
        };

        try {
            const result = await _retryOp(postMetadata);
            if (result.ok === false && result.state) metadataChangesNotSaved(result.state, changes);
            else noteMetadataChangesStored(changes);
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

/** Saves what changed in `chat_metadata` (upstream's `saveMetadata()`), where this tab's session is. */
export async function saveMetadata() {
    const owner = openOwner();
    if (!owner) return;
    return await _postChatMetadata(owner);
}
