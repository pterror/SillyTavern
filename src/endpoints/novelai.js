import util from 'node:util';
import { Buffer } from 'node:buffer';

import fetch from 'node-fetch';
import express from 'express';

import { readSecret, SECRET_KEYS } from './secrets.js';
import { readAllChunks, extractFileFromZipBuffer } from '../util.js';
import { readSettingsAtPaths } from '../settings-store.js';
import { encodeWithTokenizerType } from '../tokenizer-resolve.js';
import { getTokenizerTypeForModel } from '../novel-generation-data.js';
import { resolveTextCompletionGenerationInput } from '../text-completion-generation-input.js';
import { assembleTextCompletionPrompt } from '../text-completion-prompt-orchestrator.js';
import { getAncestorPath, appendMessages, sanitizeUserMessageExtra } from '../message-tree-db.js';
import { readCardContent } from './characters.js';
import { getGroupsByIds } from './groups.js';
import { persistAssistantReply } from '../assistant-reply-persist.js';
import { forwardAndPersistCompactStream } from './backends/text-completions.js';

const API_NOVELAI = 'https://api.novelai.net';
const TEXT_NOVELAI = 'https://text.novelai.net';
const IMAGE_NOVELAI = 'https://image.novelai.net';

// Constants for skip_cfg_above_sigma (Variety+) calculation
const REFERENCE_PIXEL_COUNT = 1011712;   // 832 * 1216 reference image size
const SIGMA_MAGIC_NUMBER = 19;           // Base sigma multiplier for V3 and V4 models
const SIGMA_MAGIC_NUMBER_V4_5 = 58;      // Base sigma multiplier for V4.5 models

// Ban bracket generation, plus defaults
const badWordsList = [
    [3], [49356], [1431], [31715], [34387], [20765], [30702], [10691], [49333], [1266],
    [19438], [43145], [26523], [41471], [2936], [85, 85], [49332], [7286], [1115], [24],
];

const eratoBadWordsList = [
    [16067], [933, 11144], [25106, 11144], [58, 106901, 16073, 33710, 25, 109933],
    [933, 58, 11144], [128030], [58, 30591, 33503, 17663, 100204, 25, 11144],
];

const hypeBotBadWordsList = [
    [58], [60], [90], [92], [685], [1391], [1782], [2361], [3693], [4083], [4357], [4895],
    [5512], [5974], [7131], [8183], [8351], [8762], [8964], [8973], [9063], [11208],
    [11709], [11907], [11919], [12878], [12962], [13018], [13412], [14631], [14692],
    [14980], [15090], [15437], [16151], [16410], [16589], [17241], [17414], [17635],
    [17816], [17912], [18083], [18161], [18477], [19629], [19779], [19953], [20520],
    [20598], [20662], [20740], [21476], [21737], [22133], [22241], [22345], [22935],
    [23330], [23785], [23834], [23884], [25295], [25597], [25719], [25787], [25915],
    [26076], [26358], [26398], [26894], [26933], [27007], [27422], [28013], [29164],
    [29225], [29342], [29565], [29795], [30072], [30109], [30138], [30866], [31161],
    [31478], [32092], [32239], [32509], [33116], [33250], [33761], [34171], [34758],
    [34949], [35944], [36338], [36463], [36563], [36786], [36796], [36937], [37250],
    [37913], [37981], [38165], [38362], [38381], [38430], [38892], [39850], [39893],
    [41832], [41888], [42535], [42669], [42785], [42924], [43839], [44438], [44587],
    [44926], [45144], [45297], [46110], [46570], [46581], [46956], [47175], [47182],
    [47527], [47715], [48600], [48683], [48688], [48874], [48999], [49074], [49082],
    [49146], [49946], [10221], [4841], [1427], [2602, 834], [29343], [37405], [35780], [2602], [50256],
];

// Used for phrase repetition penalty
const repPenaltyAllowList = [
    [49256, 49264, 49231, 49230, 49287, 85, 49255, 49399, 49262, 336, 333, 432, 363, 468, 492, 745, 401, 426, 623, 794,
        1096, 2919, 2072, 7379, 1259, 2110, 620, 526, 487, 16562, 603, 805, 761, 2681, 942, 8917, 653, 3513, 506, 5301,
        562, 5010, 614, 10942, 539, 2976, 462, 5189, 567, 2032, 123, 124, 125, 126, 127, 128, 129, 130, 131, 132, 588,
        803, 1040, 49209, 4, 5, 6, 7, 8, 9, 10, 11, 12],
];

