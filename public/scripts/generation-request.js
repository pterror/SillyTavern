import { getRequestHeaders } from './request-headers.js';
import { beginServerGeneration, endServerGeneration, streamServerGeneration, takeStopResult } from './generation-stop.js';
import { CompactStreamDecoder, ResumableCompactStreamReader } from './llamacpp-compact-stream.js';
import { reportStored, reportStoredHeader } from './stored-report.js';
import { showTokenizerWarnings } from './tokenizer-notices.js';
import { parseTextgenLogprobs } from './textgen-settings.js';
import { parseNovelAILogprobs } from './nai-settings.js';
import { renderTemplateAsync } from './templates.js';
import { Popup } from './popup.js';
import { t } from './i18n.js';

const GENERATE_URL = '/api/generation/generate';

/**
 * @typedef {object} StreamedReply
 * @property {string} text
 * @property {string[]} swipes
 * @property {import('./logprobs.js').TokenLogprobs|null} logprobs
 * @property {any[]} toolCalls
 * @property {{ reasoning: string, assistantNodeId?: string, stored?: unknown, toolCallHandoff: any, toolCallAborted: boolean, workerName?: string }} state
 */

/**
 * @typedef {object} GenerationAnswer
 * @property {string} connection The kind of connection the server generated with (its `main_api`).
 * @property {(() => AsyncGenerator<StreamedReply, void, void>) | null} stream The reply as it comes, when the server streams it.
 * @property {any} data The whole answer, when it doesn't.
 * @property {string} generationId
 * @property {any} settingsSaved The answer to the settings changes the action carried, when it carried any.
 */

/**
 * @param {any} body
 * @returns {string}
 */
function errorMessageOf(body) {
    const error = body?.error ?? body?.detail?.error;
    const message = typeof error === 'string' ? error : (error?.message || error?.code || error?.type);
    return String(message || body?.message || body?.response || t`Unknown error`);
}

/**
 * The answer to the settings changes an action carried, which the server names in a header.
 * @param {Response} response
 * @returns {any}
 */
export function settingsSavedOf(response) {
    const header = response.headers.get('X-ST-Settings-Saved');
    if (!header) return null;
    try {
        return JSON.parse(decodeURIComponent(header));
    } catch {
        return null;
    }
}

/**
 * The answer is an error: shown where it needs more than its text, and thrown with the text.
 * @param {any} body
 * @param {any} [settingsSaved]
 * @returns {never}
 */
function failWith(body, settingsSaved = null) {
    if (body?.quota_error) {
        renderTemplateAsync('quotaError').then((html) => Popup.show.text('Quota Error', html));
    }
    const message = errorMessageOf(body);
    if (message.includes('requires moderation')) {
        const reasons = `Reasons: ${body?.error?.metadata?.reasons?.join(', ') ?? '(N/A)'}`;
        toastr.info(body?.error?.metadata?.flagged_input ?? '(N/A)', reasons, { timeOut: 10000 });
    }
    throw { error: { message }, settings_saved: settingsSaved, ...(body?.settings_not_saved ? { settings_conflict: body.conflictingKeys ?? null } : {}) };
}

/**
 * @param {Response} response
 * @param {string} connection
 * @returns {() => AsyncGenerator<StreamedReply, void, void>}
 */
