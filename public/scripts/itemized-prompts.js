import { DiffMatchPatch, DOMPurify, localforage } from '../lib.js';
import { getCurrentChatId, reloadCurrentChat } from '../script.js';
import { chat } from './chat-state.js';
import { getRequestHeaders } from './request-headers.js';
import { event_types, eventSource } from './events.js';
import { t } from './i18n.js';
import { isStoredNodeId } from './node-identity.js';
import { Popup, POPUP_TYPE } from './popup.js';
import { registerDebugFunction } from './power-user.js';
import { isMobile } from './RossAscends-mods.js';
import { renderTemplateAsync } from './templates.js';
import { getTokenizerState } from './tokenizers.js';
import { renderCountBasis } from './tokenizer-notices.js';
import { copyText, escapeHtml } from './utils.js';

let PromptArrayItemForRawPromptDisplay;
let priorPromptArrayItemForRawPromptDisplay;

export let itemizedPrompts = [];

export const ITEMIZED_PROMPT_FLAG = 'has_itemized_prompt';

/**
 * @param {string} route
 * @param {object} body
 * @returns {Promise<Response>}
 */
function post(route, body) {
    return fetch(`/api/itemized-prompts/${route}`, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
}

/**
 * @param {string} nodeId
 * @returns {Promise<{ entry: Record<string, any>, previous_node_id: string|null } | null>}
 */
async function fetchItemization(nodeId) {
    const response = await post('message', { node_id: nodeId });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`the server answered ${response.status}`);
    return response.json();
}

async function clearItemizedPrompts() {
    try {
        const response = await post('clear', {});
        if (!response.ok) throw new Error(`the server answered ${response.status}`);
        itemizedPrompts = [];
    } catch (error) {
        console.error('Error clearing itemized prompts', error);
        toastr.error(t`The prompt breakdowns couldn't be deleted.`);
    }
}

/**
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

/** @type {Record<string, { label: () => string, color: string }>} */
const PART_VIEWS = {
    main: { label: () => t`Main prompt`, color: 'grey' },
    system_prompt: { label: () => t`System prompt`, color: 'grey' },
    story_string: { label: () => t`Story string`, color: 'indianred' },
    description: { label: () => t`Description`, color: 'indianred' },
    personality: { label: () => t`Personality`, color: 'indianred' },
    scenario: { label: () => t`Scenario`, color: 'indianred' },
    persona: { label: () => t`Persona description`, color: 'indianred' },
    world_info: { label: () => t`World info`, color: 'gold' },
    examples: { label: () => t`Example dialogues`, color: 'salmon' },
    chat_start: { label: () => t`Chat start markers`, color: 'grey' },
    chat_history: { label: () => t`Chat history`, color: 'palegreen' },
    injections: { label: () => t`Injected into the chat`, color: 'cornflowerblue' },
    post_history: { label: () => t`Post-history instructions`, color: 'grey' },
    auxiliary: { label: () => t`Auxiliary prompt`, color: 'grey' },
    nudge: { label: () => t`Nudges`, color: 'grey' },
    impersonate: { label: () => t`Impersonation prompt`, color: 'grey' },
    extensions: { label: () => t`Extensions`, color: 'cornflowerblue' },
    summary: { label: () => t`Summary`, color: 'cornflowerblue' },
    authors_note: { label: () => t`Author's Note`, color: 'cornflowerblue' },
    smart_context: { label: () => t`Smart Context`, color: 'cornflowerblue' },
    chat_vectors: { label: () => t`Vector Storage (chats)`, color: 'cornflowerblue' },
    data_bank_vectors: { label: () => t`Vector Storage (Data Bank)`, color: 'cornflowerblue' },
    bias: { label: () => t`Prompt bias`, color: 'mediumpurple' },
    other_prompts: { label: () => t`Other prompts`, color: 'grey' },
};

/**
 * Upstream's export: the prompt view's values for an itemization, as the server counted it.
 * @param {Record<string, any>[]} itemizedPrompts
 * @param {number} thisPromptSet
 * @param {number} incomingMesId
 */