const eratoRepPenWhitelist = [
    6, 1, 11, 13, 25, 198, 12, 9, 8, 279, 264, 459, 323, 477, 539, 912, 374, 574, 1051, 1550, 1587, 4536, 5828, 15058,
    3287, 3250, 1461, 1077, 813, 11074, 872, 1202, 1436, 7846, 1288, 13434, 1053, 8434, 617, 9167, 1047, 19117, 706,
    12775, 649, 4250, 527, 7784, 690, 2834, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 1210, 1359, 608, 220, 596, 956,
    3077, 44886, 4265, 3358, 2351, 2846, 311, 389, 315, 304, 520, 505, 430,
];

// Ban the dinkus and asterism
const logitBiasExp = [
    { 'sequence': [23], 'bias': -0.08, 'ensure_sequence_finish': false, 'generate_once': false },
    { 'sequence': [21], 'bias': -0.08, 'ensure_sequence_finish': false, 'generate_once': false },
];

const eratoLogitBiasExp = [
    { 'sequence': [12488], 'bias': -0.08, 'ensure_sequence_finish': false, 'generate_once': false },
    { 'sequence': [128041], 'bias': -0.08, 'ensure_sequence_finish': false, 'generate_once': false },
];

function getBadWordsList(model) {
    let list = [];

    if (model.includes('hypebot')) {
        list = hypeBotBadWordsList;
    }

    if (model.includes('clio') || model.includes('kayra')) {
        list = badWordsList;
    }

    if (model.includes('erato')) {
        list = eratoBadWordsList;
    }

    // Clone the list so we don't modify the original
    return list.slice();
}

function getLogitBiasList(model) {
    let list = [];

    if (model.includes('erato')) {
        list = eratoLogitBiasExp;
    }

    if (model.includes('clio') || model.includes('kayra')) {
        list = logitBiasExp;
    }

    return list.slice();
}

function getRepPenaltyWhitelist(model) {
    if (model.includes('clio') || model.includes('kayra')) {
        return repPenaltyAllowList.flat();
    }

    if (model.includes('erato')) {
        return eratoRepPenWhitelist.flat();
    }

    return null;
}

function calculateSkipCfgAboveSigma(width, height, modelName) {
    const magicConstant = modelName?.includes('nai-diffusion-4-5')
        ? SIGMA_MAGIC_NUMBER_V4_5
        : SIGMA_MAGIC_NUMBER;

    const pixelCount = width * height;
    const ratio = pixelCount / REFERENCE_PIXEL_COUNT;

    return Math.pow(ratio, 0.5) * magicConstant;
}

export const router = express.Router();

router.post('/status', async function (req, res) {
    if (!req.body) return res.sendStatus(400);
    const api_key_novel = readSecret(req.user.directories, SECRET_KEYS.NOVEL);

    if (!api_key_novel) {
        console.warn('NovelAI Access Token is missing.');
        return res.sendStatus(400);
    }

    try {
        const response = await fetch(IMAGE_NOVELAI + '/user/subscription', {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + api_key_novel,
            },
        });

        if (response.ok) {
            const data = await response.json();
            return res.send(data);
        } else if (response.status == 401) {
            console.error('NovelAI Access Token is incorrect.');
            return res.send({ error: true });
        } else {
            console.warn('NovelAI returned an error:', response.statusText);
            return res.send({ error: true });
        }
    } catch (error) {
        console.error(error);
        return res.send({ error: true });
    }
});

