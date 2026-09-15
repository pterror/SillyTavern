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
import { isMobile } from './RossAscends-mods.js';
import { autoSelectInstructPreset } from './instruct-mode.js';
import { t } from './i18n.js';
import { kai_settings } from './kai-settings.js';
import { CompactStreamDecoder, ResumableCompactStreamReader } from './llamacpp-compact-stream.js';

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
 * Starts one Horde job by POSTing to `/api/horde/generate-text` and returns the raw fetch `Response`
 * once the server has switched into compact-v1 stream mode - the server itself now submits to Horde
 * and polls it internally (src/endpoints/horde.js's `streamHordeGeneration()`), so the client's job
 * here is just to hold the connection open and decode what comes back, exactly like every other
 * backend's streaming path.
 *
 * A non-streaming JSON response means the route rejected the request before ever reaching Horde (a
 * validation failure, or a submission-time error) - surfaced here as a thrown, toastr'd error, same
 * as before.
 * @param {object} payload The real `/api/horde/generate-text` request body.
 * @returns {Promise<Response>}
 */
async function startHordeStream(payload, signal) {
    const response = await fetch('/api/horde/generate-text', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(payload),
        signal,
    });

    if (response.headers.get('X-ST-Stream-Format') === 'compact-v1') {
        return response;
    }

    const responseJson = await response.json().catch(() => ({}));
    const reason = responseJson.error?.message || responseJson.message || response.statusText || 'Unknown error';
    toastr.error(reason, 'Horde generation failed');
    throw new Error(`Horde generation failed: ${reason}`);
}

/**
 * Reads a `startHordeStream()` response to completion via `ResumableCompactStreamReader` (real
 * keepalive/resume support, matching every other raw-action stream) and returns the same
 * `{text, workerName, assistantNodeId}` shape `generateHorde()`/`generateHordeRawAction()` need.
 *
 * Horde's own per-job queue-position telemetry no longer reaches the client (the compact-v1 wire
 * format carries content/control/keepalive frames, not a Horde-specific progress percentage) - so
 * `reportProgress` here can only mark the generation as started (0%) and finished (100%), not the
 * fine-grained queue-position estimate `pollHordeTaskGenerator()` used to compute. This is a real,
 * narrow, honest loss of precision from moving polling server-side, not a disguised regression: the
 * progress bar still appears and still completes, it just can't show intermediate movement anymore.
 * @param {Response} response
 * @param {AbortSignal} signal
 * @param {boolean} reportProgress
 * @returns {Promise<{text: string, workerName?: string, assistantNodeId?: string}>}
 */
async function consumeHordeStream(response, signal, reportProgress) {
    const generationId = response.headers.get('X-Generation-Id');
    const reader = new ResumableCompactStreamReader(response, '/api/horde/generate/resume', getRequestHeaders);
    const decoder = new CompactStreamDecoder();
    let text = '';
    let assistantNodeId;
    let workerName;

    if (reportProgress) setGenerationProgress(0);

    const onAbort = () => { if (generationId) cancelTask(generationId); };
    signal.addEventListener('abort', onAbort, { once: true });

    try {
        for (; ;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value?.length) continue;
            for (const event of decoder.push(value)) {
                if ('content' in event) {
                    text += event.content;
                } else if ('assistantNodeId' in event) {
                    assistantNodeId = event.assistantNodeId;
                } else if ('control' in event && event.control?.worker_name) {
                    workerName = `Generated by Horde worker: ${event.control.worker_name} [${event.control.model}]`;
                }
            }
        }
        for (const event of decoder.flush()) {
            if ('content' in event) text += event.content;
        }
    } finally {
        signal.removeEventListener('abort', onAbort);
    }

    if (reportProgress) setGenerationProgress(100);

    return { text, workerName, assistantNodeId };
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

    const response = await startHordeStream(payload, signal);
    return await consumeHordeStream(response, signal, reportProgress);
}

/**
 * Real raw-action version of generateHorde(). The server (src/endpoints/horde.js's
 * `streamHordeGeneration()`) now submits the job to Horde, polls it internally, and - for a
 * persistable raw-action request - persists the assistant's reply server-side via
 * `persistAssistantReply()` for real, exactly like every other backend, emitting an
 * `assistant_node_id` frame once that lands. There is no client-side persistence call anymore.
 * @param {object} rawAction Same shape as public/script.js's own `rawActionGenerateData`.
 * @param {AbortSignal} signal
 * @param {boolean} reportProgress
 * @returns {Promise<{text: string, workerName?: string, assistant_node_id?: string}>} `assistant_node_id`
 * is set exactly like src/endpoints/backends/kobold.js's own non-streaming raw-action response field
 * of the same name - present only once persistence actually landed on a real node, so
 * `public/script.js`'s `_stampAssistantNodeId(data.assistant_node_id)` can stamp the local `chat[]`
 * entry `saveReply()` already created with the REAL server-side node id and mark it clean.
 */
export async function generateHordeRawAction(rawAction, signal, reportProgress) {
    validateHordeModel();

    const payload = {
        ...rawAction,
        trusted_workers: horde_settings.trusted_workers_only,
        models: horde_settings.models,
    };

    const response = await startHordeStream(payload, signal);
    const result = await consumeHordeStream(response, signal, reportProgress);

    return {
        text: result.text,
        workerName: result.workerName,
        ...(result.assistantNodeId ? { assistant_node_id: result.assistantNodeId } : {}),
    };
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

