import express from 'express';

import { delay } from '../../util.js';
import { getOverrideHeaders, setAdditionalHeaders } from '../../additional-headers.js';
import { readSettingsFor, settingsContextOf } from '../../settings-reads.js';
import { resolveTokenizer, createTokenizerOutcome, sendTokenizerWarnings, tokenizerAnswer, tokenizerIdentity } from '../../tokenizer-resolve.js';
import { createStoredCounter, writeBack } from '../../token-count-store.js';
import { fetchKoboldStatus, koboldCanUseTokenization, koboldFlagsFor, koboldFlagsOf, lookupBackendModel, rememberKoboldFlags, rememberRemoteTokenization } from '../../backend-status.js';
import { resolveTextCompletionGenerationInput } from '../../text-completion-generation-input.js';
import { buildTextCompletionPrompt } from '../../prompt/text-prompt.js';
import { startItemizing } from '../../prompt-itemization.js';
import { generateTurnOf, textCompletionQuietInput } from '../../page-writes.js';
import { storeUserMessage, withStoredMessages } from '../../stored-messages.js';
import { readCardContent } from '../characters.js';
import { getGroupsByIds } from '../groups.js';
import { attachStoredReply, persistAssistantReply } from '../../assistant-reply-persist.js';
import { readReplyFinishSettings } from '../../reply-reasoning.js';
import { answerSessionOnHeaders, chatContext } from '../../chat-request.js';
import { withGenerationStop } from '../../generation-stop.js';
import { forwardAndPersistCompactStream } from './text-completions.js';
import { macroVariableChanges, storeMacroVariables } from '../../macro-facts.js';
import { fetchOutgoing } from '../../outgoing-fetch.js';

export const router = express.Router();

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {object} params
 * @param {import('express').Request} [params.request]
 * @param {string} [params.characterAvatar]
 * @param {string} [params.groupId]
 * @param {import('../../chat-request.js').ChatContext} params.chat
 * @param {string|null} params.nodeId
 * @param {string} [params.type]
 * @param {boolean} [params.isImpersonate]
 * @param {boolean} [params.isContinue]
 * @param {boolean} [params.isSwipe]
 * @param {string} [params.userMessageText]
 * @param {import('../../macro-facts.js').PageMacroFacts} [params.pageFacts]
 * @param {import('../../prompt/injections.js').PageInjections} [params.pageInjections]
 * @param {object} [params.userMessageExtra]
 * @param {object} [params.macroExtras]
 * @param {boolean} [params.dryRun] Builds the prompt without changing anything a send would.
 * @returns {Promise<{ params: object, prompt: string, anchorNodeId: string|null, anchorContent: object|null, activations: import('../../world-info/activation-record.js').ActivationRecord|null, tokenCountRows: import('../../token-count-store.js').PendingTokenRows, name1: string, name2: string, warnings: object[], itemize: () => Promise<import('../../prompt-itemization.js').PromptItemization> }>}
 */