/**
 * Real, tested raw-action request builder for main_api === 'novel'. Directly mirrors
 * src/endpoints/backends/text-completions.js's own `buildRawActionTextCompletionRequest()` (see
 * `git show ac42ce8c9` for the original design) and src/endpoints/backends/kobold.js's own
 * `buildRawActionKoboldRequest()` - same field names, same
 * resolveTextCompletionGenerationInput()+assembleTextCompletionPrompt() pipeline, now dispatching to
 * createNovelGenerationData() for real per text-completion-prompt-orchestrator.js's own Step 16
 * update. No `resolveTextGenBackend()`/api_server concept here at all - NovelAI is always the same
 * fixed API endpoint (`API_NOVELAI`/`TEXT_NOVELAI`, selected by model name, unchanged below), unlike
 * Kobold's own connectable-server-URL model.
 *
 * `encodeTokensByType` (see text-completion-prompt-orchestrator.js's own doc comment on this exact
 * parameter for the full "real, verified parameter-shape mismatch" rationale) is wired here to the
 * REAL `getTokenizerTypeForModel()` + `encodeWithTokenizerType()` pair - `settings.model_novel`
 * (read directly off `nai_settings` below, matching the model createNovelGenerationData() itself
 * will use) decides which tokenizer id createNovelGenerationData() passes back into this function on
 * each call, and this function then dispatches that SPECIFIC tokenizer type to the real encoder -
 * exactly the shape createNovelGenerationData() needs, not the generic single-arg `encodeTokens`.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {object} params
 * @param {import('express').Request} [params.request]
 * @param {string} [params.characterAvatar]
 * @param {string} [params.groupId]
 * @param {string} params.ownerId
 * @param {string|null} params.nodeId REQUIRED (`undefined` throws) - see
 * src/endpoints/backends/text-completions.js's `buildRawActionTextCompletionRequest()` own
 * ADDRESSING MODEL doc comment for the full rationale this mirrors verbatim: a real node id string
 * addresses that specific existing node; `null` asserts "this is a genuinely new, empty
 * conversation" and only succeeds when that is actually true. There is no `branchName`/`branch_name`
 * field in this raw-action surface anymore.
 * @param {string} [params.type]
 * @param {boolean} [params.isImpersonate]
 * @param {boolean} [params.isContinue]
 * @param {boolean} [params.isSwipe]
 * @param {string} [params.userMessageText]
 * @param {object} [params.userMessageExtra] Already-SERVER-VALIDATED `extra` (see
 * `sanitizeUserMessageExtra()` in message-tree-db.js) for the new user message being appended -
 * identical contract to buildRawActionTextCompletionRequest()'s own equivalent param. NovelAI has no
 * media/image inlining wired here - only `.files` is meaningfully consumed downstream
 * (file-attachment-inline.js, via resolveTextCompletionGenerationInput()).
 * @returns {Promise<{ params: object, anchorNodeId: string|null, anchorContent: object|null, name1: string, name2: string }>}
 */
