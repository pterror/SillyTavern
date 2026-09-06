import { DiffMatchPatch, DOMPurify, localforage } from '../lib.js';
import { chat, event_types, eventSource, getCurrentChatId, getRequestHeaders, reloadCurrentChat } from '../script.js';
import { t } from './i18n.js';
import { oai_settings } from './openai.js';
import { Popup, POPUP_TYPE } from './popup.js';
import { power_user, registerDebugFunction } from './power-user.js';
import { isMobile } from './RossAscends-mods.js';
import { renderTemplateAsync } from './templates.js';
import { getFriendlyTokenizerName, getTokenCountAsync } from './tokenizers.js';
import { copyText } from './utils.js';

let PromptArrayItemForRawPromptDisplay;
let priorPromptArrayItemForRawPromptDisplay;

/**
 * 2026-09 server-migration note: this used to be the ONLY storage for itemized prompts - now it's read-only
 * legacy data, kept around purely so migrateAllItemizedPrompts() (below) has something to read while
 * uploading each browser's locally-accumulated backlog to the server (`src/endpoints/itemized-prompts.js`),
 * which is now the actual source of truth. Nothing in this file writes through this instance anymore.
 */
const promptStorage = localforage.createInstance({ name: 'SillyTavern_Prompts' });
export let itemizedPrompts = [];

/** Bumped only if the dedup transform itself changes - forces every stored entry to be reconsidered by
 * migrateLegacyItemizedPrompts() even if it already carries a stamp from an older transform. */
const DEDUP_VERSION = 1;

/**
 * The one field in an itemized-prompt entry (script.js's `additionalPromptStuff`) that's reliably the
 * largest and most likely to be duplicated elsewhere in the same entry: `rawPrompt` is the literal text
 * handed to the generation API for that turn. `finalPrompt` in particular is very often byte-identical to
 * it (both are "the assembled prompt", just captured at two different points of the same call) - but any
 * other field that happens to hold an identical string is caught the same way (2026-09 SillyTavern_Prompts
 * size investigation: this store measured ~8.9GB, by far the largest single IndexedDB origin consumer -
 * ~7x the character cache's 1.2GB - because every generated message keeps its own full snapshot of the
 * assembled prompt, forever, never pruned).
 */
const DEDUP_REFERENCE_FIELD = 'rawPrompt';

/**
 * Computes the {toStore, dedup} split for a single itemized-prompt entry - mirrors
 * character-cache.js's computeDedupSplit() exactly, just against one canonical reference field instead of
 * a fixed set of field-to-field pairs (this object has ~30 loosely related fields; checking every one of
 * them against the one field known to reliably be the largest is simpler and just as safe, since a field
 * only ever gets stripped when it's a confirmed byte-for-byte match). Never mutates `entry`.
 * @param {object} entry
 * @returns {{toStore: object, dedup: string[]|undefined}}
 */
function computeItemizedDedupSplit(entry) {
    const reference = entry[DEDUP_REFERENCE_FIELD];
    if (typeof reference !== 'string' || reference.length === 0) {
        return { toStore: entry, dedup: undefined };
    }
    let toStore = entry;
    let dedup;
    for (const field of Object.keys(entry)) {
        if (field === DEDUP_REFERENCE_FIELD) continue;
        if (typeof entry[field] === 'string' && entry[field].length > 0 && entry[field] === reference) {
            if (toStore === entry) toStore = { ...entry };
            delete toStore[field];
            (dedup ??= []).push(field);
        }
    }
    return { toStore, dedup };
}

/**
 * Restores fields computeItemizedDedupSplit() stripped as exact duplicates of `rawPrompt`. Mutates and
 * returns `entry` in place - safe because callers only ever call this on a freshly IDB-deserialized object
 * with no other live references.
 * @param {object} entry
 * @param {string[]|undefined} dedup Field names stripped at write time.
 * @returns {object} `entry`, with any stripped fields restored.
 */
function rehydrateItemizedDedup(entry, dedup) {
    if (dedup && dedup.length && typeof entry?.[DEDUP_REFERENCE_FIELD] === 'string') {
        for (const field of dedup) {
            entry[field] = entry[DEDUP_REFERENCE_FIELD];
        }
    }
    return entry;
}