function streamOf(response, connection) {
    const reader = new ResumableCompactStreamReader(response, '/api/generation/generate/resume', getRequestHeaders);
    return async function* streamData() {
        const decoder = new CompactStreamDecoder();
        let text = '';
        /** @type {string[]} */
        const swipes = [];
        /** @type {StreamedReply['state']} */
        const state = { reasoning: '', toolCallHandoff: null, toolCallAborted: false };
        let index = 0;
        /** @type {any} */
        let probabilities = null;
        while (true) {
            const { done, value } = await reader.read();
            const events = done ? decoder.flush() : (value?.length ? decoder.push(value) : []);
            /** @type {import('./logprobs.js').TokenLogprobs|null} */
            let logprobs = null;
            for (const event of events) {
                if ('index' in event) {
                    index = event.index;
                } else if ('probabilities' in event) {
                    probabilities = event.probabilities;
                } else if ('content' in event) {
                    if (index > 0) {
                        swipes[index - 1] = (swipes[index - 1] ?? '') + event.content;
                    } else {
                        text += event.content;
                        if (connection === 'textgenerationwebui') logprobs = parseTextgenLogprobs(event.content, probabilities);
                        if (connection === 'novel') logprobs = parseNovelAILogprobs(probabilities);
                    }
                    probabilities = null;
                } else if ('reasoning' in event) {
                    state.reasoning += event.reasoning;
                } else if ('assistantNodeId' in event) {
                    state.assistantNodeId = event.assistantNodeId;
                } else if ('control' in event) {
                    const control = event.control;
                    if (control?.stored) {
                        state.stored = control.stored;
                        reportStored(control.stored);
                    } else if (control?.tool_call_handoff) {
                        state.toolCallHandoff = control.tool_call_handoff;
                    } else if (control?.tool_call_aborted) {
                        state.toolCallAborted = true;
                    } else if (control?.worker_name) {
                        state.workerName = `Generated by Horde worker: ${control.worker_name} [${control.model}]`;
                    } else if (control?.warnings) {
                        showTokenizerWarnings(control.warnings);
                    } else if (control?.error) {
                        failWith(control);
                    }
                }
            }
            if (events.length) yield { text, swipes, logprobs, toolCalls: [], state };
            if (done) return;
        }
    };
}

/**
 * Sends one generation action. The server knows the connection and everything the prompt is made from; it answers with
 * the reply as a stream when it streams it, or whole.
 * @param {object} body The action: whose chat, where in it, what kind of turn, and what the page holds that the server doesn't.
 * @param {AbortSignal} signal
 * @param {string} [url] The raw generation's route, for a reply to given text instead of to the chat.
 * @returns {Promise<GenerationAnswer>}
 */
export async function sendGeneration(body, signal, url = GENERATE_URL) {
    const generationId = beginServerGeneration();
    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'X-Generation-Id': generationId },
            cache: 'no-cache',
            body: JSON.stringify(body),
            signal,
        });
    } catch (error) {
        endServerGeneration(generationId);
        takeInStoppedReply(generationId);
        throw error;
    }
    reportStoredHeader(response);
    const connection = response.headers.get('X-ST-Connection') ?? '';
    const settingsSaved = settingsSavedOf(response);
    if (response.ok && response.headers.get('X-ST-Stream-Format') === 'compact-v1') {
        streamServerGeneration(generationId);
        return { connection, stream: streamOf(response, connection), data: null, generationId, settingsSaved };
    }
    try {
        const data = await response.json().catch(() => ({ error: { message: response.statusText } }));
        reportStored(data?.stored);
        if (!response.ok || data?.error) failWith(data, settingsSaved);
        showTokenizerWarnings(data.warnings);
        return { connection, stream: null, data, generationId, settingsSaved };
    } catch (error) {
        takeInStoppedReply(generationId);
        throw error;
    } finally {
        endServerGeneration(generationId);
    }
}

/** @type {(stop: import('./generation-stop.js').StopResult|null) => void} */
let onStoppedReplyStored = () => { };

/**
 * @param {(stop: import('./generation-stop.js').StopResult|null) => void} handler
 */
export function onStoppedReply(handler) {
    onStoppedReplyStored = handler;
}

/**
 * @param {string} generationId
 */
function takeInStoppedReply(generationId) {
    takeStopResult(generationId)?.then(stop => onStoppedReplyStored(stop));
}

/**
 * The whole of a streamed reply, for a turn that isn't shown as it comes.
 * @param {() => AsyncGenerator<StreamedReply, void, void>} stream
 * @returns {Promise<{ text: string, swipes: string[], reasoning: string, workerName?: string, assistant_node_id?: string }>}
 */
export async function wholeReplyOf(stream) {
    /** @type {StreamedReply|null} */
    let last = null;
    for await (const part of stream()) last = part;
    return {
        text: last?.text ?? '',
        swipes: last?.swipes ?? [],
        reasoning: last?.state.reasoning ?? '',
        ...(last?.state.workerName ? { workerName: last.state.workerName } : {}),
        ...(last?.state.assistantNodeId ? { assistant_node_id: last.state.assistantNodeId } : {}),
    };
}
