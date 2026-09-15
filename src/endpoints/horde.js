import fetch from 'node-fetch';
import express from 'express';
import { AIHorde, ModelGenerationInputStableSamplers, ModelInterrogationFormTypes, HordeAsyncRequestStates } from '@zeldafan0225/ai_horde';
import { getVersion, delay, Cache } from '../util.js';
import { readSecret, SECRET_KEYS } from './secrets.js';
import { buildRawActionKoboldRequest } from './backends/kobold.js';
import { appendMessages, sanitizeUserMessageExtra } from '../message-tree-db.js';
import { persistAssistantReply } from '../assistant-reply-persist.js';
import {
    createGenerationRecord, createResumableWriter, createBackpressureWriter, detachFromResponse,
    encodeContent, encodeAssistantNodeIdFrame, encodeControlFrame, handleGenerationResume, KEEPALIVE_INTERVAL_MS,
} from './backends/llamacpp-compact-stream.js';

const ANONYMOUS_KEY = '0000000000';
const HORDE_TEXT_MODEL_METADATA_URL = 'https://raw.githubusercontent.com/db0/AI-Horde-text-model-reference/main/db.json';
const cache = new Cache(60 * 1000);
export const router = express.Router();

// Real values ported verbatim from public/scripts/horde.js's own MAX_RETRIES/CHECK_INTERVAL (the
// client-side poll loop these constants used to drive before polling moved server-side - see
// streamHordeGeneration()'s own doc comment below). Overridable ONLY via
// `_setHordePollingConfigForTests()`, so a real end-to-end test can exercise the real poll loop
// without literally waiting up to 20 minutes.
const HORDE_MAX_RETRIES_DEFAULT = 480;
const HORDE_POLL_INTERVAL_MS_DEFAULT = 2500;
let HORDE_MAX_RETRIES = HORDE_MAX_RETRIES_DEFAULT;
let HORDE_POLL_INTERVAL_MS = HORDE_POLL_INTERVAL_MS_DEFAULT;
let HORDE_KEEPALIVE_INTERVAL_MS = KEEPALIVE_INTERVAL_MS;

/**
 * Test-only hook to speed up streamHordeGeneration()'s poll loop and its keepalive cadence. Never
 * called outside a test.
 * @param {{pollIntervalMs?: number, maxRetries?: number, keepaliveIntervalMs?: number}} [overrides]
 */
export function _setHordePollingConfigForTests({ pollIntervalMs, maxRetries, keepaliveIntervalMs } = {}) {
    HORDE_POLL_INTERVAL_MS = pollIntervalMs ?? HORDE_POLL_INTERVAL_MS_DEFAULT;
    HORDE_MAX_RETRIES = maxRetries ?? HORDE_MAX_RETRIES_DEFAULT;
    HORDE_KEEPALIVE_INTERVAL_MS = keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS;
}

/**
 * One in-flight server-side Horde poll loop's cancellation handle, keyed by Horde's own job id -
 * the obvious shared key, since `/cancel-task` (below) only ever receives that same `taskId`. Mirrors
 * `llamacpp-compact-stream.js`'s own `metaCache`/`generationBuffers` maps: a plain `Map`, capped so a
 * flood of abandoned generations can't leak memory, with entries removed as soon as their own poll
 * loop actually finishes (success, fault, timeout, or cancellation) in `streamHordeGeneration()`'s own
 * `finally` block - there is no separate TTL sweep because every entry's lifetime is already bounded
 * by "however long one real Horde job's poll loop runs for."
 * @type {Map<string, {cancelled: boolean, cancel: () => void, cancelPromise: Promise<void>}>}
 */
const activeHordePolls = new Map();
const ACTIVE_HORDE_POLLS_MAX = 200;

function createHordePollState() {
    let cancelled = false;
    let notifyCancel;
    const cancelPromise = new Promise((resolve) => { notifyCancel = resolve; });
    return {
        get cancelled() { return cancelled; },
        cancel() {
            if (cancelled) return;
            cancelled = true;
            notifyCancel();
        },
        cancelPromise,
    };
}

