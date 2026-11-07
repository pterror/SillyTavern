import { getCurrentCharacter } from '../script.js';
import { chat, chat_metadata } from './chat-state.js';
import { getRequestHeaders } from './request-headers.js';
import { selected_group } from './group-chats.js';
import { setChatVariablesListener, setMetadataStoredListener } from './chat-store.js';
import { delay } from './utils.js';
import { debounce_timeout } from './constants.js';
import { t } from './i18n.js';
import { isStoredNodeId } from './node-identity.js';
import { applyChanges, baselineAfter, baselineOf, metadataChanges, replaceInPlace, unsavedVariables } from './state-sync.js';
import { takeShownCounts } from './shown-text-counts.js';

/** @type {Map<string, string>} */
let _metadataBaseline = new Map();

/** @type {Map<string, MetadataChanges>} */
const _sentMetadataChanges = new Map();

/** @typedef {{ set: Record<string, unknown>, unset: string[] }} MetadataChanges */


/**
 * @returns {import('./state-sync.js').MetadataChanges|null}
 */
export function changedMetadata() {
    return metadataChanges(chat_metadata, _metadataBaseline);
}

/**
 * @param {import('./state-sync.js').MetadataChanges} changes
 */
export function noteMetadataChangesStored(changes) {
    _metadataBaseline = baselineAfter(_metadataBaseline, changes);
}

/**
 * @param {ChatMetadata} state
 */
export function takeServerState(state) {
    replaceInPlace(chat_metadata, state);
    _metadataBaseline = baselineOf(state);
}

/**
 * @param {ChatMetadata} state
 * @param {import('./state-sync.js').MetadataChanges} changes
 */
function metadataChangesNotSaved(state, changes) {
    takeServerState(state);
    const names = unsavedVariables(changes);
    toastr.error(names.length ? t`Chat variables not saved: ${names.join(', ')}` : t`Chat metadata not saved.`, t`Save failed`);
}

/**
 * @param {string} ref
 * @param {import('./state-sync.js').MetadataChanges} changes
 */
export function noteMetadataSent(ref, changes) {
    _sentMetadataChanges.set(ref, changes);
}

setChatVariablesListener(variables => {
    const changes = { set: {}, unset: [], variables };
    applyChanges(chat_metadata, changes);
    noteMetadataChangesStored(changes);
});

setMetadataStoredListener(({ ref, integrity, notSaved, state }) => {
    const changes = _sentMetadataChanges.get(ref);
    if (!changes) return;
    _sentMetadataChanges.delete(ref);
    if (notSaved) {
        if (state) metadataChangesNotSaved(state, changes);
        return;
    }
    chat_metadata.integrity = integrity ?? undefined;
    noteMetadataChangesStored(changes);
});

/**
 * @returns {{ avatar_url: string } | { group_id: string } | null}
 */
function openOwner() {
    if (selected_group != null) return { group_id: String(selected_group) };
    const avatar = getCurrentCharacter()?.avatar;
    return typeof avatar === 'string' && avatar !== '' ? { avatar_url: avatar } : null;
}

/** @returns {string | null} */
function openPosition() {
    for (let i = chat.length - 1; i >= 0; i--) {
        if (isStoredNodeId(chat[i]?.node_id)) return chat[i].node_id;
    }
    return null;
}

/**
 * @returns {import('./macro-values.js').MacroScope}
 */
export function openChatMacroScope() {
    const owner = openOwner();
    const avatar = getCurrentCharacter()?.avatar;
    return {
        ...(owner ?? {}),
        ...(owner && 'group_id' in owner && typeof avatar === 'string' && avatar !== '' ? { avatar_url: avatar } : {}),
        at: owner ? openPosition() : null,
    };
}

/**
 * @param {{ tree: { avatar?: string, group?: string } | undefined, at: string | null, state: ChatMetadata | undefined }} pushed
 */
export function takePushedState({ tree, at, state }) {
    const owner = openOwner();
    if (!owner || !tree || !state) return;
    const sameTree = 'group_id' in owner ? tree.group === owner.group_id : tree.avatar === owner.avatar_url;
    if (!sameTree || at !== openPosition()) return;
    const pending = changedMetadata();
    takeServerState(state);
    if (pending) applyChanges(chat_metadata, pending);
}

/** @typedef {Error & {status: number}} HttpError */

/**
 * @param {unknown} error
 * @returns {error is HttpError}
 */
function _hasHttpStatus(error) {
    return error instanceof Error && typeof (/** @type {*} */ (error).status) === 'number';
}

export function _resetMetadataSaveSnapshot() {
    _metadataBaseline = baselineOf(chat_metadata);
    _sentMetadataChanges.clear();
}

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

let _metadataSaveChain = Promise.resolve();

/**
 * @param {{avatar_url: string}|{group_id: string}} owner
 */
async function _postChatMetadata(owner) {
    const run = async () => {
        const changes = changedMetadata();
        if (!changes) return;
        /** @returns {Promise<{ ok?: boolean, state?: ChatMetadata, shown_counts?: import('./shown-text-counts.js').ShownTextCounts }>} */
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
            takeShownCounts(result.shown_counts);
        } catch (error) {
            console.error('[saveMetadata] Failed to save metadata after retrying:', error);
            toastr.error(t`Could not save chat metadata. Check your connection and try again.`, t`Save failed`);
        }
    };

    const chained = _metadataSaveChain.then(run, run);
    _metadataSaveChain = chained.catch(() => { });
    return chained;
}

export async function saveMetadata() {
    const owner = openOwner();
    if (!owner) return;
    return await _postChatMetadata(owner);
}

let saveMetadataTimeout = null;

export function cancelDebouncedMetadataSave() {
    clearTimeout(saveMetadataTimeout);
    saveMetadataTimeout = null;
}

/**
 * Saves the open chat's metadata after a pause, unless another chat is open by then.
 */
export function saveMetadataDebounced() {
    const owner = JSON.stringify(openOwner());
    cancelDebouncedMetadataSave();
    saveMetadataTimeout = setTimeout(async () => {
        if (JSON.stringify(openOwner()) !== owner) {
            console.warn('Another chat was opened, not saving metadata');
            return;
        }
        await saveMetadata();
    }, debounce_timeout.relaxed);
}
