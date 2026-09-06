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
 * 2026-09 server-migration note: server-side storage (`src/endpoints/itemized-prompts.js`) is now the
 * source of truth. This IndexedDB instance now serves two purposes only: a local mirror of whatever's on
 * the server (so itemization is viewable without a network round trip - matters on a phone connection),
 * kept in sync by loadItemizedPrompts()/saveItemizedPrompts() below, and the read-only source for
 * migrateAllItemizedPrompts()'s one-time upload of each browser's pre-server-migration backlog.
 */
const promptStorage = localforage.createInstance({ name: 'SillyTavern_Prompts' });
export let itemizedPrompts = [];

/** Bumped only if the pool-dedup wire format itself changes. */
const POOL_VERSION = 2;

/**
 * Exact-content dedup, not diffing: replaces any non-empty string with a reference into a shared per-chat
 * content pool, keyed by the string's own exact value (a plain `Map` lookup - O(1) per field, pure
 * equality, nothing that can search/backtrack/hang the way a diff algorithm can - see the 2026-09-06
 * removal of this file's previous diff-match-patch-based compression, which pegged the main thread hard
 * enough to make the app unusable). Recurses into arrays and plain objects, so the same mechanism covers
 * every shape an itemized-prompt entry's fields take:
 *  - whole flattened strings (non-OAI's rawPrompt/finalPrompt/mesSendString) - catches the same
 *    byte-identical-field case the old intra-entry dedup did (finalPrompt often equals rawPrompt exactly),
 *    for free, as a side effect of pooling by content rather than needing a dedicated field-to-field check.
 *  - `historyParts`, the per-message content list script.js's finishGenerating() captures structurally at
 *    the source (see its own comment on why this can't be reliably reconstructed from a flattened string
 *    after the fact) - this is where the real win is, since consecutive entries in the same chat share
 *    almost this entire list verbatim.
 *  - OAI's own rawPrompt shape, an array of `{role, content}` objects - `content` gets pooled the same way.
 * @param {*} value
 * @param {Map<string, number>} pool Content string -> pool key, mutated in place.
 * @param {string[]} poolOut Pool key -> content string (index = key), mutated in place (appended to only).
 * @returns {*} `value` with every non-empty string replaced by `{$r: key}`. Never mutates `value`.
 */
function poolizeValue(value, pool, poolOut) {
    if (typeof value === 'string') {
        if (value.length === 0) {
            return value;
        }
        let key = pool.get(value);
        if (key === undefined) {
            key = poolOut.length;
            poolOut.push(value);
            pool.set(value, key);
        }
        return { $r: key };
    }
    if (Array.isArray(value)) {
        return value.map(item => poolizeValue(item, pool, poolOut));
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value)) {
            out[key] = poolizeValue(value[key], pool, poolOut);
        }
        return out;
    }
    return value;
}

/**
 * Inverse of poolizeValue() - resolves every `{$r: key}` reference back to its content string.
 * @param {*} value
 * @param {string[]} poolOut Pool key -> content string, as produced by poolizeValue().
 * @returns {*}
 */
function unpoolizeValue(value, poolOut) {
    if (Array.isArray(value)) {
        return value.map(item => unpoolizeValue(item, poolOut));
    }
    if (value && typeof value === 'object') {
        const keys = Object.keys(value);
        if (keys.length === 1 && keys[0] === '$r' && typeof value.$r === 'number') {
            return poolOut[value.$r];
        }
        const out = {};
        for (const key of keys) {
            out[key] = unpoolizeValue(value[key], poolOut);
        }
        return out;
    }
    return value;
}

/**
 * Pool-dedupes every entry in `entries` from scratch - used by migrateAllItemizedPrompts(), where each
 * chat is only ever processed once, so there's no previous pool to reuse.
 * @param {object[]} entries
 * @returns {{v: number, pool: string[], entries: object[]}}
 */
function poolDedupAll(entries) {
    const pool = new Map();
    const poolOut = [];
    const outEntries = entries.map(entry => poolizeValue(entry, pool, poolOut));
    return { v: POOL_VERSION, pool: poolOut, entries: outEntries };
}

/** Cache of the last pool-dedup computed for saveItemizedPrompts()'s CURRENTLY loaded chat - see
 * poolDedupIncremental()'s own doc comment. Naturally invalidated (never explicitly reset) whenever a
 * different chatId is saved, since the lookup below checks chatId first. */
let incrementalPoolCache = /** @type {{chatId: string, sourceEntries: object[], pool: Map<string, number>, poolOut: string[], entries: object[]} | null} */ (null);

/**
 * Same contract as poolDedupAll(), but reuses the cached pool and already-pool-ized prefix for any prefix
 * of `entries` that's reference-identical to what was pool-deduped last time for this exact chatId.
 *
 * saveItemizedPrompts() is called after every single generated message (script.js's saveChatConditional()),
 * and this whole chat's data is re-sent to the server every time (not an incremental patch) - reusing the
 * unchanged prefix keeps each call's real work down to just the newly appended/changed entries, rather than
 * re-walking (and re-inserting into a fresh pool) the entire chat history on every single message.
 *
 * An entry earlier in the array being edited/regenerated (script.js's finishGenerating() replaces the
 * object at that index rather than mutating it, so this is a genuine reference change) correctly
 * invalidates and recomputes everything from that point onward.
 * @param {string} chatId
 * @param {object[]} entries
 * @returns {{v: number, pool: string[], entries: object[]}}
 */