/**
 * Cross-entry compression for `rawPrompt` specifically: consecutive entries in the same chat's
 * itemizedPrompts array overwhelmingly share most of their content (the same character card, the same
 * chat history up to a point, often the same world-info activations), which naive whole-string storage
 * repeats in full for every single message forever. A simple "common prefix" scheme would miss most of
 * that sharing, though - world-info entries can be inserted at arbitrary depth *within* the chat history
 * (not just prepended at the very start), so an activation toggling on/off between two consecutive
 * generations shifts everything after that point even when the actual chat messages around it are
 * unchanged. diff-match-patch (already a dependency of this file, used below for the human-readable
 * prompt-diff display) finds the real matching regions wherever they fall via its Myers diff, so it
 * survives that kind of mid-string interruption correctly - unlike prefix/suffix matching, which would
 * lose everything past the first divergence.
 *
 * `diff_toDelta()`/`diff_fromDelta()` (not `patch_make()`/`patch_apply()`) are the right pair here:
 * patch_apply does fuzzy, best-effort matching meant for applying a patch to text that may have since
 * drifted from its original base - unnecessary risk when the exact previous rawPrompt is always known.
 * diff_toDelta/diff_fromDelta is an exact, lossless encoding of the diff itself.
 */
function newPromptDiffEngine() {
    const dmp = new DiffMatchPatch();
    dmp.Diff_Timeout = 2.0;
    return dmp;
}

/**
 * Decodes a stored itemized-prompts value - either this session's compressed wrapper shape
 * (`{v, entries, dedup, rawPromptDelta}`, from the server or from a not-yet-migrated local IndexedDB
 * record) or the legacy plain-array shape (predates all compression, local-only, pre-server-migration) -
 * into a plain, fully-rehydrated `entries[]` array. Shared by loadItemizedPrompts() (decoding the server's
 * response) and migrateAllItemizedPrompts() (decoding whatever's left in the local IndexedDB backlog).
 * @param {object[]|{v: number, entries: object[], dedup: (string[]|undefined)[], rawPromptDelta: (string|undefined)[]}|null|undefined} stored
 * @returns {object[]}
 */
function decodeStoredItemizedPrompts(stored) {
    if (Array.isArray(stored)) {
        return stored;
    }
    if (!stored || !Array.isArray(stored.entries)) {
        return [];
    }
    const dmp = newPromptDiffEngine();
    /** @type {string|undefined} Previous entry's already-reconstructed (full) rawPrompt. */
    let previousRawPrompt;
    return stored.entries.map((entry, i) => {
        const delta = stored.rawPromptDelta?.[i];
        if (typeof delta === 'string' && typeof previousRawPrompt === 'string') {
            entry.rawPrompt = dmp.diff_text2(dmp.diff_fromDelta(previousRawPrompt, delta));
        }
        if (typeof entry.rawPrompt === 'string') {
            previousRawPrompt = entry.rawPrompt;
        }
        // rawPrompt must be reconstructed above BEFORE this, since deduped fields point at it.
        return rehydrateItemizedDedup(entry, stored.dedup?.[i]);
    });
}

/**
 * Gets the itemized prompts for a chat from server-side storage (`src/endpoints/itemized-prompts.js`).
 * @param {string} chatId Chat ID to load
 */
export async function loadItemizedPrompts(chatId) {
    try {
        if (!chatId) {
            itemizedPrompts = [];
            return;
        }

        const response = await fetch('/api/itemized-prompts/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ chatId }),
        });

        if (response.status === 404) {
            // No itemized prompts stored yet for this chat - not an error.
            itemizedPrompts = [];
        } else if (response.ok) {
            itemizedPrompts = decodeStoredItemizedPrompts(await response.json());
        } else {
            console.log('Error loading itemized prompts for chat', chatId, response.statusText);
            itemizedPrompts = [];
        }

        if (!itemizedPrompts) {
            itemizedPrompts = [];
        }

        await eventSource.emit(event_types.ITEMIZED_PROMPTS_LOADED, { chatId: chatId });
    } catch (error) {
        console.log('Error loading itemized prompts for chat', chatId, error);
        itemizedPrompts = [];
    }
}

/**
 * Compresses one entry: intra-entry field-dedup against its own rawPrompt, then diff-encodes that
 * rawPrompt against `previousRawPrompt` (the prior entry's full, undiffed rawPrompt in the same chat).
 * Shared by compressItemizedPrompts() and compressItemizedPromptsIncremental() below.
 * @param {DiffMatchPatch} dmp
 * @param {object} originalEntry
 * @param {string|undefined} previousRawPrompt
 * @returns {{toStore: object, dedup: string[]|undefined, delta: string|undefined, rawPrompt: string|undefined}}
 * `rawPrompt` is this entry's own full value (for the caller to thread through as the next entry's
 * `previousRawPrompt`), regardless of whether it ended up stripped from `toStore`.
 */
