import {
    amount_gen,
    getRequestHeaders,
    main_api,
    max_context,
    resultCheckStatus,
    saveSettingsDebounced,
    setGenerationProgress,
    setOnlineStatus,
} from '../script.js';
import { SECRET_KEYS, writeSecret } from './secrets.js';
import { retryTransient } from './chat-store.js';
import { delay } from './utils.js';
import { isMobile } from './RossAscends-mods.js';
import { autoSelectInstructPreset } from './instruct-mode.js';
import { t } from './i18n.js';
import { callGenericPopup, POPUP_TYPE } from './popup.js';
import { kai_settings } from './kai-settings.js';

export {
    MIN_LENGTH,
};

let models = [];

export let horde_settings = {
    models: [],
    auto_adjust_response_length: true,
    auto_adjust_context_length: false,
    trusted_workers_only: false,
};

const MAX_RETRIES = 480;
const CHECK_INTERVAL = 2500;
const MIN_LENGTH = 16;

async function getWorkers(force) {
    const response = await fetch('/api/horde/text-workers', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ force }),
    });
    return await response.json();
}

async function getModels(force) {
    const response = await fetch('/api/horde/text-models', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ force }),
    });
    const data = await response.json();
    console.log('getModels', data);
    return data;
}


async function getTaskStatus(taskId) {
    const response = await fetch('/api/horde/task-status', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ taskId }),
    });

    if (!response.ok) {
        throw new Error(`Failed to get task status: ${response.statusText}`);
    }

    return await response.json();
}

async function cancelTask(taskId) {
    const response = await fetch('/api/horde/cancel-task', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ taskId }),
    });

    if (!response.ok) {
        throw new Error(`Failed to cancel task: ${response.statusText}`);
    }
}

export async function checkHordeStatus() {
    try {
        const response = await fetch('/api/horde/status', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
        });

        if (!response.ok) {
            return false;
        }

        const data = await response.json();
        return data.ok;
    } catch (error) {
        console.error(error);
        return false;
    }
}

export async function getStatusHorde() {
    try {
        const hordeStatus = await checkHordeStatus();
        setOnlineStatus(hordeStatus ? t`Connected` : 'no_connection');
    } catch {
        setOnlineStatus('no_connection');
    }

    return resultCheckStatus();
}

function validateHordeModel() {
    let selectedModels = models.filter(m => horde_settings.models.includes(m.name));

    if (selectedModels.length === 0) {
        toastr.warning('No Horde model selected or the selected models are no longer available. Please choose another model');
        throw new Error('No Horde model available');
    }

    return selectedModels;
}

export async function adjustHordeGenerationParams(max_context_length, max_length) {
    const workers = await getWorkers(false);
    let maxContextLength = max_context_length;
    let maxLength = max_length;
    let availableWorkers = [];
    let selectedModels = validateHordeModel();

    if (selectedModels.length === 0) {
        return { maxContextLength, maxLength };
    }

    for (const model of selectedModels) {
        for (const worker of workers) {
            if (model.cluster === worker.cluster && worker.models.includes(model.name)) {
                if (horde_settings.trusted_workers_only && !worker.trusted) {
                    continue;
                }

                availableWorkers.push(worker);
            }
        }
    }

    //get the minimum requires parameters, lowest common value for all selected
    for (const worker of availableWorkers) {
        if (horde_settings.auto_adjust_context_length) {
            maxContextLength = Math.min(worker.max_context_length, maxContextLength);
        }
        if (horde_settings.auto_adjust_response_length) {
            maxLength = Math.min(worker.max_length, maxLength);
        }
    }
    $('#adjustedHordeParams').text(t`Context` + `: ${maxContextLength}, ` + t`Response` + `: ${maxLength}`);
    return { maxContextLength, maxLength };
}

