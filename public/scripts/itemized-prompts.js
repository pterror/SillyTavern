import { DiffMatchPatch, DOMPurify } from '../lib.js';
import { getCurrentChatId, getSelectionState, reloadCurrentChat } from '../script.js';
import { chat } from './chat-state.js';
import { getRequestHeaders } from './request-headers.js';
import { event_types, eventSource } from './events.js';
import { t } from './i18n.js';
import { oai_settings } from './chat-completion-settings.js';
import { isStoredNodeId } from './node-identity.js';
import { Popup, POPUP_TYPE } from './popup.js';
import { power_user, registerDebugFunction } from './power-user.js';
import { isMobile } from './RossAscends-mods.js';
import { renderTemplateAsync } from './templates.js';
import { getTokenCountsWithTokenizer } from './tokenizers.js';
import { renderCountBasis } from './tokenizer-notices.js';
import { copyText } from './utils.js';

let PromptArrayItemForRawPromptDisplay;
let priorPromptArrayItemForRawPromptDisplay;

/**
 * The itemizations the page holds, each with its message's position in the chat as `mesId`: the one whose "Prompt"
 * view is open, or what upstream's `loadItemizedPrompts()` was last asked for. The server keeps one per reply
 * (src/chat-engine.js, recordItemization()) and records it when it stores the reply; nothing else in the page keeps them.
 */
export let itemizedPrompts = [];

/** `extra` key the server sets on a loaded message whose node has an itemization (src/chat-engine.js). */
export const ITEMIZED_PROMPT_FLAG = 'has_itemized_prompt';

/**
 * @param {string} route
 * @param {object} body
 * @returns {Promise<Response>}
 */
function post(route, body) {
    return fetch(`/api/itemized-prompts/${route}`, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
}

/** @returns {{ group_id: string } | { avatar_url: string } | null} The open chat's owner, as the routes name one. */
function currentOwner() {
    const selection = getSelectionState();
    if (selection.type === 'group') return { group_id: selection.groupId };
    if (selection.type === 'character') return { avatar_url: selection.avatar };
    return null;
}

/**
 * One message's itemization.
 * @param {string} nodeId
 * @returns {Promise<{ entry: Record<string, any>, previous_node_id: string|null } | null>} null when it has none.
 */
async function fetchItemization(nodeId) {
    const response = await post('message', { node_id: nodeId });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`the server answered ${response.status}`);
    return response.json();
}

/**
 * The itemizations of a chat of the open character or group, each as `{ index, node_id, entry }`.
 * @param {string} chatId
 * @returns {Promise<{ index: number, node_id: string, entry: Record<string, any> }[]>}
 */
async function fetchChatItemizations(chatId) {
    const owner = currentOwner();
    if (!owner) return [];
    const response = await post('chat', { ...owner, chat: chatId });
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`the server answered ${response.status}`);
    return (await response.json()).entries ?? [];
}

/**
 * Upstream's export: holds the itemizations of a chat of the open character or group in `itemizedPrompts`.
 * @param {string} chatId
 */
export async function loadItemizedPrompts(chatId) {
    if (!chatId) {
        itemizedPrompts = [];
        return;
    }
    try {
        const entries = await fetchChatItemizations(chatId);
        itemizedPrompts = entries.map(({ index, entry }) => ({ ...entry, mesId: index }));
        await eventSource.emit(event_types.ITEMIZED_PROMPTS_LOADED, { chatId: chatId });
    } catch (error) {
        console.error('Error loading itemized prompts for chat', chatId, error);
        itemizedPrompts = [];
    }
}

/**
 * Upstream's export: stores the entries of `itemizedPrompts` for the messages of a chat of the open character or
 * group, each at the message its `mesId` is the position of. A message with no entry here keeps the one it has.
 * @param {string} chatId
 */
export async function saveItemizedPrompts(chatId) {
    if (!chatId || !Array.isArray(itemizedPrompts) || itemizedPrompts.length === 0) return;
    try {
        /** @type {(string|undefined)[]} */
        let nodeIds;
        if (chatId === getCurrentChatId()) {
            nodeIds = chat.map(message => (isStoredNodeId(message?.node_id) ? message.node_id : undefined));
        } else {
            const owner = currentOwner();
            const response = owner ? await post('chat', { ...owner, chat: chatId, ids_only: true }) : null;
            if (!response?.ok) throw new Error(`no chat ${chatId}`);
            nodeIds = (await response.json()).node_ids ?? [];
        }
        const items = [];
        const unplaced = [];
        for (const entry of itemizedPrompts) {
            const nodeId = nodeIds[Number(entry?.mesId)];
            if (nodeId) items.push({ node_id: nodeId, entry });
            else unplaced.push(entry?.mesId);
        }
        if (unplaced.length) {
            toastr.warning(t`Not saved: the prompt breakdowns for messages ${unplaced.join(', ')}, which aren't saved messages of that chat.`);
        }
        if (items.length === 0) return;
        const response = await post('set', { items });
        if (!response.ok) throw new Error(`the server answered ${response.status}`);
        await eventSource.emit(event_types.ITEMIZED_PROMPTS_SAVED, { chatId: chatId });
    } catch (error) {
        console.error('Error saving itemized prompts for chat', chatId, error);
        toastr.error(t`The prompt breakdowns couldn't be saved.`);
    }
}

/**
 * Upstream's export: replaces the prompt text of a message's itemization.
 * @param {number} mesId
 * @param {string} promptText
 */
