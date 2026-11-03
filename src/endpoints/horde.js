import fetch from 'node-fetch';
import express from 'express';
import { AIHorde } from '@zeldafan0225/ai_horde';
import { getVersion, delay, Cache } from '../util.js';
import { readSecret, SECRET_KEYS } from './secrets.js';
import { buildRawActionKoboldRequest } from './backends/kobold.js';
import { generateTurnOf, textCompletionQuietInput } from '../page-writes.js';
import { storeUserMessage } from '../stored-messages.js';
import { persistAssistantReply } from '../assistant-reply-persist.js';
import { readReplyFinishSettings } from '../reply-reasoning.js';
import { startItemizing } from '../prompt-itemization.js';
import { answerSessionOnHeaders, chatContext } from '../chat-request.js';
import { withGenerationStop } from '../generation-stop.js';
import {
    createGenerationRecord, createResumableWriter, createBackpressureWriter, detachFromResponse,
    encodeContent, encodeStoredReplyFrame, encodeControlFrame, handleGenerationResume, KEEPALIVE_INTERVAL_MS, writeStoredMessagesFrame,
} from './backends/llamacpp-compact-stream.js';

const ANONYMOUS_KEY = '0000000000';
const HORDE_TEXT_MODEL_METADATA_URL = 'https://raw.githubusercontent.com/db0/AI-Horde-text-model-reference/main/db.json';
const cache = new Cache(60 * 1000);
export const router = express.Router();

const HORDE_MAX_RETRIES_DEFAULT = 480;
const HORDE_POLL_INTERVAL_MS_DEFAULT = 2500;
let HORDE_MAX_RETRIES = HORDE_MAX_RETRIES_DEFAULT;
let HORDE_POLL_INTERVAL_MS = HORDE_POLL_INTERVAL_MS_DEFAULT;
let HORDE_KEEPALIVE_INTERVAL_MS = KEEPALIVE_INTERVAL_MS;

/**
 * @param {{pollIntervalMs?: number, maxRetries?: number, keepaliveIntervalMs?: number}} [overrides]
 */
export function _setHordePollingConfigForTests({ pollIntervalMs, maxRetries, keepaliveIntervalMs } = {}) {
    HORDE_POLL_INTERVAL_MS = pollIntervalMs ?? HORDE_POLL_INTERVAL_MS_DEFAULT;
    HORDE_MAX_RETRIES = maxRetries ?? HORDE_MAX_RETRIES_DEFAULT;
    HORDE_KEEPALIVE_INTERVAL_MS = keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS;
}

/** @type {Map<string, {cancelled: boolean, cancel: () => void, cancelPromise: Promise<void>}>} */
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

        let data = await fetchResult.json().catch(() => null);

        if (!fetchResult.ok || !Array.isArray(data)) {
            const said = (data && typeof data === 'object' && typeof data.message === 'string') ? data.message : fetchResult.statusText;
            const message = `AI Horde did not send a model list (HTTP ${fetchResult.status}${said ? `: ${said}` : ''}).`;
            console.warn(message);
            return response.status(502).send({ error: true, message });
        }

        // attempt to fetch and merge models metadata
        try {
            const metadata = await getHordeTextModelMetadata();
            if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
                data = await mergeModelsAndMetadata(data, metadata);
            } else {
                console.warn('AI Horde model metadata was not an object; showing models without it.');
            }
        } catch (error) {
            console.warn('Failed to fetch AI Horde model metadata; showing models without it:', error?.message ?? error);
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
        activeHordePolls.get(taskId)?.cancel();
        const agent = await getClientAgent();
        const fetchResult = await fetch(`https://aihorde.net/api/v2/generate/text/status/${taskId}`, {
            method: 'DELETE',
            headers: {
                'Client-Agent': agent,
            },
        });

        const data = await fetchResult.json();
        return response.send(data);
    } catch (error) {
        console.error(error);
        response.sendStatus(500);
    }
});

/**
 * @param {import('express').Request} request
 * @param {import('express').Response} response
 * @returns {Promise<{ body: object, rawActionPersist: object|null }>}
 */