function compressOneEntry(dmp, originalEntry, previousRawPrompt) {
    const rawPrompt = originalEntry.rawPrompt;
    // Intra-entry dedup (other fields byte-identical to this entry's OWN full rawPrompt) computed first,
    // from the untouched original - the cross-entry delta below only ever replaces rawPrompt itself,
    // never the fields this step strips.
    const { toStore: dedupedEntry, dedup } = computeItemizedDedupSplit(originalEntry);

    let toStore = dedupedEntry;
    let delta;
    if (typeof rawPrompt === 'string' && rawPrompt.length > 0 &&
        typeof previousRawPrompt === 'string' && previousRawPrompt.length > 0) {
        const encoded = dmp.diff_toDelta(dmp.diff_main(previousRawPrompt, rawPrompt));
        // Only ever use the delta when it's actually smaller - guards against the (unlikely, e.g. wildly
        // different consecutive prompts) case where the encoded diff would be bigger than just storing
        // the full string.
        if (encoded.length < rawPrompt.length) {
            delta = encoded;
        }
    }
    if (delta !== undefined) {
        toStore = toStore === dedupedEntry ? { ...dedupedEntry } : toStore;
        delete toStore.rawPrompt;
    }

    return { toStore, dedup, delta, rawPrompt };
}

/**
 * Compresses a chat's itemizedPrompts array into the on-disk shape (field-dedup + cross-entry rawPrompt
 * diffing) from scratch - used by migrateAllItemizedPrompts() below, where each chat is only ever
 * processed once. saveItemizedPrompts() uses compressItemizedPromptsIncremental() instead (see its own
 * doc comment on why a full recompute there would be wasteful). Never mutates `entries`.
 * @param {object[]} entries
 * @returns {{v: number, entries: object[], dedup: (string[]|undefined)[], rawPromptDelta: (string|undefined)[]}}
 */
function compressItemizedPrompts(entries) {
    const dmp = newPromptDiffEngine();
    const dedup = [];
    const rawPromptDelta = [];
    /** @type {string|undefined} Previous entry's full (undiffed) rawPrompt, this compression pass. */
    let previousRawPrompt;
    const compressedEntries = entries.map((originalEntry) => {
        const result = compressOneEntry(dmp, originalEntry, previousRawPrompt);
        dedup.push(result.dedup);
        rawPromptDelta.push(result.delta);
        if (typeof result.rawPrompt === 'string') {
            previousRawPrompt = result.rawPrompt;
        }
        return result.toStore;
    });

    return { v: DEDUP_VERSION, entries: compressedEntries, dedup, rawPromptDelta };
}

/** Cache of the last compression computed for saveItemizedPrompts()'s CURRENTLY loaded chat - see
 * compressItemizedPromptsIncremental()'s own doc comment. Naturally invalidated (never explicitly reset)
 * whenever a different chatId is saved, since the lookup below checks chatId first. */
let incrementalCompressionCache = /** @type {{chatId: string, sourceEntries: object[], compressed: {v: number, entries: object[], dedup: (string[]|undefined)[], rawPromptDelta: (string|undefined)[]}} | null} */ (null);

/**
 * Same contract as compressItemizedPrompts(), but reuses cached per-entry results for any prefix of
 * `entries` that's reference-identical to what was compressed last time for this exact chatId.
 *
 * saveItemizedPrompts() is called after every single generated message (script.js's saveChatConditional(),
 * which runs after every generation) - recomputing the WHOLE chat's dedup+diffs from scratch on every one
 * of those calls would repeat the exact same work (re-diffing every already-unchanged consecutive pair)
 * for the entire chat history on every single message, turning a chat's lifetime cost from O(length) into
 * O(length^2) for what's almost always just one newly appended entry.
 *
 * Only entries from the first point of actual change onward are ever recomputed - an entry earlier in the
 * array being edited/regenerated (script.js's finishGenerating() replaces the object at that index rather
 * than mutating it, so this is a genuine reference change, not just an appended tail) correctly
 * invalidates and recomputes everything from THAT point onward too, since every later entry's delta is
 * encoded against its predecessor's rawPrompt and would otherwise silently encode against a stale base.
 * @param {string} chatId
 * @param {object[]} entries
 * @returns {{v: number, entries: object[], dedup: (string[]|undefined)[], rawPromptDelta: (string|undefined)[]}}
 */