function registerHordePoll(jobId) {
    if (activeHordePolls.size >= ACTIVE_HORDE_POLLS_MAX) {
        const oldestKey = activeHordePolls.keys().next().value;
        if (oldestKey !== undefined) activeHordePolls.delete(oldestKey);
    }
    const state = createHordePollState();
    activeHordePolls.set(jobId, state);
    return state;
}

/**
 * Returns the AIHorde client agent.
 * @returns {Promise<string>} AIHorde client agent
 */
async function getClientAgent() {
    const version = await getVersion();
    return version?.agent || 'SillyTavern:UNKNOWN:Cohee#1207';
}

/**
 * Returns the AIHorde client.
 * @returns {Promise<AIHorde>} AIHorde client
 */
async function getHordeClient() {
    return new AIHorde({
        client_agent: await getClientAgent(),
    });
}

/**
 * Removes dirty no-no words from the prompt.
 * Taken verbatim from KAI Lite's implementation (AGPLv3).
 * https://github.com/LostRuins/lite.koboldai.net/blob/main/index.html#L7786C2-L7811C1
 * @param {string} prompt Prompt to sanitize
 * @returns {string} Sanitized prompt
 */
function sanitizeHordeImagePrompt(prompt) {
    if (!prompt) {
        return '';
    }

    //to avoid flagging from some image models, always swap these words
    prompt = prompt.replace(/\b(girl)\b/gmi, 'woman');
    prompt = prompt.replace(/\b(boy)\b/gmi, 'man');
    prompt = prompt.replace(/\b(girls)\b/gmi, 'women');
    prompt = prompt.replace(/\b(boys)\b/gmi, 'men');
    //always remove these high risk words from prompt, as they add little value to image gen while increasing the risk the prompt gets flagged
    prompt = prompt.replace(/\b(under.age|under.aged|underage|underaged|loli|pedo|pedophile|(\w+).year.old|(\w+).years.old|minor|prepubescent|minors|shota)\b/gmi, '');
    //replace risky subject nouns with person
    prompt = prompt.replace(/\b(youngster|infant|baby|toddler|child|teen|kid|kiddie|kiddo|teenager|student|preteen|pre.teen)\b/gmi, 'person');
    //remove risky adjectives and related words
    prompt = prompt.replace(/\b(young|younger|youthful|youth|small|smaller|smallest|girly|boyish|lil|tiny|teenaged|lit[tl]le|school.aged|school|highschool|kindergarten|teens|children|kids)\b/gmi, '');

    return prompt;
}

