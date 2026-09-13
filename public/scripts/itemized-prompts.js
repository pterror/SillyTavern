import { DiffMatchPatch, DOMPurify, localforage } from '../lib.js';
import { chat, event_types, eventSource, getCurrentChatId, getRequestHeaders, reloadCurrentChat } from '../script.js';
import { t } from './i18n.js';
import { oai_settings } from './chat-completion-settings.js';
import { Popup, POPUP_TYPE } from './popup.js';
import { power_user, registerDebugFunction } from './power-user.js';
import { isMobile } from './RossAscends-mods.js';
import { renderTemplateAsync } from './templates.js';
import { getFriendlyTokenizerName, getTokenCountsAsyncBatch } from './tokenizers.js';
import { copyText } from './utils.js';

let PromptArrayItemForRawPromptDisplay;
let priorPromptArrayItemForRawPromptDisplay;

/** Server-side storage is the source of truth; this is a local mirror for offline/instant reads. */
const promptStorage = localforage.createInstance({ name: 'SillyTavern_Prompts' });
export let itemizedPrompts = [];

/** Bumped only if the pool-dedup wire format itself changes. */
const POOL_VERSION = 2;

/** Exact-content dedup (plain Map lookup, not diffing) - replaces each non-empty string, recursively, with a reference into a shared per-chat pool. */
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

/** Inverse of poolizeValue(). */
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

/** Pool-dedupes every entry from scratch (no previous pool to reuse against). */
function poolDedupAll(entries) {
    const pool = new Map();
    const poolOut = [];
    const outEntries = entries.map(entry => poolizeValue(entry, pool, poolOut));
    return { v: POOL_VERSION, pool: poolOut, entries: outEntries };
}

/** Cache for poolDedupIncremental(); invalidated implicitly whenever a different chatId is saved. */
let incrementalPoolCache = /** @type {{chatId: string, sourceEntries: object[], pool: Map<string, number>, poolOut: string[], entries: object[]} | null} */ (null);