export async function buildRawActionKoboldRequest(directories, {
    request, characterAvatar, groupId, chat, nodeId,
    type = 'normal', isImpersonate = false, isContinue = false, isSwipe = false, userMessageText, userMessageExtra, pageFacts = {}, pageInjections = {},
    tokenizerOptions = {}, macroExtras = {}, responseLength, dryRun = false,
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

    const {
        power_user: powerUser = {}, kai_settings: koboldSettings = {}, horde_settings: hordeSettings = {},
    } = readSettingsFor(directories, settingsContextOf({ avatar: characterAvatar, groupId, chat, nodeId }), ['power_user', 'kai_settings', 'horde_settings']);
    const url = koboldSettings.api_server ?? '';
    const tokenizerState = macroExtras.isHorde
        ? { api: 'koboldhorde', hordeModels: Array.isArray(hordeSettings.models) ? hordeSettings.models : [], tokenizerSetting: powerUser.tokenizer }
        : { api: 'kobold', url, model: '', tokenizerSetting: powerUser.tokenizer };
    const koboldFlags = macroExtras.isHorde ? {} : await koboldFlagsFor(url);
    const resolvedTokenizer = await resolveTokenizer(tokenizerState, { directories });
    const identity = await tokenizerIdentity(resolvedTokenizer);
    const tokenizerOutcome = createTokenizerOutcome();
    const encodeOptions = { request, koboldBaseUrl: url, ...tokenizerOptions, outcome: tokenizerOutcome };
    const storedCounter = createStoredCounter({ resolved: resolvedTokenizer, identity, directories, encodeOptions });
    const encodeTokens = storedCounter.encodeText;
    const countTokens = storedCounter.countText;

    const orchestratorInput = await resolveTextCompletionGenerationInput(directories, {
        avatar: characterAvatar, groupId, mainApi: 'kobold', chatContext: chat, nodeId,
        type, isImpersonate, isContinue, isSwipe, userMessageText, userMessageExtra, pageFacts, pageInjections,
        countTokens, encodeTokens, amountGen: responseLength, macroExtras: { ...macroExtras, koboldFlags, isDryRun: dryRun },
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
        params: assembled.generate_data, prompt: assembled.combinedPrompt, anchorNodeId, anchorContent, activations: assembled.activations, tokenCountRows: storedCounter.pending,
        name1: orchestratorInput.name1, name2: orchestratorInput.name2,
        warnings: sendTokenizerWarnings(tokenizerState, resolvedTokenizer, tokenizerOutcome, assembled.droppedEntries),
        macroVariables: macroVariableChanges(orchestratorInput.chatMetadata, orchestratorInput.macroFacts.globalVariables, orchestratorInput.variablesBefore),
        itemize: async () => ({ ...(await assembled.itemize()), tokenizer: tokenizerAnswer(tokenizerState, resolvedTokenizer, tokenizerOutcome) }),
    };
}

/**
 * A KoboldAI generation: from a turn of a stored chat (the page names it), or from a prompt the request carries.
 */
export const generateKobold = withGenerationStop(async function (request, response_generate) {
    if (!request.body) return response_generate.sendStatus(400);

    let pendingAssistantPersist = null;
    /** @type {Array<{kind: string, key: string, message: string, entries?: string[]}>} */
    const warnings = [];

    /** @type {import('../../token-count-store.js').PendingTokenRows | null} */
    let tokenCountRows = null;
    const storeTokenCountRows = () => {
        if (!tokenCountRows) return;
        const rows = tokenCountRows;
        tokenCountRows = null;
        Promise.resolve(pendingAssistantPersist?.itemization).catch(() => {})
            .then(() => writeBack(request.user.directories, rows))
            .catch(error => console.error('Failed to store token counts:', error));
    };

    if (request.body.owner_id && (request.body.character_avatar || request.body.group_id)) {
        const {
            character_avatar: characterAvatar, group_id: groupId,
            type = 'normal',
        } = request.body;
        const isImpersonate = type === 'impersonate';
        const isContinue = type === 'continue';
        const isSwipe = type === 'swipe' || type === 'regenerate';

        const directories = request.user.directories;
        const chat = await chatContext(request, { avatar: characterAvatar, group: groupId });
        if (!chat) {
            return response_generate.status(400).send({ error: true, message: groupId ? `Group not found: ${groupId}` : `Character not found: ${characterAvatar}` });
        }
        answerSessionOnHeaders(response_generate, chat.session);
        const turn = await generateTurnOf(response_generate, chat, request.body);
        if (!turn) return;
        const { nodeId, userMessageText, userMessageExtra, quiet, responseLength, pageFacts, pageInjections } = turn;

        let built;
        try {
            built = await buildRawActionKoboldRequest(directories, {
                request, characterAvatar, groupId, chat, nodeId,
                type, isImpersonate, isContinue, isSwipe, userMessageText, userMessageExtra, pageFacts, pageInjections, responseLength,
                macroExtras: textCompletionQuietInput(quiet),
            });
        } catch (error) {
            console.error('Failed to build raw-action Kobold request:', error);
            return response_generate.status(400).send({ error: true, message: error?.message ?? 'Could not resolve this generation request' });
        }
        warnings.push(...built.warnings);
        tokenCountRows = built.tokenCountRows;

        const skipPersistence = isImpersonate || type === 'quiet';
        let replyAnchorNodeId = built.anchorNodeId;
        const userMessage = turn.userMessage;
        if (!skipPersistence && typeof userMessageText === 'string') {
            const userNodeId = await storeUserMessage(response_generate, {
                chat, anchorNodeId: built.anchorNodeId, ref: request.body.user_message_ref,
                message: userMessage,
            });
            if (!userNodeId) return;
            replyAnchorNodeId = userNodeId;
        }
        await storeMacroVariables(response_generate, chat, nodeId, built.macroVariables);
        const continuesUserMessage = isContinue && replyAnchorNodeId !== built.anchorNodeId;
        if (!skipPersistence) {
            pendingAssistantPersist = {
                chat, anchorNodeId: replyAnchorNodeId, name2: built.name2,
                isSwipe, isContinue, anchorContent: continuesUserMessage ? userMessage : built.anchorContent,
                activations: built.activations,
                sentNodeId: replyAnchorNodeId !== built.anchorNodeId ? replyAnchorNodeId : null,
                warnings, generationStop: response_generate.locals.generationStop,
                itemization: startItemizing(built.itemize),
                finish: await readReplyFinishSettings(directories, {
                    mainApi: 'kobold', avatar: characterAvatar, groupId, name1: built.name1, name2: built.name2,
                    model: lookupBackendModel({ api: 'kobold', url: built.params?.api_server ?? '' }),
                }),
            };
            chat.session.actor();
        }

        request.body = built.params;
    }

    if (request.body.api_server.indexOf('localhost') != -1) {
        request.body.api_server = request.body.api_server.replace('localhost', '127.0.0.1');
    }

    const request_prompt = request.body.prompt;
    const controller = new AbortController();
    request.socket.removeAllListeners('close');
    request.socket.on('close', async function () {
        if (request.body.can_abort && !response_generate.writableEnded) {
            try {
                // send abort signal to koboldcpp
                const abortResponse = await fetchOutgoing(`${request.body.api_server}/extra/abort`, {
                    method: 'POST',
                });

                if (!abortResponse.ok) {
                    console.error('Error sending abort request to Kobold:', abortResponse.status);
                }
            } catch (error) {
                console.error(error);
            }
        }
        controller.abort();
    });

    let this_settings = {
        prompt: request_prompt,
        use_story: false,
        use_memory: false,
        use_authors_note: false,
        use_world_info: false,
        max_context_length: request.body.max_context_length,
        max_length: request.body.max_length,
    };

    if (!request.body.gui_settings) {
        this_settings = {
            prompt: request_prompt,
            use_story: false,
            use_memory: false,
            use_authors_note: false,
            use_world_info: false,
            max_context_length: request.body.max_context_length,
            max_length: request.body.max_length,
            rep_pen: request.body.rep_pen,
            rep_pen_range: request.body.rep_pen_range,
            rep_pen_slope: request.body.rep_pen_slope,
            temperature: request.body.temperature,
            tfs: request.body.tfs,
            top_a: request.body.top_a,
            top_k: request.body.top_k,
            top_p: request.body.top_p,
            min_p: request.body.min_p,
            typical: request.body.typical,
            sampler_order: request.body.sampler_order,
            singleline: !!request.body.singleline,
            use_default_badwordsids: request.body.use_default_badwordsids,
            mirostat: request.body.mirostat,
            mirostat_eta: request.body.mirostat_eta,
            mirostat_tau: request.body.mirostat_tau,
            grammar: request.body.grammar,
            sampler_seed: request.body.sampler_seed,
        };
        if (request.body.stop_sequence) {
            this_settings.stop_sequence = request.body.stop_sequence;
        }
    }

    const args = {
        body: JSON.stringify(this_settings),
        headers: Object.assign(
            { 'Content-Type': 'application/json' },
            getOverrideHeaders((new URL(request.body.api_server))?.host),
        ),
        signal: controller.signal,
    };

    const MAX_RETRIES = 50;
    const delayAmount = 2500;
    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            const url = request.body.streaming ? `${request.body.api_server}/extra/generate/stream` : `${request.body.api_server}/v1/generate`;
            const response = await fetchOutgoing(url, { method: 'POST', ...args });
            storeTokenCountRows();

            if (request.body.streaming) {
                await forwardAndPersistCompactStream(response, response_generate, pendingAssistantPersist, json => json?.token, null, warnings);
                return;
            } else {
                if (!response.ok) {
                    const errorText = await response.text();
                    console.warn(`Kobold returned error: ${response.status} ${response.statusText} ${errorText}`);

                    try {
                        const errorJson = JSON.parse(errorText);
                        const message = errorJson?.detail?.msg || errorText;
                        return response_generate.status(400).send({ error: { message } });
                    } catch {
                        return response_generate.status(400).send({ error: { message: errorText } });
                    }
                }

                const data = await response.json();

                if (pendingAssistantPersist) {
                    const generatedText = data?.results?.[0]?.text ?? '';
                    const persisted = await persistAssistantReply(pendingAssistantPersist, generatedText, { data });
                    attachStoredReply(data, persisted);
                }

                if (warnings.length) {
                    data.warnings = warnings;
                }

                return response_generate.send(withStoredMessages(data, response_generate));
            }
        } catch (error) {
            // response
            switch (error?.status) {
                case 403:
                case 503: // retry in case of temporary service issue, possibly caused by a queue failure?
                    console.warn(`KoboldAI is busy. Retry attempt ${i + 1} of ${MAX_RETRIES}...`);
                    await delay(delayAmount);
                    break;
                default:
                    if ('status' in error) {
                        console.error('Status Code from Kobold:', error.status);
                    }
                    return response_generate.send({ error: true });
            }
        }
    }

    console.error('Max retries exceeded. Giving up.');
    return response_generate.send({ error: true });
});

router.post('/generate', generateKobold);

router.post('/status', async function (request, response) {
    if (!request.body) return response.sendStatus(400);
    let api_server = request.body.api_server;
    if (api_server.indexOf('localhost') != -1) {
        api_server = api_server.replace('localhost', '127.0.0.1');
    }

    const args = {
        headers: { 'Content-Type': 'application/json' },
    };

    setAdditionalHeaders(request, args, api_server);

    const result = await fetchKoboldStatus(api_server);
    rememberRemoteTokenization('kobold', undefined, api_server, koboldCanUseTokenization(result.koboldCppVersion));
    if (result.model !== 'no_connection') rememberKoboldFlags(api_server, koboldFlagsOf(result));

    response.send(result);
});