export async function buildRawActionNovelRequest(directories, {
    request, characterAvatar, groupId, ownerId, nodeId,
    type = 'normal', isImpersonate = false, isContinue = false, isSwipe = false, userMessageText, userMessageExtra,
    tokenizerOptions = {},
} = {}) {
    if (!ownerId) {
        throw new Error('owner_id is required');
    }
    if (!characterAvatar && !groupId) {
        throw new Error('character_avatar or group_id is required');
    }
    // See buildRawActionTextCompletionRequest()'s own ADDRESSING MODEL doc comment - `undefined`
    // means the request body never had the `node_id` key at all (JSON has no `undefined` literal, so
    // this is distinguishable from an explicit `null`).
    if (nodeId === undefined) {
        throw new Error('node_id is required (pass null explicitly for a brand-new, empty conversation)');
    }

    if (characterAvatar) {
        let raw;
        try {
            raw = await readCardContent(directories, characterAvatar);
        } catch { /* treated as not-found below */ }
        if (raw === undefined) {
            throw new Error(`Character not found: ${characterAvatar}`);
        }
    }
    if (groupId) {
        const group = getGroupsByIds(directories, [groupId])[groupId];
        if (!group) {
            throw new Error(`Group not found: ${groupId}`);
        }
    }

    // Anchor resolution - a real given `nodeId` is verified directly; `nodeId === null` (the
    // "genuinely new, empty conversation" assertion) is left unresolved here and read back off
    // `orchestratorInput.resolvedNodeId`/`chatResolutionAmbiguous` once resolved below - identical
    // pattern to buildRawActionTextCompletionRequest()'s own Step 2.
    let anchorNodeId = null;
    if (nodeId !== null) {
        const ancestorPath = await getAncestorPath(directories, nodeId);
        if (!ancestorPath) {
            throw new Error(`Chat node not found: ${nodeId}`);
        }
        anchorNodeId = nodeId;
    }

    const { nai_settings: naiSettings = {} } = readSettingsAtPaths(directories, ['nai_settings']);
    const modelNovel = naiSettings.model_novel ?? '';
    const novelTokenizerType = getTokenizerTypeForModel(modelNovel);
    // Generic single-arg encodeTokens (Step 1-15's own contract - see
    // text-completion-prompt-orchestrator.js's plain `encodeTokens` doc comment) always uses the
    // SAME real per-model tokenizer type NovelAI itself will use - a reasonable, real choice (not a
    // guess) since this whole request is for that one fixed model either way.
    const encodeTokens = (text) => encodeWithTokenizerType(novelTokenizerType, text, { request, ...tokenizerOptions });
    const countTokens = async (text) => (await encodeTokens(text)).length;
    // Real two-arg bridge for createNovelGenerationData()'s own EncodeTokensFn - see this function's
    // own doc comment above.
    const encodeTokensByType = (tokenizerType, text) => encodeWithTokenizerType(tokenizerType ?? novelTokenizerType, text, { request, ...tokenizerOptions });

    const orchestratorInput = await resolveTextCompletionGenerationInput(directories, {
        avatar: characterAvatar, groupId, mainApi: 'novel', ownerId, nodeId,
        type, isImpersonate, isContinue, isSwipe, userMessageText, userMessageExtra,
        countTokens, encodeTokens,
        macroExtras: { encodeTokensByType },
    });

    // `nodeId === null` ("genuinely new, empty conversation") is only valid when this owner's
    // conversation really is empty - see buildRawActionTextCompletionRequest()'s identical handling.
    if (nodeId === null) {
        if (orchestratorInput.chatResolutionAmbiguous) {
            throw new Error('node_id is required: this character/group already has an existing conversation - resolve which node the client was looking at and pass its node_id (null is only valid for a genuinely new, empty conversation)');
        }
        anchorNodeId = orchestratorInput.resolvedNodeId;
    }

    if ((isContinue || isSwipe) && orchestratorInput.chat.length === 0) {
        throw new Error('Cannot continue/swipe an empty chat.');
    }

    const assembled = await assembleTextCompletionPrompt(orchestratorInput);
    const anchorContent = orchestratorInput.chat.length > 0 ? orchestratorInput.chat[orchestratorInput.chat.length - 1] : null;

    return { params: assembled.generate_data, anchorNodeId, anchorContent, name1: orchestratorInput.name1, name2: orchestratorInput.name2 };
}