async function buildRawActionHordePayload(request, response) {
    const {
        character_avatar: characterAvatar, group_id: groupId,
        type = 'normal', trusted_workers: trustedWorkers = false, models,
    } = request.body;
    const isImpersonate = type === 'impersonate';
    const isContinue = type === 'continue';
    const isSwipe = type === 'swipe' || type === 'regenerate';

    const directories = request.user.directories;
    const chat = await chatContext(request, { avatar: characterAvatar, group: groupId });
    if (!chat) throw new Error(groupId ? `Group not found: ${groupId}` : `Character not found: ${characterAvatar}`);
    answerSessionOnHeaders(response, chat.session);
    const turn = await generateTurnOf(response, chat, request.body);
    if (!turn) return null;
    const { nodeId, userMessageText, userMessageExtra, quiet, responseLength } = turn;

    const built = await buildRawActionKoboldRequest(directories, {
        request, characterAvatar, groupId, chat, nodeId,
        type, isImpersonate, isContinue, isSwipe, userMessageText, userMessageExtra, responseLength,
        macroExtras: { isHorde: true, ...textCompletionQuietInput(quiet) },
    });

    const skipPersistence = isImpersonate || type === 'quiet';
    let replyAnchorNodeId = built.anchorNodeId;
    const userMessage = turn.userMessage;
    if (!skipPersistence && typeof userMessageText === 'string') {
        const userNodeId = await storeUserMessage(response, {
            chat, anchorNodeId: built.anchorNodeId, ref: request.body.user_message_ref,
            message: userMessage,
        });
        if (!userNodeId) return null;
        replyAnchorNodeId = userNodeId;
    }
    const continuesUserMessage = isContinue && replyAnchorNodeId !== built.anchorNodeId;
    if (!skipPersistence) chat.session.actor();
    const rawActionPersist = !skipPersistence
        ? {
            chat, anchorNodeId: replyAnchorNodeId, name2: built.name2, isSwipe, isContinue, anchorContent: continuesUserMessage ? userMessage : built.anchorContent,
            itemization: startItemizing(built.itemize),
            finish: await readReplyFinishSettings(directories, { mainApi: 'koboldhorde', avatar: characterAvatar, groupId, name1: built.name1, name2: built.name2 }),
        }
        : null;

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
 * @param {object} params
 * @param {import('express').Response} params.response
 * @param {string} params.jobId
 * @param {string} params.agent
 * @param {object|null} params.rawActionPersist
 * @param {Array<{kind: string, key: string, message: string, entries?: string[]}>|null} [params.warnings]
 * @returns {Promise<void>}
 */
async function streamHordeGeneration({ response, jobId, agent, rawActionPersist, warnings = null }) {
    response.setHeader('X-ST-Stream-Format', 'compact-v1');
    response.setHeader('X-Generation-Id', jobId);

    const generationRecord = createGenerationRecord(jobId);
    const { writer: initialWriter, stopKeepalive } = createResumableWriter(createBackpressureWriter(response), generationRecord, HORDE_KEEPALIVE_INTERVAL_MS);
    let writer = initialWriter;
    writeStoredMessagesFrame(writer, response);
    if (warnings?.length) {
        writer.write(encodeControlFrame({ warnings }));
    }

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
                    if (workerInfo?.worker_name) {
                        rawActionPersist.title = `Generated by Horde worker: ${workerInfo.worker_name} [${workerInfo.model}]`;
                        if (rawActionPersist.finish) rawActionPersist.finish.model = workerInfo.model ?? '';
                    }
                    const persisted = await persistAssistantReply(rawActionPersist, text);
                    const frame = encodeStoredReplyFrame(persisted, rawActionPersist);
                    if (frame) writer.write(frame);
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

router.post('/generate-text', withGenerationStop(async (request, response) => {
    let rawActionPersist = null;
    /** @type {Array<{kind: string, key: string, message: string, entries?: string[]}>} */
    const warnings = [];
    if (request.body.owner_id && (request.body.character_avatar || request.body.group_id)) {
        try {
            const built = await buildRawActionHordePayload(request, response);
            request.body = built.body;
            rawActionPersist = built.rawActionPersist
                ? { ...built.rawActionPersist, warnings, generationStop: response.locals.generationStop }
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

    return streamHordeGeneration({ response, jobId: submitData.id, agent, rawActionPersist, warnings });
}));

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