function setContextSizePreview() {
    if (horde_settings.models.length) {
        adjustHordeGenerationParams(max_context, amount_gen);
    } else {
        $('#adjustedHordeParams').text(t`Context` + ': --, ' + t`Response` + ': --');
    }
}

/**
 * Submits one job to `/api/horde/generate-text` and returns its parsed response, or throws (with a
 * user-facing toastr already shown) on a transport error or a real Horde-reported submission error.
 * Factored out of generateHorde() so generateHordeRawAction() below can reuse the exact same
 * submission/error-handling behavior without duplicating it.
 * @param {object} payload The real `/api/horde/generate-text` request body.
 * @returns {Promise<object>} The parsed, non-error response JSON (carries at least `.id`).
 */
async function submitHordeJob(payload) {
    const response = await fetch('/api/horde/generate-text', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        toastr.error(response.statusText, 'Horde generation failed');
        throw new Error(`Horde generation failed: ${response.statusText}`);
    }

    const responseJson = await response.json();

    if (responseJson.error) {
        const reason = responseJson.error?.message || 'Unknown error';
        toastr.error(reason, 'Horde generation failed');
        throw new Error(`Horde generation failed: ${reason}`);
    }

    return responseJson;
}

/**
 * Generator core of the poll loop: yields a progress percentage (0-100) each time
 * `pollHordeTask()` below would have called `setGenerationProgress()`, and `return`s
 * `{text, workerName}` once the job is actually done. `pollHordeTask()` just drains this to keep its
 * existing Promise-returning signature (every current caller) unchanged; `generateHordeRawActionStream()`
 * further below drains it directly to yield real per-step progress through the generic
 * `streamData()`-shaped generator contract instead.
 * @param {string} taskId
 * @param {AbortSignal} signal
 * @returns {AsyncGenerator<number, {text: string, workerName: string}, void>}
 */
async function* pollHordeTaskGenerator(taskId, signal) {
    let queue_position_first = null;
    console.log(`Horde task id = ${taskId}`);

    for (let retryNumber = 0; retryNumber < MAX_RETRIES; retryNumber++) {
        if (signal.aborted) {
            cancelTask(taskId);
            throw new Error('Request aborted');
        }

        const statusCheckJson = await getTaskStatus(taskId);

        if (statusCheckJson.faulted === true) {
            toastr.error('Horde request faulted. Please try again.');
            throw new Error('Horde generation failed: Faulted');
        }

        if (statusCheckJson.is_possible === false) {
            toastr.error('There are no Horde workers that are able to generate text with your request. Please change the parameters or try again later.');
            throw new Error('Horde generation failed: Unsatisfiable request');
        }

        if (statusCheckJson.done && Array.isArray(statusCheckJson.generations) && statusCheckJson.generations.length) {
            yield 100;
            const generatedText = statusCheckJson.generations[0].text;
            const WorkerName = statusCheckJson.generations[0].worker_name;
            const WorkerModel = statusCheckJson.generations[0].model;
            console.log(`Generated by Horde Worker: ${WorkerName} [${WorkerModel}]`);
            return { text: generatedText, workerName: `Generated by Horde worker: ${WorkerName} [${WorkerModel}]` };
        } else if (!queue_position_first) {
            queue_position_first = statusCheckJson.queue_position;
            yield 0;
        } else if (statusCheckJson.queue_position >= 0) {
            let queue_position = statusCheckJson.queue_position;
            const progress = Math.round(100 - (queue_position / queue_position_first * 100));
            yield progress;
        }

        await delay(CHECK_INTERVAL);
    }

    await callGenericPopup(t`Horde request timed out. Try again`, POPUP_TYPE.TEXT);
    throw new Error('Horde timeout');
}

