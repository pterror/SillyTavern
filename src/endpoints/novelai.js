import express from 'express';

import { readSecret, SECRET_KEYS } from './secrets.js';
import { readSettingsFor, settingsContextOf } from '../settings-reads.js';
import { resolveTokenizer, createTokenizerOutcome, sendTokenizerWarnings, tokenizerAnswer, tokenizerIdentity } from '../tokenizer-resolve.js';
import { createStoredCounter, writeBack } from '../token-count-store.js';
import { tokenizers } from '../tokenizer-ids.js';
import { resolveTextCompletionGenerationInput } from '../text-completion-generation-input.js';
import { buildTextCompletionPrompt } from '../prompt/text-prompt.js';
import { startItemizing } from '../prompt-itemization.js';
import { generateTurnOf, textCompletionQuietInput } from '../page-writes.js';
import { storeUserMessage, withStoredMessages } from '../stored-messages.js';
import { readCardContent } from './characters.js';
import { getGroupsByIds } from './groups.js';
import { attachStoredReply, persistAssistantReply } from '../assistant-reply-persist.js';
import { readReplyFinishSettings } from '../reply-reasoning.js';
import { answerSessionOnHeaders, chatContext } from '../chat-request.js';
import { withGenerationStop } from '../generation-stop.js';
import { forwardAndPersistCompactStream } from './backends/text-completions.js';
import { macroVariableChanges, storeMacroVariables } from '../macro-facts.js';
import { fetchOutgoing } from '../outgoing-fetch.js';

const API_NOVELAI = 'https://api.novelai.net';
const TEXT_NOVELAI = 'https://text.novelai.net';
const IMAGE_NOVELAI = 'https://image.novelai.net';

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

export const router = express.Router();