export async function replaceItemizedPromptText(mesId, promptText) {
    if (!Array.isArray(itemizedPrompts)) {
        itemizedPrompts = [];
    }
    const held = itemizedPrompts.find(x => x.mesId === mesId);
    if (held) held.rawPrompt = promptText;

    const nodeId = chat[mesId]?.node_id;
    if (!isStoredNodeId(nodeId)) return;
    try {
        const response = await post('set', { items: [{ node_id: nodeId, fields: { rawPrompt: promptText } }] });
        if (!response.ok) throw new Error(`the server answered ${response.status}`);
    } catch (error) {
        console.error('Error replacing the itemized prompt text of message', mesId, error);
        toastr.error(t`The prompt text couldn't be saved.`);
    }
}

/**
 * Upstream's export: removes the itemizations of a chat of the open character or group.
 * @param {string} chatId
 */
export async function deleteItemizedPrompts(chatId) {
    if (!chatId) return;
    const owner = currentOwner();
    try {
        const response = owner ? await post('delete', { ...owner, chat: chatId }) : null;
        if (response && !response.ok && response.status !== 404) throw new Error(`the server answered ${response.status}`);
        await eventSource.emit(event_types.ITEMIZED_PROMPTS_DELETED, { chatId: chatId, all: false });
    } catch (error) {
        console.error('Error deleting itemized prompts for chat', chatId, error);
        toastr.error(t`The prompt breakdowns couldn't be deleted.`);
    }
}

/** Upstream's export: removes every itemization. */
export async function clearItemizedPrompts() {
    try {
        const response = await post('clear', {});
        if (!response.ok) throw new Error(`the server answered ${response.status}`);
        itemizedPrompts = [];
        await eventSource.emit(event_types.ITEMIZED_PROMPTS_DELETED, { all: true });
    } catch (error) {
        console.error('Error clearing itemized prompts', error);
        toastr.error(t`The prompt breakdowns couldn't be deleted.`);
    }
}

/**
 * Opens a message's "Prompt" view: fetches its itemization, and the one it is diffed against only when asked.
 * @param {number} mesId
 */
async function showMessageItemization(mesId) {
    const nodeId = chat[mesId]?.node_id;
    if (!isStoredNodeId(nodeId)) return;
    let found;
    try {
        found = await fetchItemization(nodeId);
    } catch (error) {
        console.error('Error reading the itemized prompt of message', mesId, error);
        toastr.error(t`The prompt breakdown couldn't be loaded.`);
        return;
    }
    if (!found) {
        toastr.info(t`This message has no prompt breakdown.`);
        return;
    }
    const previousNodeId = found.previous_node_id;
    itemizedPrompts = [{ ...found.entry, mesId }];
    try {
        await promptItemize(itemizedPrompts, mesId, {
            loadPrevious: previousNodeId ? async () => (await fetchItemization(previousNodeId))?.entry ?? null : undefined,
        });
    } finally {
        itemizedPrompts = [];
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

    const { counts: tokenCounts, tokenizer: countTokenizer, answer: countAnswer } = await getTokenCountsWithTokenizer(tokenFields.map(([, text]) => text));
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
        tokenizerAnswer: countAnswer,
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
        params.selectedTokenizer = countTokenizer.tokenizerName;
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
        params.selectedTokenizer = countTokenizer.tokenizerName;
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

/**
 * Shows the "Prompt" view of a message's entry in `itemizedPrompts`.
 * @param {Record<string, any>[]} itemizedPrompts
 * @param {number|string} requestedMesId
 * @param {{ loadPrevious?: () => Promise<Record<string, any>|null> }} [options] `loadPrevious`: the entry to diff
 * against, fetched when the diff is asked for; without it, the nearest earlier entry in `itemizedPrompts` that holds
 * a raw prompt, as upstream finds it.
 */
export async function promptItemize(itemizedPrompts, requestedMesId, { loadPrevious } = {}) {
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

    renderCountBasis(popup.dlg.querySelector('#itemizationTokenizerName'), params.tokenizerAnswer, {
        omitCopyLabel: params.selectedTokenizer === params.tokenizerAnswer?.name,
    });

    /** @type {HTMLElement} */
    const diffPrevPrompt = popup.dlg.querySelector('#diffPrevPrompt');
    const shownSet = PromptArrayItemForRawPromptDisplay;
    const priorSet = priorPromptArrayItemForRawPromptDisplay;
    /** @type {() => Promise<Record<string, any>|null>} */
    const previousEntry = loadPrevious ?? (async () => itemizedPrompts[priorSet]);
    if (loadPrevious || priorSet >= 0) {
        diffPrevPrompt.style.display = '';
        diffPrevPrompt.addEventListener('click', async function () {
            let previous;
            try {
                previous = await previousEntry();
            } catch (error) {
                console.error('Error reading the previous prompt', error);
            }
            if (!previous) {
                toastr.error(t`The previous prompt couldn't be loaded.`);
                return;
            }
            const dmp = new DiffMatchPatch();
            const text1 = flatten(previous.rawPrompt);
            const text2 = flatten(itemizedPrompts[shownSet].rawPrompt);

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


/**
 * Upstream's export: swaps the held itemized prompts (`itemizedPrompts`) between two messages. Useful when moving
 * messages around in the chat. The server keeps each itemization with its reply, so a moved message keeps its own;
 * this only renumbers the page's held copy, as upstream's does.
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
 * Upstream's export: drops the held itemized prompt (`itemizedPrompts`) of a message and shifts down the later ones,
 * as upstream's does. The server keeps each itemization with its reply, so a deleted message's goes with it.
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

export function initItemizedPrompts() {
    registerDebugFunction('clearPrompts', 'Delete itemized prompts', 'Deletes every stored prompt breakdown.', async () => {
        await clearItemizedPrompts();
        toastr.info('Itemized prompts deleted.');
        if (getCurrentChatId()) {
            await reloadCurrentChat();
        }
    });

    $(document).on('pointerup', '.mes_prompt', async function () {
        await showMessageItemization(Number($(this).closest('.mes').attr('mesId')));
    });
}