/**
 * Polls `/api/horde/task-status` for `taskId` until it's done, faulted, unsatisfiable, or times out
 * (MAX_RETRIES * CHECK_INTERVAL ~= 20 minutes) - checking `signal.aborted` every iteration so a real
 * disconnect/stop calls `cancelTask()` for real. Factored out of generateHorde() so
 * generateHordeRawAction() below (the real raw-action cutover - see
 * src/endpoints/horde.js's own `buildRawActionHordePayload()` doc comment for the full
 * architecture this is part of) can reuse the EXACT same real polling/progress-reporting/
 * abort-cancellation behavior, rather than duplicating it - this loop is genuinely
 * backend-submission-shape-agnostic, it only ever needs the task id.
 * @param {string} taskId
 * @param {AbortSignal} signal
 * @param {boolean} reportProgress
 * @returns {Promise<{text: string, workerName: string}>}
 */
async function pollHordeTask(taskId, signal, reportProgress) {
    const generator = pollHordeTaskGenerator(taskId, signal);
    let step = await generator.next();
    while (!step.done) {
        if (reportProgress) setGenerationProgress(step.value);
        step = await generator.next();
    }
    return step.value;
}

export async function generateHorde(prompt, params, signal, reportProgress) {
    validateHordeModel();
    delete params.prompt;

    // No idea what these do
    params.n = 1;
    params.frmtadsnsp = false;
    params.frmtrmblln = false;
    params.frmtrmspch = false;
    params.frmttriminc = false;

    const payload = {
        'prompt': prompt,
        'params': params,
        'trusted_workers': horde_settings.trusted_workers_only,
        //"slow_workers": false,
        'models': horde_settings.models,
    };

    const responseJson = await submitHordeJob(payload);
    return await pollHordeTask(responseJson.id, signal, reportProgress);
}

/**
 * Real raw-action version of generateHorde() - see src/endpoints/horde.js's own
 * `buildRawActionHordePayload()` doc comment for the full architecture investigation this required.
 * Unlike every other raw-action-eligible backend (kobold/novel/textgenerationwebui), Horde's
 * generation genuinely cannot collapse into one blocking server request - pollHordeTask() above
 * already proves this: a real, unavoidable client-side wait of up to 20 minutes, with live
 * signal-driven abort/cancellation only the client can perform. So raw action here only changes WHAT
 * gets submitted (the server resolves/assembles the whole prompt+params itself, from the real
 * character/chat/node identity - `rawAction`'s own character_avatar/group_id/owner_id/node_id/type/
 * user_message fields (there is no `branch_name` field, and is_impersonate/is_continue/is_swipe are
 * derived server-side from `type` alone), the EXACT same shape public/script.js's own
 * `rawActionGenerateData` already builds for kobold/novel/textgenerationwebui)
 * - the submit-then-poll-then-report mechanics are UNCHANGED, reusing submitHordeJob()/
 * pollHordeTask() rather than duplicating them.
 *
 * Persistence: the user's raw action is persisted SERVER-SIDE, immediately, by the real
 * `/api/horde/generate-text` route itself (see that route's own doc comment) - matching every other
 * raw-action backend's "persist regardless of outcome" principle, since a Horde job can time out/
 * fault/get aborted after up to 20 minutes with nothing else to fall back on. The ASSISTANT's reply,
 * though, can only be known once THIS function's own pollHordeTask() call resolves - so it's
 * persisted here, client-side, via persistHordeRawActionReply() below, once the real final text is
 * in hand. `responseJson.raw_action_persist` (attached by the route only when persistence should
 * happen - `null`/absent for impersonate/quiet types or the continue/user-text-conflict edge case) is
 * exactly what that needs; nothing is persisted when it's absent.
 * @param {object} rawAction Same shape as public/script.js's own `rawActionGenerateData`.
 * @param {AbortSignal} signal
 * @param {boolean} reportProgress
 * @returns {Promise<{text: string, workerName: string, assistant_node_id?: string}>} `assistant_node_id`
 * is set exactly like src/endpoints/backends/kobold.js's own non-streaming raw-action response field
 * of the same name - present only once persistence actually landed on a real node, so
 * `public/script.js`'s `_stampAssistantNodeId(data.assistant_node_id)` can stamp the local `chat[]`
 * entry `saveReply()` already created with the REAL server-side node id and mark it clean, instead of
 * that local entry being left provisional and separately (redundantly) persisted again by the
 * generic autosave path.
 */