export async function itemizedParams(itemizedPrompts, thisPromptSet, incomingMesId) {
    const set = itemizedPrompts[thisPromptSet];
    const total = Number(set.total) || 0;
    const getFriendlyName = (value) => $(`#rm_api_block select option[value="${value}"]`).first().text() || value;
    const apiUsed = chat[incomingMesId]?.extra?.api;
    const countOf = { chat_history: set.messages_count, examples: set.examples_count };
    const parts = (Array.isArray(set.parts) ? set.parts : [])
        .filter(p => Number(p?.tokens) > 0)
        .map(p => {
            const view = PART_VIEWS[p.part] ?? { label: () => String(p.part), color: 'grey' };
            return {
                label: view.label(),
                color: view.color,
                tokens: Number(p.tokens),
                count: countOf[p.part] || undefined,
                percent: (total > 0 ? (Number(p.tokens) / total) * 100 : 0).toFixed(2),
            };
        });
    return {
        mainApiFriendlyName: set.api ? getFriendlyName(set.api) : '',
        modelUsed: chat[incomingMesId]?.extra?.model,
        apiUsed: apiUsed ? getFriendlyName(apiUsed) : apiUsed,
        presetName: set.preset || t`(Unknown)`,
        samplerConfig: JSON.stringify(set.sampler_config ?? {}, null, 2),
        tokenizerAnswer: set.tokenizer ?? null,
        selectedTokenizer: set.tokenizer?.name ?? '',
        parts,
        total,
        maxContext: Number(set.max_context) || 0,
        padding: Number(set.padding) || 0,
    };
}

function findItemizedPromptSet(itemizedPrompts, incomingMesId) {
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
 * @param {Record<string, any>[]} itemizedPrompts
 * @param {number|string} requestedMesId
 * @param {{ loadPrevious?: () => Promise<Record<string, any>|null> }} [options]
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

    const template = await renderTemplateAsync('itemization', params);

    const popup = new Popup(template, POPUP_TYPE.TEXT);

    renderCountBasis(popup.dlg.querySelector('#itemizationTokenizerName'), params.tokenizerAnswer, { omitCopyLabel: true });

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


const UPSTREAM_STORE = 'SillyTavern_Prompts';
const UPSTREAM_BATCH_CHATS = 200;
const UPSTREAM_BATCH_BYTES = 4 * 1024 * 1024;
const UPSTREAM_WARNED_KEY = 'itemized_prompts_upstream_left_out';

export async function importUpstreamItemizedPrompts() {
    const storage = localforage.createInstance({ name: UPSTREAM_STORE });
    /** @type {{ chat_id: string, entries: object[] }[]} */
    const chats = [];
    /** @type {string[]} */
    const leftOut = [];
    try {
        await storage.iterate((value, chatId) => {
            if (Array.isArray(value)) {
                if (value.length) chats.push({ chat_id: chatId, entries: value });
            } else {
                leftOut.push(t`${chatId}: not upstream's format of itemized prompts, kept in this browser`);
            }
        });
    } catch (error) {
        console.warn('[itemized-prompts] reading upstream\'s itemized prompts in this browser failed', error);
        return;
    }
    let batch = [];
    let bytes = 0;
    const send = async () => {
        if (!batch.length) return;
        const sent = batch;
        batch = [];
        bytes = 0;
        const response = await post('import-upstream', { state: getTokenizerState(), chats: sent });
        if (!response.ok) {
            leftOut.push(...sent.map(c => t`${c.chat_id}: the server couldn't store it (${response.status}), kept in this browser`));
            return;
        }
        const { results } = await response.json();
        for (const [i, r] of results.entries()) {
            const chat = sent[i];
            if (r.status !== 'stored') {
                leftOut.push(t`${chat.chat_id}: ${r.why}, kept in this browser`);
                continue;
            }
            if (!r.unmatched.length) {
                await storage.removeItem(chat.chat_id);
                continue;
            }
            const unplaced = new Set(r.unmatched.map((/** @type {{ entry: number }} */ u) => u.entry));
            await storage.setItem(chat.chat_id, chat.entries.filter((_, j) => unplaced.has(j)));
            for (const u of r.unmatched) leftOut.push(t`${chat.chat_id}, message ${String(u.mesId)}: ${u.why}, kept in this browser`);
        }
    };
    for (const chat of chats) {
        const size = JSON.stringify(chat.entries).length;
        if (batch.length && (batch.length >= UPSTREAM_BATCH_CHATS || bytes + size > UPSTREAM_BATCH_BYTES)) await send();
        batch.push(chat);
        bytes += size;
    }
    await send();
    if (!leftOut.length) {
        localStorage.removeItem(UPSTREAM_WARNED_KEY);
        return;
    }
    const text = leftOut.join('\n');
    console.warn(`[itemized-prompts] upstream itemized prompts not imported:\n${text}`);
    if (localStorage.getItem(UPSTREAM_WARNED_KEY) === text) return;
    localStorage.setItem(UPSTREAM_WARNED_KEY, text);
    toastr.warning(leftOut.map(line => escapeHtml(line)).join('<br>'), t`Some of upstream's itemized prompts weren't imported`, {
        escapeHtml: false, timeOut: 0, extendedTimeOut: 0, closeButton: true,
    });
}

export function initItemizedPrompts() {
    eventSource.on(event_types.APP_READY, () => {
        importUpstreamItemizedPrompts().catch(error => console.warn('[itemized-prompts] importing upstream\'s itemized prompts failed', error));
    });

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