/**
 * Same contract as poolDedupAll(), but reuses the cached pool for any entries-array prefix that's still
 * reference-identical to last time, since the whole chat is re-sent (not patched) on every save.
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

/** Decodes a stored value into a plain `entries[]` array, handling the plain-array, pool-dedup, and legacy diff-patch formats this file has written over time. */
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
 * Reads the local mirror first for an instant result, then reconciles against the server, which is
 * authoritative. ITEMIZED_PROMPTS_LOADED fires once per source, so listeners may see it twice.
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

        // Avoid clobbering with a stale response if the user switched chats while this was in flight.
        if (getCurrentChatId() !== chatId) {
            return;
        }

        if (response.status === 404) {
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

/** Pool-dedupes and saves the itemized prompts for a chat to both server storage and the local mirror. */
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

let allChatsMigrationStarted = false;

/** One-time upload of this browser's local backlog to server storage; scans the whole store since loadItemizedPrompts() only mirrors chats that get reopened, and batches uploads since a backlog can run to tens of thousands of chats. */
export async function migrateAllItemizedPrompts() {
    if (allChatsMigrationStarted) {
        return;
    }
    allChatsMigrationStarted = true;

    /** @type {[string, object[]|object][]} */
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

    // MAX_BATCH_CHATS also caps backlogs of many small chats, where the byte cap alone wouldn't limit count.
    const MAX_BATCH_BYTES = 4 * 1024 * 1024;
    const MAX_BATCH_CHATS = 200;
    const BATCH_CONCURRENCY = 4;

    const items = local.map(([chatId, value]) => {
        const data = poolDedupAll(decodeStoredItemizedPrompts(value));
        return { chatId, data, size: JSON.stringify(data).length };
    });

    /** @type {{chatId: string, data: object}[][]} */
    const batches = [];
    let current = [];
    let currentBytes = 0;
    for (const item of items) {
        if (current.length > 0 && (currentBytes + item.size > MAX_BATCH_BYTES || current.length >= MAX_BATCH_CHATS)) {
            batches.push(current);
            current = [];
            currentBytes = 0;
        }
        current.push({ chatId: item.chatId, data: item.data });
        currentBytes += item.size;
    }
    if (current.length > 0) {
        batches.push(current);
    }

    console.log(`[itemized-prompts] Migrating ${local.length} locally-cached chat(s) to server storage in ${batches.length} batch(es)...`);

    let cursor = 0;
    let migratedCount = 0;

    async function worker() {
        while (cursor < batches.length) {
            const batch = batches[cursor++];
            try {
                const response = await fetch('/api/itemized-prompts/migrate', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ chats: batch }),
                });

                if (!response.ok) {
                    // Leave this batch's chats in place for a future boot's scan to retry, rather than looping here.
                    console.log('Error migrating a batch of itemized prompts to server:', response.statusText);
                    continue;
                }

                const { migrated } = await response.json();
                for (const chatId of migrated ?? []) {
                    await promptStorage.removeItem(chatId);
                    migratedCount++;
                }
            } catch (error) {
                console.log('Error migrating a batch of itemized prompts to server:', error);
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, batches.length) }, () => worker()));
    console.log(`[itemized-prompts] Server migration pass complete (${migratedCount}/${local.length} chat(s) migrated across ${batches.length} batch(es)).`);
}

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
    const set = itemizedPrompts[thisPromptSet];
    const isOpenAi = set.main_api === 'openai';

    // Every field that needs a real token count, gathered up front so they can all go out in one
    // batched request instead of one request per field - the non-OpenAI-only fields are included
    // here too (rather than a second batch later) whenever this prompt set needs them, since we
    // already know this_main_api at this point.
    /** @type {[string, string][]} */
    const tokenFields = [
        ['charDescriptionTokens', set.charDescription],
        ['charPersonalityTokens', set.charPersonality],
        ['scenarioTextTokens', set.scenarioText],
        ['userPersonaStringTokens', set.userPersona],
        ['worldInfoStringTokens', set.worldInfoString],
        ['allAnchorsTokens', set.allAnchors],
        ['summarizeStringTokens', set.summarizeString],
        ['authorsNoteStringTokens', set.authorsNoteString],
        ['smartContextStringTokens', set.smartContextString],
        ['beforeScenarioAnchorTokens', set.beforeScenarioAnchor],
        ['afterScenarioAnchorTokens', set.afterScenarioAnchor],
        ['zeroDepthAnchorTokens', set.zeroDepthAnchor], // TODO: unused
        ['chatInjects', set.chatInjects],
        ['chatVectorsStringTokens', set.chatVectorsString],
        ['dataBankVectorsStringTokens', set.dataBankVectorsString],
    ];
    if (!isOpenAi) {
        tokenFields.push(
            ['finalPromptTokens', set.finalPrompt],
            ['storyStringTokens', set.storyString],
            ['examplesStringTokens', set.examplesString],
            ['mesSendStringTokens', set.mesSendString],
            ['instructionTokens', set.instruction],
            ['promptBiasTokens', set.promptBias],
        );
    }

    const tokenCounts = await getTokenCountsAsyncBatch(tokenFields.map(([, text]) => text));
    /** @type {Record<string, number>} */
    const tokens = Object.fromEntries(tokenFields.map(([key], i) => [key, tokenCounts[i]]));

    const params = {
        ...tokens,
        thisPrompt_padding: set.padding,
        this_main_api: set.main_api,
        modelUsed: chat[incomingMesId]?.extra?.model,
        apiUsed: chat[incomingMesId]?.extra?.api,
        presetName: set.presetName || t`(Unknown)`,
        messagesCount: String(set.messagesCount ?? ''),
        examplesCount: String(set.examplesCount ?? ''),
        samplerConfig: (() => {
            try {
                return JSON.stringify(JSON.parse(set.samplerConfigJson || '{}'), null, 2);
            } catch {
                return '';
            }
        })(),
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
        // finalPromptTokens/storyStringTokens/examplesStringTokens/mesSendStringTokens/instructionTokens/
        // promptBiasTokens already came back with the batch above (tokenFields includes them when !isOpenAi) -
        // storyStringTokens just needs the same worldInfoStringTokens subtraction it always did.
        params.storyStringTokens -= params.worldInfoStringTokens;
        params.ActualChatHistoryTokens = params.mesSendStringTokens - (params.allAnchorsTokens - (params.beforeScenarioAnchorTokens + params.afterScenarioAnchorTokens)) + power_user.token_padding;

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
    migrateAllItemizedPrompts(); // fire-and-forget

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

export function deleteItemizedPromptForMessage(messageId) {
    if (!Array.isArray(itemizedPrompts)) {
        return;
    }

    itemizedPrompts = itemizedPrompts.filter(x => x.mesId !== messageId);

    for (const prompt of itemizedPrompts.filter(x => x.mesId > messageId)) {
        prompt.mesId -= 1;
    }
}