export async function generateHordeRawAction(rawAction, signal, reportProgress) {
    validateHordeModel();

    const payload = {
        ...rawAction,
        trusted_workers: horde_settings.trusted_workers_only,
        models: horde_settings.models,
    };

    const responseJson = await submitHordeJob(payload);
    const result = await pollHordeTask(responseJson.id, signal, reportProgress);

    if (responseJson.raw_action_persist && result.text) {
        const assistantNodeId = await persistHordeRawActionReply(rawAction, responseJson.raw_action_persist, result.text);
        if (assistantNodeId) {
            result.assistant_node_id = assistantNodeId;
        }
    }

    return result;
}

/**
 * Async-generator counterpart of generateHordeRawAction(), yielding the same
 * `{text, swipes, logprobs, toolCalls, state}` shape every other backend's streaming generator
 * (e.g. `generateKoboldWithStreaming()`) yields, so a caller using the generic streaming-consumption
 * path could drive Horde too instead of the dedicated Promise-returning call above.
 *
 * NOT currently wired into public/script.js's call site - kept purely additive. Verified via grep
 * before making that call: `main_api === 'koboldhorde'` is hardcoded as a non-streaming backend in
 * several places `isStreamingEnabled()` and its callers check (script.js, ~line 6349/8752, "Horde is
 * never streamed at all"), and the actual consumer of a `streamData()`-shaped generator is
 * `StreamingProcessor` (script.js), which assumes real incremental content, abort semantics, and
 * tool-call bookkeeping tuned for backends that genuinely stream tokens - none of which apply to a
 * submit-then-poll job that only ever produces one, complete, final string. Routing Horde through
 * that machinery would mean adding a real `isStreamingEnabled()` branch and auditing
 * `StreamingProcessor` end to end for a backend it was never designed around - a materially larger,
 * riskier change than "close a client-side consistency gap", so it's deliberately not done in this
 * pass. This export exists so a future pipeline unification effort has a real, tested generator to
 * build on without having to write it from scratch.
 * @param {object} rawAction Same shape as generateHordeRawAction()'s own `rawAction`.
 * @param {AbortSignal} signal
 * @returns {AsyncGenerator<{text: string, swipes: string[], logprobs: null, toolCalls: any[], state: {progress: number, assistantNodeId?: string, workerName?: string}}, void, void>}
 */
export async function* generateHordeRawActionStream(rawAction, signal) {
    validateHordeModel();

    const payload = {
        ...rawAction,
        trusted_workers: horde_settings.trusted_workers_only,
        models: horde_settings.models,
    };

    const responseJson = await submitHordeJob(payload);
    const generator = pollHordeTaskGenerator(responseJson.id, signal);

    let step = await generator.next();
    while (!step.done) {
        yield { text: '', swipes: [], logprobs: null, toolCalls: [], state: { progress: step.value } };
        step = await generator.next();
    }
    const result = step.value;

    // Same "why not chatOpAppend() et al." reasoning as generateHordeRawAction() above -
    // persistHordeRawActionReply() addresses the real owner/anchor directly, independent of whatever
    // chat happens to be open once this resolves.
    let assistantNodeId;
    if (responseJson.raw_action_persist && result.text) {
        assistantNodeId = await persistHordeRawActionReply(rawAction, responseJson.raw_action_persist, result.text) ?? undefined;
    }

    yield { text: result.text, swipes: [], logprobs: null, toolCalls: [], state: { progress: 100, assistantNodeId, workerName: result.workerName } };
}