function poolDedupIncremental(chatId, entries) {
    const cached = incrementalPoolCache?.chatId === chatId ? incrementalPoolCache : null;
    const cachedSource = cached?.sourceEntries ?? [];

    let firstChanged = 0;
    const maxShared = Math.min(cachedSource.length, entries.length);
    while (firstChanged < maxShared && cachedSource[firstChanged] === entries[firstChanged]) {
        firstChanged++;
    }

    if (cached && firstChanged === entries.length && firstChanged === cachedSource.length) {
        // Nothing at all changed since last time - reuse the whole cached result untouched.
        return { v: POOL_VERSION, pool: cached.poolOut, entries: cached.entries };
    }

    const pool = firstChanged > 0 ? new Map(cached.pool) : new Map();
    const poolOut = firstChanged > 0 ? cached.poolOut.slice() : [];
    const outEntries = firstChanged > 0 ? cached.entries.slice(0, firstChanged) : [];

    for (let i = firstChanged; i < entries.length; i++) {
        outEntries.push(poolizeValue(entries[i], pool, poolOut));
    }

    incrementalPoolCache = { chatId, sourceEntries: entries.slice(), pool, poolOut, entries: outEntries };
    return { v: POOL_VERSION, pool: poolOut, entries: outEntries };
}

/**
 * Decodes a stored itemized-prompts value into a plain, fully-resolved `entries[]` array. Handles every
 * shape this file has ever written:
 *  - a plain array: either the legacy pre-compression format, or the 2026-09-06 stopgap's "no compression"
 *    format - identical shapes, nothing to resolve either way.
 *  - `{v, pool, entries}`: the current exact-content pool-dedup format (poolDedupAll()/poolDedupIncremental()).
 *  - `{v, entries, dedup, rawPromptDelta}`: the brief diff-match-patch-based format this file used between
 *    the server-storage move and the pool-dedup redesign - removed for pegging the main thread, but kept
 *    readable here in case anything was ever written in this shape before the removal landed.
 * @param {object[]|{v: number, pool: string[], entries: object[]}|{v: number, entries: object[], dedup: (string[]|undefined)[], rawPromptDelta: (string|undefined)[]}|null|undefined} stored
 * @returns {object[]}
 */
function decodeStoredItemizedPrompts(stored) {
    if (Array.isArray(stored)) {
        return stored;
    }
    if (!stored || !Array.isArray(stored.entries)) {
        return [];
    }
    if (Array.isArray(stored.pool)) {
        return stored.entries.map(entry => unpoolizeValue(entry, stored.pool));
    }
    if (Array.isArray(stored.rawPromptDelta)) {
        const dmp = new DiffMatchPatch();
        dmp.Diff_Timeout = 2.0;
        /** @type {string|undefined} */
        let previousRawPrompt;
        return stored.entries.map((entry, i) => {
            const delta = stored.rawPromptDelta[i];
            if (typeof delta === 'string' && typeof previousRawPrompt === 'string') {
                entry.rawPrompt = dmp.diff_text2(dmp.diff_fromDelta(previousRawPrompt, delta));
            }
            if (typeof entry.rawPrompt === 'string') {
                previousRawPrompt = entry.rawPrompt;
            }
            const dedupFields = stored.dedup?.[i];
            if (dedupFields?.length && typeof entry.rawPrompt === 'string') {
                for (const field of dedupFields) {
                    entry[field] = entry.rawPrompt;
                }
            }
            return entry;
        });
    }
    return [];
}

/**
 * Gets the itemized prompts for a chat. Reads the local IndexedDB mirror first (if present) for an
 * instant, network-free result, then always reconciles against the server in the background - the server
 * response, whenever it resolves, is authoritative and overwrites both the live `itemizedPrompts` state and
 * the local mirror. Callers that need to know when the server-backed result has landed can listen for
 * event_types.ITEMIZED_PROMPTS_LOADED, which fires once for the local read (if any) and again once the
 * server reconciliation completes.
 * @param {string} chatId Chat ID to load
 */