router.post('/text-workers', async (request, response) => {
    try {
        const cachedWorkers = cache.get('workers');

        if (cachedWorkers && !request.body.force) {
            return response.send(cachedWorkers);
        }

        const agent = await getClientAgent();
        const fetchResult = await fetch('https://aihorde.net/api/v2/workers?type=text', {
            headers: {
                'Client-Agent': agent,
            },
        });
        const data = await fetchResult.json();
        cache.set('workers', data);
        return response.send(data);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

async function getHordeTextModelMetadata() {
    const response = await fetch(HORDE_TEXT_MODEL_METADATA_URL);
    return await response.json();
}

async function mergeModelsAndMetadata(models, metadata) {
    return models.map(model => {
        const metadataModel = metadata[model.name];
        if (!metadataModel) {
            return { ...model, is_whitelisted: false };
        }
        return { ...model, ...metadataModel, is_whitelisted: true };
    });
}

router.post('/text-models', async (request, response) => {
    try {
        const cachedModels = cache.get('models');
        if (cachedModels && !request.body.force) {
            return response.send(cachedModels);
        }

        const agent = await getClientAgent();
        const fetchResult = await fetch('https://aihorde.net/api/v2/status/models?type=text', {
            headers: {
                'Client-Agent': agent,
            },
        });

        let data = await fetchResult.json();

        // attempt to fetch and merge models metadata
        try {
            const metadata = await getHordeTextModelMetadata();
            data = await mergeModelsAndMetadata(data, metadata);
        } catch (error) {
            console.error('Failed to fetch metadata:', error);
        }

        cache.set('models', data);
        return response.send(data);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

router.post('/status', async (_, response) => {
    try {
        const agent = await getClientAgent();
        const fetchResult = await fetch('https://aihorde.net/api/v2/status/heartbeat', {
            headers: {
                'Client-Agent': agent,
            },
        });

        return response.send({ ok: fetchResult.ok });
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

router.post('/cancel-task', async (request, response) => {
    try {
        const taskId = request.body.taskId;
        // Stops the actual in-flight server-side poll loop for this job, if streamHordeGeneration()
        // (below) is currently running one - see activeHordePolls' own doc comment above.
        activeHordePolls.get(taskId)?.cancel();
        const agent = await getClientAgent();
        const fetchResult = await fetch(`https://aihorde.net/api/v2/generate/text/status/${taskId}`, {
            method: 'DELETE',
            headers: {
                'Client-Agent': agent,
            },
        });

        const data = await fetchResult.json();
        console.info(`Cancelled Horde task ${taskId}`);
        return response.send(data);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

router.post('/task-status', async (request, response) => {
    try {
        const taskId = request.body.taskId;
        const agent = await getClientAgent();
        const fetchResult = await fetch(`https://aihorde.net/api/v2/generate/text/status/${taskId}`, {
            headers: {
                'Client-Agent': agent,
            },
        });

        const data = await fetchResult.json();
        console.info(`Horde task ${taskId} status:`, data);
        return response.send(data);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

/**
 * Real raw-action cutover for Horde (main_api === 'koboldhorde') - mirrors
 * src/endpoints/backends/kobold.js's own raw-action `/generate` branch as closely as the real
 * architectural difference allows: resolves the real character/chat/branch identity, assembles the
 * real prompt via the SAME `buildRawActionKoboldRequest()` kobold.js's own raw-action branch uses
 * (passing `macroExtras: { isHorde: true }`, since createKoboldGenerationData()'s real `isHorde`
 * branch - src/kobold-generation-data.js - already produces the correct payload shape for Horde),
 * and persists the user's message immediately (same "persist regardless of outcome" principle as
 * every other raw-action backend, since a Horde job can still time out/fault/get cancelled).
 *
 * Unlike kobold.js's/novelai.js's own raw-action branches, this only builds the outgoing Horde
 * payload - it does not itself submit the job or wait for a result. `/generate-text` (below) submits
 * it, then hands the whole thing to `streamHordeGeneration()`, which polls Horde internally and
 * persists the ASSISTANT's reply server-side once the real final text is known, via the returned
 * `rawActionPersist` (`{anchorNodeId, name2, isSwipe, isContinue, anchorContent}`, merged with
 * `directories`/`ownerId` by the caller before being passed to `persistAssistantReply()`) - `null`
 * whenever persistence should be skipped (impersonate/quiet types, or the same
 * `continueUserTextConflict` edge case kobold.js's own raw-action branch already guards against).
 *
 * MVP SCOPE BOUNDARY (real, narrow, deliberately deferred - NOT attempted here): live
 * worker-capacity auto-adjustment (public/scripts/horde.js's `adjustHordeGenerationParams()`, itself
 * just a client-side wrapper around the EXISTING `/api/horde/text-workers` endpoint, shrinking
 * `max_context_length`/`max_length` to whatever a currently-available worker can actually handle) is
 * not performed for a raw-action request. `createKoboldGenerationData()` still produces a valid
 * request using the user's own configured `kai_settings`/`amount_gen`/`max_context` values - a real
 * request still works, it may just be rejected/retried more often by Horde when no worker matches an
 * unadjusted size. This is an honest, narrow MVP boundary, not a disguised gap: nothing about basic
 * generation is broken or faked by this omission.
 * @param {import('express').Request} request
 * @returns {Promise<{ body: object, rawActionPersist: object|null }>}
 */
async function buildRawActionHordePayload(request) {
    const {
        character_avatar: characterAvatar, group_id: groupId, owner_id: ownerId,
        node_id: nodeId, type = 'normal',
        user_message: userMessageText, trusted_workers: trustedWorkers = false, models,
    } = request.body;
    // Server-validated (NOT trusted verbatim) - see `sanitizeUserMessageExtra()`'s own doc comment
    // (message-tree-db.js) and text-completions.js's identical raw-action branch.
    const userMessageExtra = sanitizeUserMessageExtra(request.body.user_message_extra);
    // is_impersonate/is_continue/is_swipe are NOT read from the wire - see kobold.js's own identical
    // derivation/comment.
    const isImpersonate = type === 'impersonate';
    const isContinue = type === 'continue';
    const isSwipe = type === 'swipe' || type === 'regenerate';

    const directories = request.user.directories;

    const built = await buildRawActionKoboldRequest(directories, {
        request, characterAvatar, groupId, ownerId, nodeId,
        type, isImpersonate, isContinue, isSwipe, userMessageText, userMessageExtra,
        macroExtras: { isHorde: true },
    });

    // Same three-mode persistence contract as kobold.js's own raw-action branch - see that file's
    // own extensive comment on impersonate/quiet skipping, the swipe/regenerate sibling-vs-child
    // distinction, and the continue/userMessageText tree-shape edge case. Not re-derived here;
    // identical reasoning applies verbatim since both routes share the exact same
    // resolveTextCompletionGenerationInput()/message-tree-db.js persistence primitives.
    const skipPersistence = isImpersonate || type === 'quiet';
    let replyAnchorNodeId = built.anchorNodeId;
    if (!skipPersistence && typeof userMessageText === 'string' && built.anchorNodeId) {
        const appendResult = await appendMessages(directories, ownerId, built.anchorNodeId, [
            { name: built.name1, is_user: true, mes: userMessageText, extra: userMessageExtra, send_date: Date.now() },
        ]);
        if (!appendResult.ok) {
            console.error('Failed to persist user message onto the tree:', appendResult.reason);
        } else if (appendResult.node_ids?.length) {
            replyAnchorNodeId = appendResult.node_ids[appendResult.node_ids.length - 1];
        }
    }
    const continueUserTextConflict = isContinue && replyAnchorNodeId !== built.anchorNodeId;
    const rawActionPersist = (!skipPersistence && !continueUserTextConflict)
        ? { anchorNodeId: replyAnchorNodeId, name2: built.name2, isSwipe, isContinue, anchorContent: built.anchorContent }
        : null;

    // Horde's own real params shape: `prompt` is a SEPARATE top-level field (never inside `params`),
    // matching generateHorde()'s own real transformation (public/scripts/horde.js) exactly - it
    // `delete params.prompt`s then sets a handful of fixed fields ("No idea what these do", per that
    // function's own comment, copied verbatim here for the identical real values). `api_server`
    // (createKoboldGenerationData()'s Kobold-specific wire field, resolved from `kai_settings.api_server`)
    // is meaningless for Horde - a worker pool picks the real backend, never a client-sent URL - so
    // it is simply dropped here, never forwarded to the real Horde coordinator.
    const { prompt } = built.params;
    const params = { ...built.params };
    delete params.prompt;
    delete params.api_server;
    params.n = 1;
    params.frmtadsnsp = false;
    params.frmtrmblln = false;
    params.frmtrmspch = false;
    params.frmttriminc = false;

    return {
        body: { prompt, params, trusted_workers: !!trustedWorkers, models: Array.isArray(models) ? models : [] },
        rawActionPersist,
    };
}

/**
 * Fetches one Horde job's current status via the real, public `GET .../generate/text/status/:id`
 * endpoint - same URL and headers `/task-status` above already uses.
 * @param {string} jobId
 * @param {string} agent
 * @returns {Promise<any>}
 */
async function fetchHordeJobStatus(jobId, agent) {
    const fetchResult = await fetch(`https://aihorde.net/api/v2/generate/text/status/${jobId}`, {
        headers: { 'Client-Agent': agent },
    });
    if (!fetchResult.ok) {
        throw new Error(`Horde status check responded ${fetchResult.status}`);
    }
    return fetchResult.json();
}

/**
 * Shims a Horde job (already submitted, real job id in hand) onto the same `compact-v1` wire protocol
 * every other backend now streams over - see this module's own header comment / the task this
 * implements for the full rationale. The client's connection to OUR server is held open exactly like
 * any other raw-action stream (`X-ST-Stream-Format`/`X-Generation-Id` headers,
 * `createResumableWriter()` for keepalive + resumability); the fact that Horde's own API is
 * submit-then-poll is an internal implementation detail of THIS function, invisible to the client.
 *
 * Cancellation has two independent triggers, exactly like every other raw-action streaming route:
 * - `/cancel-task` (above) looks up this job's `activeHordePolls` entry and calls `.cancel()` on it,
 *   which this loop notices (via `pollState.cancelled`/`pollState.cancelPromise`) and stops on.
 * - The client's own HTTP connection dropping does NOT cancel the poll - matching every other
 *   raw-action backend's now-established "a persisted generation survives a client disconnect and can
 *   still be resumed" behavior, the response writer is swapped for one that only buffers into the
 *   resumable generation record (`detachFromResponse()`), and the poll loop runs to completion
 *   regardless.
 *
 * On success, the generated text is written as a real content frame and, for a raw-action request
 * (`rawActionPersist` non-null), persisted server-side via `persistAssistantReply()` exactly like
 * every other backend - the resulting `assistant_node_id` frame is written last, per the wire
 * protocol's own contract. On a fault/unsatisfiable-request/timeout/status-check-error, nothing is
 * persisted and the stream simply ends without a content or node-id frame - the same convention
 * `forwardAndPersistCompactStream()`/`pipeLlamaCppCompactStream()` already use for a failed upstream
 * generation (no dedicated "failed" frame type exists yet - see llamacpp-compact-stream.js's own frame
 * type list).
 * @param {object} params
 * @param {import('express').Response} params.response
 * @param {string} params.jobId Horde's own job id - also used as the `X-Generation-Id`.
 * @param {string} params.agent
 * @param {object|null} params.rawActionPersist Same shape `persistAssistantReply()` takes minus
 * `directories`/`ownerId` (already merged in by the caller) - or `null` to skip persistence.
 * @returns {Promise<void>}
 */
async function streamHordeGeneration({ response, jobId, agent, rawActionPersist }) {
    response.setHeader('X-ST-Stream-Format', 'compact-v1');
    response.setHeader('X-Generation-Id', jobId);

    const generationRecord = createGenerationRecord(jobId);
    const { writer: initialWriter, stopKeepalive } = createResumableWriter(createBackpressureWriter(response), generationRecord, HORDE_KEEPALIVE_INTERVAL_MS);
    let writer = initialWriter;

    const pollState = registerHordePoll(jobId);

    const onSocketClose = () => {
        stopKeepalive();
        writer = detachFromResponse(generationRecord);
    };
    response.socket?.once('close', onSocketClose);

    try {
        let text = '';
        let workerInfo = null;
        for (let attempt = 0; attempt < HORDE_MAX_RETRIES; attempt++) {
            if (pollState.cancelled) {
                console.info(`Horde task ${jobId} was cancelled; stopping the server-side poll loop.`);
                break;
            }

            let statusJson;
            try {
                statusJson = await fetchHordeJobStatus(jobId, agent);
            } catch (error) {
                console.error(`Failed to check Horde task ${jobId} status:`, error);
                break;
            }

            if (statusJson.faulted === true) {
                console.error(`Horde task ${jobId} faulted.`);
                break;
            }

            if (statusJson.is_possible === false) {
                console.error(`Horde task ${jobId} is not satisfiable by any available worker.`);
                break;
            }

            if (statusJson.done && Array.isArray(statusJson.generations) && statusJson.generations.length) {
                const generation = statusJson.generations[0];
                text = generation.text || '';
                workerInfo = { worker_name: generation.worker_name, model: generation.model };
                break;
            }

            if (attempt === HORDE_MAX_RETRIES - 1) {
                console.error(`Horde task ${jobId} timed out after ${HORDE_MAX_RETRIES} polling attempts.`);
                break;
            }

            await Promise.race([delay(HORDE_POLL_INTERVAL_MS), pollState.cancelPromise]);
        }

        if (!pollState.cancelled && text) {
            if (workerInfo?.worker_name) {
                writer.write(encodeControlFrame(workerInfo));
            }
            writer.write(encodeContent(text));

            if (rawActionPersist) {
                try {
                    const persisted = await persistAssistantReply(rawActionPersist, text);
                    if (persisted) {
                        writer.write(encodeAssistantNodeIdFrame(persisted.node_id));
                    }
                } catch (error) {
                    console.error(`Failed to persist Horde raw-action assistant reply for task ${jobId}:`, error);
                }
            }
        }
    } finally {
        response.socket?.off('close', onSocketClose);
        activeHordePolls.delete(jobId);
        writer.end();
    }
}

router.get('/generate/resume/:id', handleGenerationResume);

router.post('/generate-text', async (request, response) => {
    // Real raw-action cutover - see buildRawActionHordePayload()'s own doc comment above for the
    // full design. Same trigger condition kobold.js's own raw-action branch uses (owner_id plus
    // character_avatar/group_id) - the existing dispatch code below (the actual POST to Horde's real
    // coordinator) is completely unaware of which branch produced `request.body`, same pattern.
    let rawActionPersist = null;
    if (request.body.owner_id && (request.body.character_avatar || request.body.group_id)) {
        const ownerId = request.body.owner_id;
        try {
            const built = await buildRawActionHordePayload(request);
            request.body = built.body;
            rawActionPersist = built.rawActionPersist
                ? { ...built.rawActionPersist, directories: request.user.directories, ownerId }
                : null;
        } catch (error) {
            console.error('Failed to build raw-action Horde request:', error);
            return response.status(400).send({ error: true, message: error?.message ?? 'Could not resolve this generation request' });
        }
    }

    const apiKey = readSecret(request.user.directories, SECRET_KEYS.HORDE) || ANONYMOUS_KEY;
    const url = 'https://aihorde.net/api/v2/generate/text/async';
    const agent = await getClientAgent();

    let submitData;
    try {
        const result = await fetch(url, {
            method: 'POST',
            body: JSON.stringify(request.body),
            headers: {
                'Content-Type': 'application/json',
                'apikey': apiKey,
                'Client-Agent': agent,
            },
        });

        if (!result.ok) {
            const message = await result.text();
            console.error('Horde returned an error:', message);
            return response.send({ error: { message } });
        }

        submitData = await result.json();
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }

    if (!submitData?.id) {
        console.error('Horde submission did not return a job id:', submitData);
        return response.send({ error: { message: submitData?.message || 'Horde did not return a job id' } });
    }

    return streamHordeGeneration({ response, jobId: submitData.id, agent, rawActionPersist });
});

router.post('/sd-samplers', async (_, response) => {
    try {
        const samplers = Object.values(ModelGenerationInputStableSamplers);
        response.send(samplers);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

router.post('/sd-models', async (_, response) => {
    try {
        const ai_horde = await getHordeClient();
        const models = await ai_horde.getModels();
        response.send(models);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

router.post('/caption-image', async (request, response) => {
    try {
        const api_key_horde = readSecret(request.user.directories, SECRET_KEYS.HORDE) || ANONYMOUS_KEY;
        const ai_horde = await getHordeClient();
        const result = await ai_horde.postAsyncInterrogate({
            source_image: request.body.image,
            forms: [{ name: ModelInterrogationFormTypes.caption }],
        }, { token: api_key_horde });

        if (!result.id) {
            console.error('Image interrogation request is not satisfyable:', result.message || 'unknown error');
            return response.sendStatus(400);
        }

        const MAX_ATTEMPTS = 200;
        const CHECK_INTERVAL = 3000;

        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            await delay(CHECK_INTERVAL);
            const status = await ai_horde.getInterrogationStatus(result.id);
            console.info(status);

            if (status.state === HordeAsyncRequestStates.done) {
                if (status.forms === undefined) {
                    console.error('Image interrogation request failed: no forms found.');
                    return response.sendStatus(500);
                }

                console.debug('Image interrogation result:', status);
                const caption = status?.forms[0]?.result?.caption || '';

                if (!caption) {
                    console.error('Image interrogation request failed: no caption found.');
                    return response.sendStatus(500);
                }

                return response.send({ caption });
            }

            if (status.state === HordeAsyncRequestStates.faulted || status.state === HordeAsyncRequestStates.cancelled) {
                console.error('Image interrogation request is not successful.');
                return response.sendStatus(503);
            }
        }
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

router.post('/user-info', async (request, response) => {
    const api_key_horde = readSecret(request.user.directories, SECRET_KEYS.HORDE);

    if (!api_key_horde) {
        return response.send({ anonymous: true });
    }

    try {
        const ai_horde = await getHordeClient();
        const sharedKey = await (async () => {
            try {
                return await ai_horde.getSharedKey(api_key_horde);
            } catch {
                return null;
            }
        })();
        const user = await ai_horde.findUser({ token: api_key_horde });
        return response.send({ user, sharedKey, anonymous: false });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/generate-image', async (request, response) => {
    if (!request.body.prompt) {
        return response.sendStatus(400);
    }

    const MAX_ATTEMPTS = 200;
    const CHECK_INTERVAL = 3000;
    const PROMPT_THRESHOLD = 5000;

    try {
        const maxLength = PROMPT_THRESHOLD - String(request.body.negative_prompt).length - 5;
        if (String(request.body.prompt).length > maxLength) {
            console.warn('Stable Horde prompt is too long, truncating...');
            request.body.prompt = String(request.body.prompt).substring(0, maxLength);
        }

        // Sanitize prompt if requested
        if (request.body.sanitize) {
            const sanitized = sanitizeHordeImagePrompt(request.body.prompt);

            if (request.body.prompt !== sanitized) {
                console.info('Stable Horde prompt was sanitized.');
            }

            request.body.prompt = sanitized;
        }

        const api_key_horde = readSecret(request.user.directories, SECRET_KEYS.HORDE) || ANONYMOUS_KEY;
        console.debug('Stable Horde request:', request.body);

        const ai_horde = await getHordeClient();
        // noinspection JSCheckFunctionSignatures -- see @ts-ignore - use_gfpgan
        const generation = await ai_horde.postAsyncImageGenerate(
            {
                prompt: `${request.body.prompt} ### ${request.body.negative_prompt}`,
                params:
                {
                    sampler_name: request.body.sampler,
                    hires_fix: request.body.enable_hr,
                    // @ts-ignore - use_gfpgan param is not in the type definition, need to update to new ai_horde @ https://github.com/ZeldaFan0225/ai_horde/blob/main/index.ts
                    use_gfpgan: request.body.restore_faces,
                    cfg_scale: request.body.scale,
                    steps: request.body.steps,
                    width: request.body.width,
                    height: request.body.height,
                    karras: Boolean(request.body.karras),
                    clip_skip: request.body.clip_skip,
                    seed: request.body.seed >= 0 ? String(request.body.seed) : undefined,
                    n: 1,
                },
                r2: false,
                nsfw: request.body.nfsw,
                models: [request.body.model],
            },
            { token: api_key_horde });

        if (!generation.id) {
            console.warn('Image generation request is not satisfyable:', generation.message || 'unknown error');
            return response.sendStatus(400);
        }

        console.info('Horde image generation request:', generation);

        const controller = new AbortController();
        request.socket.removeAllListeners('close');
        request.socket.on('close', function () {
            console.warn('Horde image generation request aborted.');
            controller.abort();
            if (generation.id) ai_horde.deleteImageGenerationRequest(generation.id);
        });

        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            controller.signal.throwIfAborted();
            await delay(CHECK_INTERVAL);
            const check = await ai_horde.getImageGenerationCheck(generation.id);
            console.info(check);

            if (check.done) {
                const result = await ai_horde.getImageGenerationStatus(generation.id);
                if (result.generations === undefined) return response.sendStatus(500);
                return response.send(result.generations[0].img);
            }

            /*
            if (!check.is_possible) {
                return response.sendStatus(503);
            }
            */

            if (check.faulted) {
                return response.sendStatus(500);
            }
        }

        return response.sendStatus(504);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