/**
 * Posts one tree-mutation call with the SAME retry-on-transient-failure policy chat-store.js's own
 * `chatOp*()` functions get from `_chatOpPost()` (`retryTransient()`, its exported form) - a network
 * blip or a 5xx during this call is retried with backoff instead of silently dropping up to 20
 * minutes of a real Horde generation; a 4xx (a genuine refusal) is thrown immediately, same as
 * `_chatOpPost()`.
 * @param {string} path
 * @param {object} body
 * @returns {Promise<any>} Parsed JSON body (`{}` if the response has none).
 */
async function postHordePersist(path, body) {
    return retryTransient(async () => {
        const response = await fetch(path, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const error = new Error(`${path} responded ${response.status}`);
            error.status = response.status;
            throw error;
        }
        return response.json().catch(() => ({}));
    });
}

/**
 * Persists a raw-action Horde reply onto the message tree, once pollHordeTask() has resolved with
 * the real final text - see generateHordeRawAction()'s own doc comment for why this can't happen
 * server-side. Deliberately reuses the EXISTING, already-idempotent-by-content-identity generic
 * tree-mutation endpoints (src/endpoints/chats.js's `/message/append`, `/message/alternative` +
 * `/message/select`, `/message/edit`) instead of a new dedicated persistence endpoint - the client's
 * own natural post-generation save flow (public/scripts/chat-store.js) already calls these same
 * endpoints for every other backend's own reply, so this is not new surface area, just an earlier,
 * explicit, guaranteed call to it.
 *
 * JUDGMENT CALL: this deliberately does NOT call `chatOpEdit()`/`chatOpAddAlternative()`/
 * `chatOpAppend()` directly, even though those now share the exact same retry policy via
 * `retryTransient()` above. Every `chatOp*()` function reads/writes the CURRENTLY loaded `chat[]`
 * array and always posts `getCurrentCharacter()`'s avatar as the owner (see `_chatOpPost()`) - correct
 * for a normal reply, but Horde's own poll loop (`pollHordeTask()`) can legitimately take up to
 * ~20 minutes (`MAX_RETRIES * CHECK_INTERVAL`), and the user is free to switch to a different
 * character/chat at any point during that wait. Using `chatOp*()` here would then silently persist
 * this reply onto whatever chat happens to be open when the job finishes - not `rawAction`'s own real
 * owner - which is a correctness bug, not a style issue. `rawAction.character_avatar`/`.group_id` and
 * `persist.anchorNodeId` name the real target directly, independent of whatever the client's local
 * `chat[]`/`getCurrentCharacter()` currently point at, exactly like every other raw-action backend's
 * OWN server-side persistence does.
 *
 * Mirrors src/assistant-reply-persist.js's `persistAssistantReply()` exact three-mode branching
 * (continue/swipe/plain), verbatim, just issued as three real HTTP calls instead of three real
 * message-tree-db.js calls.
 * @param {object} rawAction The same object passed to generateHordeRawAction() - only
 * `character_avatar`/`group_id` are read here (to address the same owner the server itself used).
 * @param {object} persist `responseJson.raw_action_persist` - `{anchorNodeId, name2, isSwipe, isContinue, anchorContent}`.
 * @param {string} generatedText The real, final generated text.
 * @returns {Promise<string | null>} The node id the reply actually landed on (the edited anchor for
 * continue, the new alternative for swipe, the newly appended node for plain), or `null` if
 * persistence failed - see generateHordeRawAction()'s own doc comment for how this is used.
 */
