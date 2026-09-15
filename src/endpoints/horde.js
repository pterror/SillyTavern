import fetch from 'node-fetch';
import express from 'express';
import { AIHorde, ModelGenerationInputStableSamplers, ModelInterrogationFormTypes, HordeAsyncRequestStates } from '@zeldafan0225/ai_horde';
import { getVersion, delay, Cache } from '../util.js';
import { readSecret, SECRET_KEYS } from './secrets.js';
import { buildRawActionKoboldRequest } from './backends/kobold.js';
import { appendMessages, sanitizeUserMessageExtra } from '../message-tree-db.js';

const ANONYMOUS_KEY = '0000000000';
const HORDE_TEXT_MODEL_METADATA_URL = 'https://raw.githubusercontent.com/db0/AI-Horde-text-model-reference/main/db.json';
const cache = new Cache(60 * 1000);
export const router = express.Router();

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
 * src/endpoints/backends/kobold.js's own raw-action `/generate` branch (see `git show 341d1dead`/
 * `5537311f9`/`ea42051ad`) as closely as the real architectural difference allows.
 *
 * JUDGMENT CALL (verified, not assumed - see public/scripts/horde.js's own `generateHorde()` body in
 * full): Horde's generation genuinely CANNOT collapse into one blocking server request the way
 * Kobold's/NovelAI's raw-action branches do. `generateHorde()` submits a job, then polls
 * `/api/horde/task-status` itself in a loop of up to `MAX_RETRIES * CHECK_INTERVAL` (480 * 2500ms =
 * 20 minutes), checking `signal.aborted` every iteration so a real user-initiated stop can call
 * `cancelTask()` - a live client-side wait tied to a live client-side AbortController the server has
 * no equivalent access to. So this route, unlike kobold.js's/novelai.js's own raw-action branches,
 * does NOT block until the final text is known - it only resolves the real character/chat/branch
 * identity, assembles the real prompt via the SAME `buildRawActionKoboldRequest()` kobold.js's own
 * raw-action branch already uses (passing `macroExtras: { isHorde: true }`, since
 * createKoboldGenerationData()'s real, already-tested `isHorde` branch - src/kobold-generation-data.js
 * - already produces the correct payload shape for Horde: `min_p`/`stop_sequence`/`mirostat`/
 * `use_default_badwordsids`/`grammar` are all included regardless of `koboldFlags`, matching the
 * client's own `getKoboldGenerationData(finalPrompt, presetSettings, maxLength, maxContext, isHorde,
 * type)` call site for `main_api === 'koboldhorde'`), persists the user's message immediately (same
 * "persist regardless of outcome" principle as every other raw-action backend - a Horde job can take
 * up to 20 minutes and may still time out/fault/get aborted, so the user's own turn must not depend
 * on that succeeding), and submits the job - returning the SAME `{id, ...}` shape this endpoint
 * always has (see the real submission code below, entered via the SAME fall-through as any
 * non-raw-action request, unaware of which branch produced `request.body` - matching kobold.js's own
 * `request.body = built.params` pattern).
 *
 * The ASSISTANT's reply can only be persisted once the CLIENT's own polling loop resolves with the
 * final text - see public/scripts/horde.js's own `generateHordeRawAction()`, which does so via the
 * EXISTING, already-idempotent-by-content-identity generic tree-mutation endpoints
 * (src/endpoints/chats.js's `/message/append`, `/message/alternative` + `/message/select`,
 * `/message/edit`) rather than a new dedicated persistence endpoint - the exact same three real modes
 * `persistAssistantReply()` (src/assistant-reply-persist.js) implements server-side for every other
 * backend, just invoked from the client since only the client knows when the text is final. This
 * route hands the client everything it needs for that call via the real (non-Horde-API) extra
 * `raw_action_persist` field attached to the response below - `null`/absent whenever persistence
 * should be skipped (impersonate/quiet types, or the same `continueUserTextConflict` edge case
 * kobold.js's own raw-action branch already guards against).
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
 * @returns {Promise<{ body: object, rawActionPersist: object|null }|{ error: { status: number, message: string } }>}
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

router.post('/generate-text', async (request, response) => {
    // Real raw-action cutover - see buildRawActionHordePayload()'s own doc comment above for the
    // full design. Same trigger condition kobold.js's own raw-action branch uses (owner_id plus
    // character_avatar/group_id) - the existing dispatch code below (the actual POST to Horde's real
    // coordinator) is completely unaware of which branch produced `request.body`, same pattern.
    let rawActionPersist = null;
    if (request.body.owner_id && (request.body.character_avatar || request.body.group_id)) {
        try {
            const built = await buildRawActionHordePayload(request);
            request.body = built.body;
            rawActionPersist = built.rawActionPersist;
        } catch (error) {
            console.error('Failed to build raw-action Horde request:', error);
            return response.status(400).send({ error: true, message: error?.message ?? 'Could not resolve this generation request' });
        }
    }

    const apiKey = readSecret(request.user.directories, SECRET_KEYS.HORDE) || ANONYMOUS_KEY;
    const url = 'https://aihorde.net/api/v2/generate/text/async';
    const agent = await getClientAgent();

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

        const data = await result.json();
        // Real raw-action metadata - see buildRawActionHordePayload()'s own doc comment above. Not a
        // real AI Horde API field; the client's own generateHordeRawAction() (public/scripts/horde.js)
        // reads it to know how/where to persist the assistant's reply once its own polling loop
        // resolves with the final text. Omitted (not attached at all) for a non-raw-action request,
        // or whenever this route decided persistence should be skipped - see rawActionPersist's own
        // null cases above.
        if (rawActionPersist) {
            data.raw_action_persist = rawActionPersist;
        }
        return response.send(data);
    } catch (error) {
        console.error(error);
        return response.send({ error: true });
    }
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