router.post('/generate', async function (req, res) {
    if (!req.body) return res.sendStatus(400);

    // Real raw-action cutover - see buildRawActionNovelRequest() above and
    // src/endpoints/backends/text-completions.js's/src/endpoints/backends/kobold.js's own
    // identically-shaped branches for the full design precedent this mirrors.
    let pendingAssistantPersist = null;
    if (req.body.owner_id && (req.body.character_avatar || req.body.group_id)) {
        const {
            character_avatar: characterAvatar, group_id: groupId, owner_id: ownerId,
            node_id: nodeId, type = 'normal',
            user_message: userMessageText,
        } = req.body;
        // Server-validated (NOT trusted verbatim) - see `sanitizeUserMessageExtra()`'s own doc
        // comment (message-tree-db.js) and text-completions.js's identical raw-action branch.
        const userMessageExtra = sanitizeUserMessageExtra(req.body.user_message_extra);
        // is_impersonate/is_continue/is_swipe are NOT read from the wire - see kobold.js's own
        // identical derivation/comment (extended there from text-completions.js's/
        // chat-completions.js's original commit 4a79e197e).
        const isImpersonate = type === 'impersonate';
        const isContinue = type === 'continue';
        const isSwipe = type === 'swipe' || type === 'regenerate';

        const directories = req.user.directories;

        let built;
        try {
            built = await buildRawActionNovelRequest(directories, {
                request: req, characterAvatar, groupId, ownerId, nodeId,
                type, isImpersonate, isContinue, isSwipe, userMessageText, userMessageExtra,
            });
        } catch (error) {
            console.error('Failed to build raw-action NovelAI request:', error);
            return res.status(400).send({ error: true, message: error?.message ?? 'Could not resolve this generation request' });
        }

        // Same three-mode persistence contract as text-completions.js's/kobold.js's own raw-action
        // branches - see text-completions.js's own extensive comment on impersonate/quiet skipping,
        // the swipe/regenerate sibling-vs-child distinction, and the continue/userMessageText
        // tree-shape edge case. Not re-derived here; identical reasoning applies verbatim.
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
        if (!skipPersistence && !continueUserTextConflict) {
            pendingAssistantPersist = {
                directories, ownerId, anchorNodeId: replyAnchorNodeId, name2: built.name2,
                isSwipe, isContinue, anchorContent: built.anchorContent,
            };
        }

        // Replace the body entirely - the existing dispatch code below (bad-words/logit-bias
        // enrichment, `req.body.model`-keyed URL selection, streaming vs non-streaming) is completely
        // unaware of which branch produced req.body, same as text-completions.js's/kobold.js's own
        // pattern.
        req.body = built.params;
    }

    const api_key_novel = readSecret(req.user.directories, SECRET_KEYS.NOVEL);

    if (!api_key_novel) {
        console.warn('NovelAI Access Token is missing.');
        return res.sendStatus(400);
    }

    const controller = new AbortController();
    req.socket.removeAllListeners('close');
    req.socket.on('close', function () {
        controller.abort();
    });

    // Add customized bad words for Clio, Kayra, and Erato
    const badWordsList = getBadWordsList(req.body.model);

    if (Array.isArray(badWordsList) && Array.isArray(req.body.bad_words_ids)) {
        for (const badWord of req.body.bad_words_ids) {
            if (Array.isArray(badWord) && badWord.every(x => Number.isInteger(x))) {
                badWordsList.push(badWord);
            }
        }
    }

    // Remove empty arrays from bad words list
    for (const badWord of badWordsList) {
        if (badWord.length === 0) {
            badWordsList.splice(badWordsList.indexOf(badWord), 1);
        }
    }

    // Add default biases for dinkus and asterism
    const logitBiasList = getLogitBiasList(req.body.model);

    if (Array.isArray(logitBiasList) && Array.isArray(req.body.logit_bias_exp)) {
        logitBiasList.push(...req.body.logit_bias_exp);
    }

    const repPenWhitelist = getRepPenaltyWhitelist(req.body.model);

    const data = {
        'input': req.body.input,
        'model': req.body.model,
        'parameters': {
            'use_string': req.body.use_string ?? true,
            'temperature': req.body.temperature,
            'max_length': req.body.max_length,
            'min_length': req.body.min_length,
            'tail_free_sampling': req.body.tail_free_sampling,
            'repetition_penalty': req.body.repetition_penalty,
            'repetition_penalty_range': req.body.repetition_penalty_range,
            'repetition_penalty_slope': req.body.repetition_penalty_slope,
            'repetition_penalty_frequency': req.body.repetition_penalty_frequency,
            'repetition_penalty_presence': req.body.repetition_penalty_presence,
            'repetition_penalty_whitelist': repPenWhitelist,
            'top_a': req.body.top_a,
            'top_p': req.body.top_p,
            'top_k': req.body.top_k,
            'typical_p': req.body.typical_p,
            'mirostat_lr': req.body.mirostat_lr,
            'mirostat_tau': req.body.mirostat_tau,
            'phrase_rep_pen': req.body.phrase_rep_pen,
            'stop_sequences': req.body.stop_sequences,
            'bad_words_ids': badWordsList.length ? badWordsList : null,
            'logit_bias_exp': logitBiasList,
            'generate_until_sentence': req.body.generate_until_sentence,
            'use_cache': req.body.use_cache,
            'return_full_text': req.body.return_full_text,
            'prefix': req.body.prefix,
            'order': req.body.order,
            'num_logprobs': req.body.num_logprobs,
            'min_p': req.body.min_p,
            'math1_temp': req.body.math1_temp,
            'math1_quad': req.body.math1_quad,
            'math1_quad_entropy_scale': req.body.math1_quad_entropy_scale,
        },
    };

    // Tells the model to stop generation at '>'
    if ('theme_textadventure' === req.body.prefix) {
        if (req.body.model.includes('clio') || req.body.model.includes('kayra')) {
            data.parameters.eos_token_id = 49405;
        }
        if (req.body.model.includes('erato')) {
            data.parameters.eos_token_id = 29;
        }
    }

    // Pass the object raw, not a pre-formatted util.inspect() dump - see the same fix in chat-completions.js
    // and text-completions.js for why the eager inspect/stringify defeats minLogLevel's no-op gate.
    console.debug('NAI request:', data);

    const args = {
        body: JSON.stringify(data),
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + api_key_novel },
        signal: controller.signal,
    };

    try {
        const baseURL = (req.body.model.includes('kayra') || req.body.model.includes('erato')) ? TEXT_NOVELAI : API_NOVELAI;
        const url = req.body.streaming ? `${baseURL}/ai/generate-stream` : `${baseURL}/ai/generate`;
        const response = await fetch(url, { method: 'POST', ...args });

        if (req.body.streaming) {
            // Re-encode NovelAI's own SSE data payload shape (`{"token": "...", "logprobs": {...}}`,
            // verified against generateNovelWithStreaming() in public/scripts/nai-settings.js -
            // `data.token` is already decoded text, not a raw token id) into the same compact binary
            // wire format every streaming path uses, raw-action or not (see
            // forwardAndPersistCompactStream()'s own doc comment) - `data.logprobs` is carried through
            // as a `0x02` probabilities frame so per-token logprob display keeps working.
            // `pendingAssistantPersist` only gates whether the final text also gets persisted.
            await forwardAndPersistCompactStream(response, res, pendingAssistantPersist, json => json?.token, json => json?.logprobs);
        } else {
            if (!response.ok) {
                const text = await response.text();
                let message = text;
                console.warn(`Novel API returned error: ${response.status} ${response.statusText} ${text}`);

                try {
                    const data = JSON.parse(text);
                    message = data.message;
                } catch {
                    // ignore
                }

                return res.status(500).send({ error: { message } });
            }

            /** @type {any} */
            const data = await response.json();
            console.info('NovelAI Output', data?.output);

            // Persist the ASSISTANT's reply for the raw-action branch (see
            // `pendingAssistantPersist`'s declaration above) - only reached for a real, successful
            // (response.ok) NON-STREAMING generation. `/ai/generate`'s real response shape carries
            // the generated text at `data.output` (verified against public/script.js's own
            // `data.output` read of this exact endpoint).
            if (pendingAssistantPersist) {
                const generatedText = data?.output ?? '';
                const persisted = await persistAssistantReply(pendingAssistantPersist, generatedText);
                if (persisted) {
                    data.assistant_node_id = persisted.node_id;
                }
            }

            return res.send(data);
        }
    } catch (error) {
        return res.send({ error: true });
    }
});