async function persistHordeRawActionReply(rawAction, persist, generatedText) {
    const owner = rawAction.group_id ? { group_id: rawAction.group_id } : { avatar_url: rawAction.character_avatar };
    const replyContent = { name: persist.name2, is_user: false, mes: generatedText, extra: {}, send_date: Date.now() };

    try {
        if (persist.isContinue) {
            if (!persist.anchorContent) {
                console.error('Failed to persist Horde raw-action continue edit: no anchor content resolved.');
                return null;
            }
            const oldText = typeof persist.anchorContent.mes === 'string' ? persist.anchorContent.mes : '';
            await postHordePersist('/api/chats/message/edit', { ...owner, node_id: persist.anchorNodeId, content: { ...persist.anchorContent, mes: oldText + generatedText } });
            return persist.anchorNodeId;
        } else if (persist.isSwipe) {
            const created = await postHordePersist('/api/chats/message/alternative', { ...owner, sibling_node_id: persist.anchorNodeId, contents: [replyContent] });
            const newNodeId = created?.node_ids?.[0];
            if (!newNodeId) {
                console.error('Failed to persist Horde raw-action swipe alternative - no new node id was returned.');
                return null;
            }
            await postHordePersist('/api/chats/message/select', { ...owner, node_id: newNodeId });
            return newNodeId;
        } else {
            const created = await postHordePersist('/api/chats/message/append', { ...owner, after_node_id: persist.anchorNodeId, messages: [replyContent] });
            const newNodeId = created?.node_ids?.[0];
            if (!newNodeId) {
                console.error('Failed to persist Horde raw-action reply - no new node id was returned from append.');
                return null;
            }
            return newNodeId;
        }
    } catch (error) {
        console.error('Failed to persist Horde raw-action assistant reply onto the tree:', error);
        return null;
    }
}


export async function getHordeModels(force) {
    const sortByPerformance = (a, b) => b.performance - a.performance;
    const sortByWhitelisted = (a, b) => b.is_whitelisted - a.is_whitelisted;
    const sortByPopular = (a, b) => b.tags?.includes('popular') - a.tags?.includes('popular');

    $('#horde_model').empty();
    models = (await getModels(force)).sort((a, b) => {
        return sortByWhitelisted(a, b) || sortByPopular(a, b) || sortByPerformance(a, b);
    });
    for (const model of models) {
        const option = document.createElement('option');
        option.value = model.name;
        option.innerText = hordeModelTextString(model);
        option.selected = horde_settings.models.includes(model.name);
        $('#horde_model').append(option);
    }

    // if previously selected is no longer available
    if (horde_settings.models.length && models.filter(m => horde_settings.models.includes(m.name)).length === 0) {
        horde_settings.models = [];
    }

    setContextSizePreview();
}

export function loadHordeSettings(settings) {
    if (settings.horde_settings) {
        Object.assign(horde_settings, settings.horde_settings);
    }

    $('#horde_auto_adjust_response_length').prop('checked', horde_settings.auto_adjust_response_length);
    $('#horde_auto_adjust_context_length').prop('checked', horde_settings.auto_adjust_context_length);
    $('#horde_trusted_workers_only').prop('checked', horde_settings.trusted_workers_only);
}

async function showKudos() {
    const response = await fetch('/api/horde/user-info', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
    });

    if (!response.ok) {
        toastr.warning('Could not load user info from Horde. Please try again later.');
        return;
    }

    const data = await response.json();

    if (data.anonymous) {
        toastr.info('You are in anonymous mode. Set your personal Horde API key to see kudos.');
        return;
    }

    console.log('Horde user data', data.user, 'shared key data', data.sharedKey);
    const kudos = data.sharedKey?.kudos ?? data.user?.kudos ?? 0;
    toastr.info(`Kudos: ${kudos}`, data.user.username);
}

function hordeModelTextString(model) {
    const q = hordeModelQueueStateString(model);
    return `${model.name} (${q})`;
}

function hordeModelQueueStateString(model) {
    return `ETA: ${model.eta}s, Speed: ${model.performance}, Queue: ${model.queued}, Workers: ${model.count}`;
}

export function isHordeGenerationNotAllowed() {
    if (main_api == 'koboldhorde' && kai_settings.preset_settings == 'gui') {
        toastr.error(t`GUI Settings preset is not supported for Horde. Please select another preset.`);
        return true;
    }

    return false;
}