function compressItemizedPromptsIncremental(chatId, entries) {
    const cached = incrementalCompressionCache?.chatId === chatId ? incrementalCompressionCache : null;
    const cachedSource = cached?.sourceEntries ?? [];

    let firstChanged = 0;
    const maxShared = Math.min(cachedSource.length, entries.length);
    while (firstChanged < maxShared && cachedSource[firstChanged] === entries[firstChanged]) {
        firstChanged++;
    }

    if (cached && firstChanged === entries.length && firstChanged === cachedSource.length) {
        // Nothing at all changed since last time - reuse the whole cached result untouched.
        return cached.compressed;
    }

    const dmp = newPromptDiffEngine();
    const dedup = firstChanged > 0 ? cached.compressed.dedup.slice(0, firstChanged) : [];
    const rawPromptDelta = firstChanged > 0 ? cached.compressed.rawPromptDelta.slice(0, firstChanged) : [];
    /** @type {string|undefined} */
    let previousRawPrompt = firstChanged > 0 ? cachedSource[firstChanged - 1].rawPrompt : undefined;
    if (typeof previousRawPrompt !== 'string') {
        previousRawPrompt = undefined;
    }

    const newlyComputedEntries = entries.slice(firstChanged).map((originalEntry) => {
        const result = compressOneEntry(dmp, originalEntry, previousRawPrompt);
        dedup.push(result.dedup);
        rawPromptDelta.push(result.delta);
        if (typeof result.rawPrompt === 'string') {
            previousRawPrompt = result.rawPrompt;
        }
        return result.toStore;
    });

    const reusedEntries = firstChanged > 0 ? cached.compressed.entries.slice(0, firstChanged) : [];
    const compressed = { v: DEDUP_VERSION, entries: [...reusedEntries, ...newlyComputedEntries], dedup, rawPromptDelta };
    incrementalCompressionCache = { chatId, sourceEntries: entries.slice(), compressed };
    return compressed;
}

/**
 * Saves the itemized prompts for a chat to server-side storage (`src/endpoints/itemized-prompts.js`),
 * which gzips the already-compressed payload at rest. Called after every single generated message
 * (script.js's saveChatConditional()) - see compressItemizedPromptsIncremental()'s own doc comment on why
 * the compression step itself stays incremental regardless of where the result is sent.
 * @param {string} chatId Chat ID to save itemized prompts for
 */
export async function saveItemizedPrompts(chatId) {
    try {
        if (!chatId) {
            return;
        }

        const data = compressItemizedPromptsIncremental(chatId, itemizedPrompts);
        const response = await fetch('/api/itemized-prompts/save', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ chatId, data }),
        });

        if (!response.ok) {
            console.log('Error saving itemized prompts for chat', chatId, response.statusText);
            return;
        }

        await eventSource.emit(event_types.ITEMIZED_PROMPTS_SAVED, { chatId: chatId });
    } catch (error) {
        console.log('Error saving itemized prompts for chat', chatId, error);
    }
}

/** Set once a background local-to-server migration has been kicked off this session (see
 * migrateAllItemizedPrompts()), so it's never launched more than once per session. */
let allChatsMigrationStarted = false;

/**
 * One-time upload of this browser's locally-accumulated IndexedDB backlog (`promptStorage`, the
 * pre-2026-09 `SillyTavern_Prompts` store) to server-side storage, then reclaims the local space -
 * this is the actual fix for "itemized prompts are missing on other devices/browsers": before this,
 * every chat's itemized breakdown existed ONLY in whichever browser generated it.
 *
 * Not just the chats a user happens to reopen: loadItemizedPrompts() no longer touches `promptStorage` at
 * all (server is the sole source of truth for every load/save from here on), so a chat sitting untouched
 * in the local backlog would otherwise never get uploaded, and its browser-local bytes would never be
 * reclaimed either. This does a full scan instead.
 *
 * Call once at boot; safe to call unconditionally - both the in-session guard and each chat's own
 * "does the server already have this" check make it a no-op on every call after the backlog is drained.
 * Never awaited by its caller. Naturally resumable if interrupted: a chat is only removed from the local
 * backlog after the server confirms it has the data (either just-uploaded, or already present), so a
 * browser closed mid-sweep just means the next boot's sweep finds - and only re-considers - whatever
 * didn't finish uploading yet.
 *
 * Deliberately checks for existing server-side data before uploading (GET first) rather than uploading
 * unconditionally: if the SAME chat was already migrated from another device/browser (or by an earlier,
 * interrupted run of this same function), blindly overwriting could clobber genuinely newer server data
 * with a stale local snapshot. An extra round-trip per chat is the cost of that safety.
 */