export async function loadItemizedPrompts(chatId) {
    if (!chatId) {
        itemizedPrompts = [];
        return;
    }

    try {
        const local = await promptStorage.getItem(chatId);
        if (local) {
            itemizedPrompts = decodeStoredItemizedPrompts(local);
            await eventSource.emit(event_types.ITEMIZED_PROMPTS_LOADED, { chatId: chatId, fromLocalMirror: true });
        }
    } catch (error) {
        console.log('Error reading local itemized-prompts mirror for chat', chatId, error);
    }

    try {
        const response = await fetch('/api/itemized-prompts/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ chatId }),
        });

        // The chat may have changed out from under this call while the request was in flight (loading is
        // fired off per chat-switch, not queued) - never clobber whatever's current with a stale response.
        if (getCurrentChatId() !== chatId) {
            return;
        }

        if (response.status === 404) {
            // Nothing stored server-side yet - only actually "nothing" if the local mirror didn't have it
            // either (checked above); otherwise leave the locally-loaded result in place.
            if (!itemizedPrompts.length) {
                itemizedPrompts = [];
            }
        } else if (response.ok) {
            const stored = await response.json();
            itemizedPrompts = decodeStoredItemizedPrompts(stored);
            await promptStorage.setItem(chatId, stored);
        } else {
            console.log('Error loading itemized prompts for chat', chatId, response.statusText);
        }

        await eventSource.emit(event_types.ITEMIZED_PROMPTS_LOADED, { chatId: chatId });
    } catch (error) {
        console.log('Error loading itemized prompts for chat', chatId, error);
    }
}

/**
 * Saves the itemized prompts for a chat: pool-dedupes (exact-content, not diffing - see
 * poolDedupIncremental()'s doc comment), sends the result to server-side storage
 * (`src/endpoints/itemized-prompts.js`, which gzips it at rest), and writes the same result to the local
 * IndexedDB mirror so it stays available without a network round trip. Called after every single generated
 * message (script.js's saveChatConditional()).
 * @param {string} chatId Chat ID to save itemized prompts for
 */
export async function saveItemizedPrompts(chatId) {
    try {
        if (!chatId) {
            return;
        }

        const data = poolDedupIncremental(chatId, itemizedPrompts);
        const response = await fetch('/api/itemized-prompts/save', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ chatId, data }),
        });

        if (!response.ok) {
            console.log('Error saving itemized prompts for chat', chatId, response.statusText);
            return;
        }

        await promptStorage.setItem(chatId, data);
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
 * Not just the chats a user happens to reopen: loadItemizedPrompts() only mirrors locally what it's
 * already asked the server for, so a chat sitting untouched in the local backlog would otherwise never get
 * uploaded, and its browser-local bytes would never be reclaimed either. This does a full scan instead.
 *
 * Call once at boot; safe to call unconditionally - both the in-session guard and the server's own "already
 * present" check (POST /api/itemized-prompts/migrate) make it a no-op on every call after the backlog is
 * drained. Never awaited by its caller, and never retried within a session on failure - a real (non-4xx)
 * failure just logs once and leaves the whole local backlog in place for the next boot to pick up, rather
 * than looping or hammering the server. Naturally resumable if interrupted: a chat is only removed from the
 * local backlog once the server has confirmed (in its response) that it holds the data, so a browser closed
 * mid-upload just means the next boot's scan finds - and only re-considers - whatever didn't get confirmed.
 *
 * The whole backlog goes up in a single request (POST /api/itemized-prompts/migrate, body { chats: [...] })
 * rather than one GET+save round trip per chat: a real backlog can run to tens of thousands of chats, and
 * per-chat round-tripping - even concurrent - turned into exactly the request flood (and the "why did I get
 * a 404" confusion around each chat's very first, expected-not-found GET) this rewrite exists to remove.
 * The "does the server already have this" check that used to be a GET per chat now happens server-side,
 * inside that one request, so it still can't clobber a chat already migrated from another device/browser.
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
            const hasContent = Array.isArray(value)
                ? value.length > 0
                : (Array.isArray(value?.entries) && value.entries.length > 0);
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

    try {
        const chats = local.map(([chatId, value]) => ({
            chatId,
            data: poolDedupAll(decodeStoredItemizedPrompts(value)),
        }));

        const response = await fetch('/api/itemized-prompts/migrate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ chats }),
        });

        if (!response.ok) {
            // A real (transient) failure, not per-chat - leave the entire local backlog alone and let
            // the next boot's single request retry it, rather than falling back to per-chat requests.
            console.log('Error migrating itemized prompts to server:', response.statusText);
            return;
        }

        const { migrated } = await response.json();
        for (const chatId of migrated ?? []) {
            await promptStorage.removeItem(chatId);
        }
        console.log(`[itemized-prompts] Server migration pass complete (${migrated?.length ?? 0}/${local.length} chat(s) migrated).`);
    } catch (error) {
        console.log('Error migrating itemized prompts to server:', error);
    }
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
 * Deletes the itemized prompts for a chat from server-side storage and the local mirror.
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
        await promptStorage.removeItem(chatId);
        await eventSource.emit(event_types.ITEMIZED_PROMPTS_DELETED, { chatId: chatId, all: false });
    } catch {
        console.log('Error deleting itemized prompts for chat', chatId);
    }
}

/**
 * Empties the itemized prompts array, every chat's server-side storage, and the local mirror.
 */
export async function clearItemizedPrompts() {
    try {
        await fetch('/api/itemized-prompts/clear', {
            method: 'POST',
            headers: getRequestHeaders(),
        });
        await promptStorage.clear();
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