router.post('/status', async function (req, res) {
    if (!req.body) return res.sendStatus(400);
    const api_key_novel = readSecret(req.user.directories, SECRET_KEYS.NOVEL);

    if (!api_key_novel) {
        console.warn('NovelAI Access Token is missing.');
        return res.sendStatus(400);
    }

    try {
        const response = await fetchOutgoing(IMAGE_NOVELAI + '/user/subscription', {
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
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {object} params
 * @param {import('express').Request} [params.request]
 * @param {string} [params.characterAvatar]
 * @param {string} [params.groupId]
 * @param {import('../chat-request.js').ChatContext} params.chat
 * @param {string|null} params.nodeId
 * @param {string} [params.type]
 * @param {boolean} [params.isImpersonate]
 * @param {boolean} [params.isContinue]
 * @param {boolean} [params.isSwipe]
 * @param {string} [params.userMessageText]
 * @param {import('../macro-facts.js').PageMacroFacts} [params.pageFacts]
 * @param {import('../prompt/injections.js').PageInjections} [params.pageInjections]
 * @param {object} [params.userMessageExtra]
 * @param {boolean} [params.dryRun] Builds the prompt without changing anything a send would.
 * @returns {Promise<{ params: object, prompt: string, anchorNodeId: string|null, anchorContent: object|null, activations: import('../world-info/activation-record.js').ActivationRecord|null, tokenCountRows: import('../token-count-store.js').PendingTokenRows, name1: string, name2: string, warnings: object[], itemize: () => Promise<import('../prompt-itemization.js').PromptItemization> }>}
 */
export async function buildRawActionNovelRequest(directories, {
    request, characterAvatar, groupId, chat, nodeId,
    type = 'normal', isImpersonate = false, isContinue = false, isSwipe = false, userMessageText, userMessageExtra, pageFacts = {}, pageInjections = {},
    tokenizerOptions = {}, quiet = {}, responseLength, dryRun = false,
} = {}) {
    if (!characterAvatar && !groupId) {
        throw new Error('character_avatar or group_id is required');
    }
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
        const group = (await getGroupsByIds(directories, [groupId]))[groupId];
        if (!group) {
            throw new Error(`Group not found: ${groupId}`);
        }
    }

    let anchorNodeId = null;
    if (nodeId !== null) {
        if (!await chat.store.chats.messageOf(chat.tree, nodeId)) {
            throw new Error(`Chat node not found: ${nodeId}`);
        }
        anchorNodeId = nodeId;
    }

    const { nai_settings: naiSettings = {}, power_user: powerUser = {} } = readSettingsFor(directories, settingsContextOf({ avatar: characterAvatar, groupId, chat, nodeId }), ['nai_settings', 'power_user']);
    const tokenizerState = { api: 'novel', model: naiSettings.model_novel ?? '', tokenizerSetting: powerUser.tokenizer };
    const resolvedTokenizer = await resolveTokenizer(tokenizerState, { directories });
    const identity = await tokenizerIdentity(resolvedTokenizer);
    const tokenizerOutcome = createTokenizerOutcome();
    const encodeOptions = { request, ...tokenizerOptions, outcome: tokenizerOutcome };
    const storedCounter = createStoredCounter({ resolved: resolvedTokenizer, identity, directories, encodeOptions });
    const encodeTokens = storedCounter.encodeText;
    const countTokens = storedCounter.countText;
    const encodeTokensByType = (_tokenizerType, text) => encodeTokens(text);
    const novelTokenizerType = resolvedTokenizer.kind === 'estimate' ? tokenizers.NONE : resolvedTokenizer.id;

    const orchestratorInput = await resolveTextCompletionGenerationInput(directories, {
        avatar: characterAvatar, groupId, mainApi: 'novel', chatContext: chat, nodeId,
        type, isImpersonate, isContinue, isSwipe, userMessageText, userMessageExtra, pageFacts, pageInjections,
        countTokens, encodeTokens, amountGen: responseLength,
        macroExtras: { encodeTokensByType, novelTokenizerType, ...textCompletionQuietInput(quiet), isDryRun: dryRun },
    });

    if (nodeId === null) {
        if (orchestratorInput.chatResolutionAmbiguous) {
            throw new Error('node_id is required: this chat is not at its start - pass the node_id of the message to generate from (null is only valid in a new chat)');
        }
        anchorNodeId = orchestratorInput.resolvedNodeId;
    }

    if ((isContinue || isSwipe) && orchestratorInput.chat.length === 0) {
        throw new Error('Cannot continue/swipe an empty chat.');
    }

    const assembled = await buildTextCompletionPrompt(orchestratorInput);
    const anchorContent = orchestratorInput.chat.length > 0 ? orchestratorInput.chat[orchestratorInput.chat.length - 1] : null;

    return {
        params: { ...assembled.generate_data, streaming: Boolean(naiSettings.streaming_novel) && type !== 'quiet' },
        prompt: assembled.combinedPrompt,
        anchorNodeId, anchorContent, activations: assembled.activations, tokenCountRows: storedCounter.pending,
        name1: orchestratorInput.name1, name2: orchestratorInput.name2,
        warnings: sendTokenizerWarnings(tokenizerState, resolvedTokenizer, tokenizerOutcome, assembled.droppedEntries),
        macroVariables: macroVariableChanges(orchestratorInput.chatMetadata, orchestratorInput.macroFacts.globalVariables, orchestratorInput.variablesBefore),
        itemize: async () => ({ ...(await assembled.itemize()), tokenizer: tokenizerAnswer(tokenizerState, resolvedTokenizer, tokenizerOutcome) }),
    };
}

/**
 * A NovelAI generation: from a turn of a stored chat (the page names it), or from a prompt the request carries.
 */
export const generateNovel = withGenerationStop(async function (req, res) {
    if (!req.body) return res.sendStatus(400);

    let pendingAssistantPersist = null;
    /** @type {Array<{kind: string, key: string, message: string, entries?: string[]}>} */
    const warnings = [];
    /** @type {import('../token-count-store.js').PendingTokenRows | null} */
    let tokenCountRows = null;
    if (req.body.owner_id && (req.body.character_avatar || req.body.group_id)) {
        const {
            character_avatar: characterAvatar, group_id: groupId,
            type = 'normal',
        } = req.body;
        const isImpersonate = type === 'impersonate';
        const isContinue = type === 'continue';
        const isSwipe = type === 'swipe' || type === 'regenerate';

        const directories = req.user.directories;
        const chat = await chatContext(req, { avatar: characterAvatar, group: groupId });
        if (!chat) {
            return res.status(400).send({ error: true, message: groupId ? `Group not found: ${groupId}` : `Character not found: ${characterAvatar}` });
        }
        answerSessionOnHeaders(res, chat.session);
        const turn = await generateTurnOf(res, chat, req.body);
        if (!turn) return;
        const { nodeId, userMessageText, userMessageExtra, quiet, responseLength, pageFacts, pageInjections } = turn;

        let built;
        try {
            built = await buildRawActionNovelRequest(directories, {
                request: req, characterAvatar, groupId, chat, nodeId,
                type, isImpersonate, isContinue, isSwipe, userMessageText, userMessageExtra, quiet, responseLength, pageFacts, pageInjections,
            });
        } catch (error) {
            console.error('Failed to build raw-action NovelAI request:', error);
            return res.status(400).send({ error: true, message: error?.message ?? 'Could not resolve this generation request' });
        }
        warnings.push(...built.warnings);
        tokenCountRows = built.tokenCountRows;

        const skipPersistence = isImpersonate || type === 'quiet';
        let replyAnchorNodeId = built.anchorNodeId;
        const userMessage = turn.userMessage;
        if (!skipPersistence && typeof userMessageText === 'string') {
            const userNodeId = await storeUserMessage(res, {
                chat, anchorNodeId: built.anchorNodeId, ref: req.body.user_message_ref,
                message: userMessage,
            });
            if (!userNodeId) return;
            replyAnchorNodeId = userNodeId;
        }
        await storeMacroVariables(res, chat, nodeId, built.macroVariables);
        const continuesUserMessage = isContinue && replyAnchorNodeId !== built.anchorNodeId;
        if (!skipPersistence) {
            pendingAssistantPersist = {
                chat, anchorNodeId: replyAnchorNodeId, name2: built.name2,
                isSwipe, isContinue, anchorContent: continuesUserMessage ? userMessage : built.anchorContent,
                activations: built.activations,
                sentNodeId: replyAnchorNodeId !== built.anchorNodeId ? replyAnchorNodeId : null,
                warnings, generationStop: res.locals.generationStop,
                itemization: startItemizing(built.itemize),
                finish: await readReplyFinishSettings(req.user.directories, {
                    mainApi: 'novel', avatar: characterAvatar, groupId, name1: built.name1, name2: built.name2,
                    model: built.params?.model ?? null,
                }),
            };
            chat.session.actor();
        }

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

    const args = {
        body: JSON.stringify(data),
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + api_key_novel },
        signal: controller.signal,
    };

    try {
        const baseURL = (req.body.model.includes('kayra') || req.body.model.includes('erato')) ? TEXT_NOVELAI : API_NOVELAI;
        const url = req.body.streaming ? `${baseURL}/ai/generate-stream` : `${baseURL}/ai/generate`;
        const response = await fetchOutgoing(url, { method: 'POST', ...args });
        if (tokenCountRows) {
            const rows = tokenCountRows;
            Promise.resolve(pendingAssistantPersist?.itemization).catch(() => {})
                .then(() => writeBack(req.user.directories, rows))
                .catch(error => console.error('Failed to store token counts:', error));
        }

        if (req.body.streaming) {
            await forwardAndPersistCompactStream(response, res, pendingAssistantPersist, json => json?.token, json => json?.logprobs, warnings);
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

            if (pendingAssistantPersist) {
                const generatedText = data?.output ?? '';
                const persisted = await persistAssistantReply(pendingAssistantPersist, generatedText, { data });
                attachStoredReply(data, persisted);
            }
            if (warnings.length) {
                data.warnings = warnings;
            }

            return res.send(withStoredMessages(data, res));
        }
    } catch (error) {
        return res.send({ error: true });
    }
});

router.post('/generate', generateNovel);