export async function migrateAllItemizedPrompts() {
    if (allChatsMigrationStarted) {
        return;
    }
    allChatsMigrationStarted = true;

    /** @type {[string, object[]|object][]} [chatId, raw stored value] pairs still sitting in local IndexedDB. */
    const local = [];
    try {
        await promptStorage.iterate((value, chatId) => {
            const hasContent = Array.isArray(value) ? value.length > 0 : Array.isArray(value?.entries) && value.entries.length > 0;
            if (hasContent) {
                local.push([chatId, value]);
            }
        });
    } catch (error) {
        console.log('Error scanning local itemized prompts for server migration', error);
        return;
    }

    if (local.length === 0) {
        return;
    }

    console.log(`[itemized-prompts] Migrating ${local.length} locally-cached chat(s) to server storage...`);
    const MIGRATE_BATCH = 10; // a GET plus maybe a POST per chat, each potentially a whole chat's worth of data - keep this network-friendly.
    let considered = 0;
    for (let i = 0; i < local.length; i += MIGRATE_BATCH) {
        const batch = local.slice(i, i + MIGRATE_BATCH);
        await Promise.all(batch.map(async ([chatId, value]) => {
            try {
                const existing = await fetch('/api/itemized-prompts/get', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ chatId }),
                });

                if (existing.status !== 404 && !existing.ok) {
                    // A real (transient) error, not "doesn't exist yet" - leave the local copy alone and
                    // retry on a future boot rather than risk losing the only copy of this data.
                    return;
                }

                if (existing.status === 404) {
                    const entries = decodeStoredItemizedPrompts(value);
                    const saveResponse = await fetch('/api/itemized-prompts/save', {
                        method: 'POST',
                        headers: getRequestHeaders(),
                        body: JSON.stringify({ chatId, data: compressItemizedPrompts(entries) }),
                    });
                    if (!saveResponse.ok) {
                        return; // Couldn't upload - leave the local copy in place, retry next boot.
                    }
                }

                // Either just uploaded, or the server already had this chat's data - safe to reclaim the
                // local copy either way.
                await promptStorage.removeItem(chatId);
            } catch (error) {
                console.log(`Error migrating itemized prompts for chat ${chatId} to server:`, error);
            }
        }));
        considered += batch.length;
        // Yield to the main thread between batches - same reasoning as every other batched migration in
        // this codebase (character-cache.js): must not make the browser unresponsive for seconds.
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    console.log(`[itemized-prompts] Server migration pass complete (${considered} chat(s) considered).`);
}

/**
 * Replaces the itemized prompt text for a message.
 * @param {number} mesId Message ID to get itemized prompt for
 * @param {string} promptText New raw prompt text
 * @returns
 */
export async function replaceItemizedPromptText(mesId, promptText) {
    if (!Array.isArray(itemizedPrompts)) {
        itemizedPrompts = [];
    }

    const itemizedPrompt = itemizedPrompts.find(x => x.mesId === mesId);

    if (!itemizedPrompt) {
        return;
    }

    itemizedPrompt.rawPrompt = promptText;
}

/**
 * Deletes the itemized prompts for a chat from server-side storage.
 * @param {string} chatId Chat ID to delete itemized prompts for
 */
export async function deleteItemizedPrompts(chatId) {
    try {
        if (!chatId) {
            return;
        }

        await fetch('/api/itemized-prompts/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ chatId }),
        });
        await eventSource.emit(event_types.ITEMIZED_PROMPTS_DELETED, { chatId: chatId, all: false });
    } catch {
        console.log('Error deleting itemized prompts for chat', chatId);
    }
}

/**
 * Empties the itemized prompts array and every chat's server-side storage.
 */
export async function clearItemizedPrompts() {
    try {
        await fetch('/api/itemized-prompts/clear', {
            method: 'POST',
            headers: getRequestHeaders(),
        });
        itemizedPrompts = [];
        await eventSource.emit(event_types.ITEMIZED_PROMPTS_DELETED, { all: true });
    } catch {
        console.log('Error clearing itemized prompts');
    }
}