router.post('/generate-image', async (request, response) => {
    if (!request.body) {
        return response.sendStatus(400);
    }

    const key = readSecret(request.user.directories, SECRET_KEYS.NOVEL);

    if (!key) {
        console.warn('NovelAI Access Token is missing.');
        return response.sendStatus(400);
    }

    try {
        console.debug('NAI Diffusion request:', request.body);
        const generateUrl = `${IMAGE_NOVELAI}/ai/generate-image`;
        const generateResult = await fetch(generateUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                action: 'generate',
                input: request.body.prompt ?? '',
                model: request.body.model ?? 'nai-diffusion',
                parameters: {
                    params_version: 3,
                    prefer_brownian: true,
                    negative_prompt: request.body.negative_prompt ?? '',
                    height: request.body.height ?? 512,
                    width: request.body.width ?? 512,
                    scale: request.body.scale ?? 9,
                    seed: request.body.seed >= 0 ? request.body.seed : Math.floor(Math.random() * 9999999999),
                    sampler: request.body.sampler ?? 'k_dpmpp_2m',
                    noise_schedule: request.body.scheduler ?? 'karras',
                    steps: request.body.steps ?? 28,
                    n_samples: 1,
                    // NAI handholding for prompts
                    ucPreset: 0,
                    qualityToggle: false,
                    add_original_image: false,
                    controlnet_strength: 1,
                    deliberate_euler_ancestral_bug: false,
                    dynamic_thresholding: request.body.decrisper ?? false,
                    legacy: false,
                    legacy_v3_extend: false,
                    sm: request.body.sm ?? false,
                    sm_dyn: request.body.sm_dyn ?? false,
                    uncond_scale: 1,
                    skip_cfg_above_sigma: request.body.variety_boost
                        ? calculateSkipCfgAboveSigma(
                            request.body.width ?? 512,
                            request.body.height ?? 512,
                            request.body.model ?? 'nai-diffusion',
                        )
                        : null,
                    use_coords: false,
                    characterPrompts: [],
                    reference_image_multiple: [],
                    reference_information_extracted_multiple: [],
                    reference_strength_multiple: [],
                    v4_negative_prompt: {
                        caption: {
                            base_caption: request.body.negative_prompt ?? '',
                            char_captions: [],
                        },
                    },
                    v4_prompt: {
                        caption: {
                            base_caption: request.body.prompt ?? '',
                            char_captions: [],
                        },
                        use_coords: false,
                        use_order: true,
                    },
                },
            }),
        });

        if (!generateResult.ok) {
            const text = await generateResult.text();
            console.warn('NovelAI returned an error.', generateResult.statusText, text);
            return response.sendStatus(500);
        }

        const archiveBuffer = await generateResult.arrayBuffer();
        const imageBuffer = await extractFileFromZipBuffer(archiveBuffer, '.png');

        if (!imageBuffer) {
            console.error('NovelAI generated an image, but the PNG file was not found.');
            return response.sendStatus(500);
        }

        const originalBase64 = imageBuffer.toString('base64');

        // No upscaling
        if (isNaN(request.body.upscale_ratio) || request.body.upscale_ratio <= 1) {
            return response.send(originalBase64);
        }

        try {
            const upscaleUrl = `${API_NOVELAI}/ai/upscale`;
            const upscaleResult = await fetch(upscaleUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    image: originalBase64,
                    height: request.body.height,
                    width: request.body.width,
                    scale: request.body.upscale_ratio,
                }),
            });

            if (!upscaleResult.ok) {
                const text = await upscaleResult.text();
                throw new Error('NovelAI returned an error.', { cause: text });
            }

            const upscaledArchiveBuffer = await upscaleResult.arrayBuffer();
            const upscaledImageBuffer = await extractFileFromZipBuffer(upscaledArchiveBuffer, '.png');

            if (!upscaledImageBuffer) {
                throw new Error('NovelAI upscaled an image, but the PNG file was not found.');
            }

            const upscaledBase64 = upscaledImageBuffer.toString('base64');

            return response.send(upscaledBase64);
        } catch (error) {
            console.warn('NovelAI generated an image, but upscaling failed. Returning original image.', error);
            return response.send(originalBase64);
        }
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/generate-voice', async (request, response) => {
    const token = readSecret(request.user.directories, SECRET_KEYS.NOVEL);

    if (!token) {
        console.error('NovelAI Access Token is missing.');
        return response.sendStatus(400);
    }

    const text = request.body.text;
    const voice = request.body.voice;

    if (!text || !voice) {
        return response.sendStatus(400);
    }

    try {
        const url = `${API_NOVELAI}/ai/generate-voice?text=${encodeURIComponent(text)}&voice=-1&seed=${encodeURIComponent(voice)}&opus=false&version=v2`;
        const result = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'audio/mpeg',
            },
        });

        if (!result.ok) {
            const errorText = await result.text();
            console.error('NovelAI returned an error.', result.statusText, errorText);
            return response.sendStatus(500);
        }

        const chunks = await readAllChunks(result.body);
        const buffer = Buffer.concat(chunks.map(chunk => new Uint8Array(chunk)));
        response.setHeader('Content-Type', 'audio/mpeg');
        return response.send(buffer);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