function getHordeModelTemplate(option) {
    const model = models.find(x => x.name === option?.element?.value);

    if (!option.id || !model) {
        return option.text;
    }

    const strip = html => {
        const tmp = document.createElement('DIV');
        tmp.innerHTML = html || '';
        return tmp.textContent || tmp.innerText || '';
    };

    // how much do we trust the metadata from the models repo? about this much
    const displayName = strip(model.display_name || model.name).replace(/.*\//g, '');
    const description = strip(model.description);
    const tags = model.tags ? model.tags.map(strip) : [];
    const url = strip(model.url);
    const style = strip(model.style);

    const workerInfo = hordeModelQueueStateString(model);
    const isPopular = model.tags?.includes('popular');
    const descriptionDiv = description ? `<div class="horde-model-description">${description}</div>` : '';
    const tagSpans = tags.length > 0 &&
        `${tags.map(tag => `<span class="tag tag_name">${tag}</span>`).join('')}</span>` || '';

    const modelDetailsLink = url && `<a href="${url}" target="_blank" rel="noopener noreferrer" class="model-details-link fa-solid fa-circle-question"> </a>`;
    const capitalize = s => s ? s[0].toUpperCase() + s.slice(1) : '';
    const innerContent = [
        `<strong>${displayName}</strong> ${modelDetailsLink}`,
        style ? `${capitalize(style)}` : '',
        tagSpans ? `<span class="tags tags_inline inline-flex margin-r2">${tagSpans}</span>` : '',
    ].filter(Boolean).join(' | ');

    return $((`
        <div class="flex-container flexFlowColumn">
            <div>
                ${isPopular ? '<span class="fa-fw fa-solid fa-star" title="Popular"></span>' : ''}
                ${innerContent}
            </div>
            ${descriptionDiv}
            <div><small>${workerInfo}</small></div>
        </div>
    `));
}

export function initHorde() {
    $('#horde_model').on('mousedown change', async function (e) {
        const modelValue = $('#horde_model').val();
        horde_settings.models = Array.isArray(modelValue) ? modelValue : [];
        console.log('Updated Horde models', horde_settings.models);

        autoSelectInstructPreset(horde_settings.models.join(' '));
        if (horde_settings.models.length) {
            adjustHordeGenerationParams(max_context, amount_gen);
        } else {
            $('#adjustedHordeParams').text(t`Context` + ': --, ' + t`Response` + ': --');
        }

        saveSettingsDebounced('horde_settings');
    });

    $('#horde_auto_adjust_response_length').on('input', function () {
        horde_settings.auto_adjust_response_length = !!$(this).prop('checked');
        setContextSizePreview();
        saveSettingsDebounced('horde_settings');
    });

    $('#horde_auto_adjust_context_length').on('input', function () {
        horde_settings.auto_adjust_context_length = !!$(this).prop('checked');
        setContextSizePreview();
        saveSettingsDebounced('horde_settings');
    });

    $('#horde_trusted_workers_only').on('input', function () {
        horde_settings.trusted_workers_only = !!$(this).prop('checked');
        setContextSizePreview();
        saveSettingsDebounced('horde_settings');
    });

    $('#horde_api_key_button').on('click', async function () {
        const key = String($('#horde_api_key').val()).trim();
        if (!key) {
            toastr.warning(t`Please enter your Horde API key`);
            return;
        }
        await writeSecret(SECRET_KEYS.HORDE, key);
    });

    $('#horde_refresh').on('click', () => getHordeModels(true));
    $('#horde_kudos').on('click', showKudos);

    // Not needed on mobile
    if (!isMobile()) {
        $('#horde_model').select2({
            width: '100%',
            placeholder: t`Select Horde models`,
            allowClear: true,
            closeOnSelect: false,
            templateSelection: function (data) {
                // Customize the pillbox text by shortening the full text
                return data.id;
            },
            templateResult: getHordeModelTemplate,
        });
    }
}