export async function itemizedParams(itemizedPrompts, thisPromptSet, incomingMesId) {
    const params = {
        charDescriptionTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].charDescription),
        charPersonalityTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].charPersonality),
        scenarioTextTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].scenarioText),
        userPersonaStringTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].userPersona),
        worldInfoStringTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].worldInfoString),
        allAnchorsTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].allAnchors),
        summarizeStringTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].summarizeString),
        authorsNoteStringTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].authorsNoteString),
        smartContextStringTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].smartContextString),
        beforeScenarioAnchorTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].beforeScenarioAnchor),
        afterScenarioAnchorTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].afterScenarioAnchor),
        zeroDepthAnchorTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].zeroDepthAnchor), // TODO: unused
        thisPrompt_padding: itemizedPrompts[thisPromptSet].padding,
        this_main_api: itemizedPrompts[thisPromptSet].main_api,
        chatInjects: await getTokenCountAsync(itemizedPrompts[thisPromptSet].chatInjects),
        chatVectorsStringTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].chatVectorsString),
        dataBankVectorsStringTokens: await getTokenCountAsync(itemizedPrompts[thisPromptSet].dataBankVectorsString),
        modelUsed: chat[incomingMesId]?.extra?.model,
        apiUsed: chat[incomingMesId]?.extra?.api,
        presetName: itemizedPrompts[thisPromptSet].presetName || t`(Unknown)`,
        messagesCount: String(itemizedPrompts[thisPromptSet].messagesCount ?? ''),
        examplesCount: String(itemizedPrompts[thisPromptSet].examplesCount ?? ''),
    };

    const getFriendlyName = (value) => $(`#rm_api_block select option[value="${value}"]`).first().text() || value;

    if (params.apiUsed) {
        params.apiUsed = getFriendlyName(params.apiUsed);
    }

    if (params.this_main_api) {
        params.mainApiFriendlyName = getFriendlyName(params.this_main_api);
    }

    if (params.chatInjects) {
        params.ActualChatHistoryTokens = params.ActualChatHistoryTokens - params.chatInjects;
    }

    if (params.this_main_api == 'openai') {
        //for OAI API
        //console.log('-- Counting OAI Tokens');

        //params.finalPromptTokens = itemizedPrompts[thisPromptSet].oaiTotalTokens;
        params.oaiMainTokens = itemizedPrompts[thisPromptSet].oaiMainTokens;
        params.oaiStartTokens = itemizedPrompts[thisPromptSet].oaiStartTokens;
        params.ActualChatHistoryTokens = itemizedPrompts[thisPromptSet].oaiConversationTokens;
        params.examplesStringTokens = itemizedPrompts[thisPromptSet].oaiExamplesTokens;
        params.oaiPromptTokens = itemizedPrompts[thisPromptSet].oaiPromptTokens - (params.afterScenarioAnchorTokens + params.beforeScenarioAnchorTokens) + params.examplesStringTokens;
        params.oaiBiasTokens = itemizedPrompts[thisPromptSet].oaiBiasTokens;
        params.oaiJailbreakTokens = itemizedPrompts[thisPromptSet].oaiJailbreakTokens;
        params.oaiNudgeTokens = itemizedPrompts[thisPromptSet].oaiNudgeTokens;
        params.oaiImpersonateTokens = itemizedPrompts[thisPromptSet].oaiImpersonateTokens;
        params.oaiNsfwTokens = itemizedPrompts[thisPromptSet].oaiNsfwTokens;
        params.finalPromptTokens =
            params.oaiStartTokens +
            params.oaiPromptTokens +
            params.oaiMainTokens +
            params.oaiNsfwTokens +
            params.oaiBiasTokens +
            params.oaiImpersonateTokens +
            params.oaiJailbreakTokens +
            params.oaiNudgeTokens +
            params.ActualChatHistoryTokens +
            //charDescriptionTokens +
            //charPersonalityTokens +
            //allAnchorsTokens +
            params.worldInfoStringTokens +
            params.beforeScenarioAnchorTokens +
            params.afterScenarioAnchorTokens;
        // Max context size - max completion tokens
        params.thisPrompt_max_context = (oai_settings.openai_max_context - oai_settings.openai_max_tokens);

        //console.log('-- applying % on OAI tokens');
        params.oaiStartTokensPercentage = ((params.oaiStartTokens / (params.finalPromptTokens)) * 100).toFixed(2);
        params.storyStringTokensPercentage = (((params.afterScenarioAnchorTokens + params.beforeScenarioAnchorTokens + params.oaiPromptTokens) / (params.finalPromptTokens)) * 100).toFixed(2);
        params.ActualChatHistoryTokensPercentage = ((params.ActualChatHistoryTokens / (params.finalPromptTokens)) * 100).toFixed(2);
        params.promptBiasTokensPercentage = ((params.oaiBiasTokens / (params.finalPromptTokens)) * 100).toFixed(2);
        params.worldInfoStringTokensPercentage = ((params.worldInfoStringTokens / (params.finalPromptTokens)) * 100).toFixed(2);
        params.allAnchorsTokensPercentage = ((params.allAnchorsTokens / (params.finalPromptTokens)) * 100).toFixed(2);
        params.selectedTokenizer = getFriendlyTokenizerName(params.this_main_api).tokenizerName;
        params.oaiSystemTokens = params.oaiImpersonateTokens + params.oaiJailbreakTokens + params.oaiNudgeTokens + params.oaiStartTokens + params.oaiNsfwTokens + params.oaiMainTokens;
        params.oaiSystemTokensPercentage = ((params.oaiSystemTokens / (params.finalPromptTokens)) * 100).toFixed(2);
    } else {
        //for non-OAI APIs
        //console.log('-- Counting non-OAI Tokens');
        params.finalPromptTokens = await getTokenCountAsync(itemizedPrompts[thisPromptSet].finalPrompt);
        params.storyStringTokens = await getTokenCountAsync(itemizedPrompts[thisPromptSet].storyString) - params.worldInfoStringTokens;
        params.examplesStringTokens = await getTokenCountAsync(itemizedPrompts[thisPromptSet].examplesString);
        params.mesSendStringTokens = await getTokenCountAsync(itemizedPrompts[thisPromptSet].mesSendString);
        params.ActualChatHistoryTokens = params.mesSendStringTokens - (params.allAnchorsTokens - (params.beforeScenarioAnchorTokens + params.afterScenarioAnchorTokens)) + power_user.token_padding;
        params.instructionTokens = await getTokenCountAsync(itemizedPrompts[thisPromptSet].instruction);
        params.promptBiasTokens = await getTokenCountAsync(itemizedPrompts[thisPromptSet].promptBias);

        params.totalTokensInPrompt =
            params.storyStringTokens +     //chardefs total
            params.worldInfoStringTokens +
            params.examplesStringTokens + // example messages
            params.ActualChatHistoryTokens +  //chat history
            params.allAnchorsTokens +      // AN and/or legacy anchors
            //afterScenarioAnchorTokens +       //only counts if AN is set to 'after scenario'
            //zeroDepthAnchorTokens +           //same as above, even if AN not on 0 depth
            params.promptBiasTokens;       //{{}}
        //- thisPrompt_padding;  //not sure this way of calculating is correct, but the math results in same value as 'finalPrompt'
        params.thisPrompt_max_context = itemizedPrompts[thisPromptSet].this_max_context;
        params.thisPrompt_actual = params.thisPrompt_max_context - params.thisPrompt_padding;

        //console.log('-- applying % on non-OAI tokens');
        params.storyStringTokensPercentage = ((params.storyStringTokens / (params.totalTokensInPrompt)) * 100).toFixed(2);
        params.ActualChatHistoryTokensPercentage = ((params.ActualChatHistoryTokens / (params.totalTokensInPrompt)) * 100).toFixed(2);
        params.promptBiasTokensPercentage = ((params.promptBiasTokens / (params.totalTokensInPrompt)) * 100).toFixed(2);
        params.worldInfoStringTokensPercentage = ((params.worldInfoStringTokens / (params.totalTokensInPrompt)) * 100).toFixed(2);
        params.allAnchorsTokensPercentage = ((params.allAnchorsTokens / (params.totalTokensInPrompt)) * 100).toFixed(2);
        params.selectedTokenizer = itemizedPrompts[thisPromptSet]?.tokenizer || getFriendlyTokenizerName(params.this_main_api).tokenizerName;
    }
    return params;
}

export function findItemizedPromptSet(itemizedPrompts, incomingMesId) {
    let thisPromptSet = undefined;
    priorPromptArrayItemForRawPromptDisplay = -1;

    for (let i = 0; i < itemizedPrompts.length; i++) {
        if (itemizedPrompts[i].mesId === incomingMesId) {
            thisPromptSet = i;
            PromptArrayItemForRawPromptDisplay = i;
            break;
        } else if (itemizedPrompts[i].rawPrompt) {
            priorPromptArrayItemForRawPromptDisplay = i;
        }
    }
    return thisPromptSet;
}

export async function promptItemize(itemizedPrompts, requestedMesId) {
    var incomingMesId = Number(requestedMesId);
    var thisPromptSet = findItemizedPromptSet(itemizedPrompts, incomingMesId);

    if (thisPromptSet === undefined) {
        console.log(`couldnt find the right mesId. looked for ${incomingMesId}`);
        return null;
    }

    const params = await itemizedParams(itemizedPrompts, thisPromptSet, incomingMesId);
    const flatten = (rawPrompt) => Array.isArray(rawPrompt) ? rawPrompt.map(x => x.content).join('\n') : rawPrompt;

    const template = params.this_main_api == 'openai'
        ? await renderTemplateAsync('itemizationChat', params)
        : await renderTemplateAsync('itemizationText', params);

    const popup = new Popup(template, POPUP_TYPE.TEXT);

    /** @type {HTMLElement} */
    const diffPrevPrompt = popup.dlg.querySelector('#diffPrevPrompt');
    if (priorPromptArrayItemForRawPromptDisplay >= 0) {
        diffPrevPrompt.style.display = '';
        diffPrevPrompt.addEventListener('click', function () {
            const dmp = new DiffMatchPatch();
            const text1 = flatten(itemizedPrompts[priorPromptArrayItemForRawPromptDisplay].rawPrompt);
            const text2 = flatten(itemizedPrompts[PromptArrayItemForRawPromptDisplay].rawPrompt);

            dmp.Diff_Timeout = 2.0;

            const d = dmp.diff_main(text1, text2);
            let ds = dmp.diff_prettyHtml(d);
            // make it readable
            ds = ds.replaceAll('background:#e6ffe6;', 'background:#b9f3b9; color:black;');
            ds = ds.replaceAll('background:#ffe6e6;', 'background:#f5b4b4; color:black;');
            ds = ds.replaceAll('&para;', '');
            const container = document.createElement('div');
            container.innerHTML = DOMPurify.sanitize(ds);
            const rawPromptWrapper = document.getElementById('rawPromptWrapper');
            rawPromptWrapper.replaceChildren(container);
            $('#rawPromptPopup').slideToggle();
        });
    } else {
        diffPrevPrompt.style.display = 'none';
    }
    popup.dlg.querySelector('#copyPromptToClipboard').addEventListener('pointerup', async function () {
        let rawPrompt = itemizedPrompts[PromptArrayItemForRawPromptDisplay].rawPrompt;
        let rawPromptValues = rawPrompt;

        if (Array.isArray(rawPrompt)) {
            rawPromptValues = rawPrompt.map(x => x.content).join('\n');
        }

        await copyText(rawPromptValues);
        toastr.info(t`Copied!`);
    });

    popup.dlg.querySelector('#showRawPrompt').addEventListener('click', async function () {
        const rawPrompt = flatten(itemizedPrompts[PromptArrayItemForRawPromptDisplay].rawPrompt);

        // Mobile needs special handholding. The side-view on the popup wouldn't work,
        // so we just show an additional popup for this.
        if (isMobile()) {
            const content = document.createElement('div');
            content.classList.add('tokenItemizingMaintext');
            content.innerText = rawPrompt;
            const popup = new Popup(content, POPUP_TYPE.TEXT, null, { allowVerticalScrolling: true, leftAlign: true });
            await popup.show();
            return;
        }

        //let DisplayStringifiedPrompt = JSON.stringify(itemizedPrompts[PromptArrayItemForRawPromptDisplay].rawPrompt).replace(/\n+/g, '<br>');
        const rawPromptWrapper = document.getElementById('rawPromptWrapper');
        rawPromptWrapper.innerText = rawPrompt;
        $('#rawPromptPopup').slideToggle();
    });

    await popup.show();
}

export function initItemizedPrompts() {
    // Fire-and-forget: sweeps every OTHER chat's stored prompts into the compressed format in the
    // background (see this function's own doc comment on why the per-chat-open path alone isn't enough).
    migrateAllItemizedPrompts();

    registerDebugFunction('clearPrompts', 'Delete itemized prompts', 'Deletes all itemized prompts from the local storage.', async () => {
        await clearItemizedPrompts();
        toastr.info('Itemized prompts deleted.');
        if (getCurrentChatId()) {
            await reloadCurrentChat();
        }
    });

    $(document).on('pointerup', '.mes_prompt', async function () {
        let mesIdForItemization = $(this).closest('.mes').attr('mesId');
        if (itemizedPrompts.length !== undefined && itemizedPrompts.length !== 0) {
            await promptItemize(itemizedPrompts, mesIdForItemization);
        }
    });

    eventSource.on(event_types.CHAT_DELETED, async (name) => {
        await deleteItemizedPrompts(name);
    });
    eventSource.on(event_types.GROUP_CHAT_DELETED, async (name) => {
        await deleteItemizedPrompts(name);
    });
}

/**
 * Swaps the itemized prompts between two messages. Useful when moving messages around in the chat.
 * @param {number} sourceMessageId Source message ID
 * @param {number} targetMessageId Target message ID
 */
export function swapItemizedPrompts(sourceMessageId, targetMessageId) {
    if (!Array.isArray(itemizedPrompts)) {
        return;
    }

    const sourcePrompts = itemizedPrompts.filter(x => x.mesId === sourceMessageId);
    const targetPrompts = itemizedPrompts.filter(x => x.mesId === targetMessageId);

    sourcePrompts.forEach(prompt => {
        prompt.mesId = targetMessageId;
    });

    targetPrompts.forEach(prompt => {
        prompt.mesId = sourceMessageId;
    });

    itemizedPrompts.sort((a, b) => a.mesId - b.mesId);
}

/**
 * Deletes the itemized prompt for a specific message.
 * Shifts down other itemized prompts as necessary.
 * @param {number} messageId Message ID to delete itemized prompt for
 */
export function deleteItemizedPromptForMessage(messageId) {
    if (!Array.isArray(itemizedPrompts)) {
        return;
    }

    itemizedPrompts = itemizedPrompts.filter(x => x.mesId !== messageId);

    for (const prompt of itemizedPrompts.filter(x => x.mesId > messageId)) {
        prompt.mesId -= 1;
    }
}
