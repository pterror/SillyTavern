import fetch from 'node-fetch';
import express from 'express';
import _ from 'lodash';

import {
    TEXTGEN_TYPES,
    TOGETHERAI_KEYS,
    OLLAMA_KEYS,
    INFERMATICAI_KEYS,
    OPENROUTER_KEYS,
    VLLM_KEYS,
    FEATHERLESS_KEYS,
    OPENAI_KEYS,
} from '../../constants.js';
import { forwardFetchResponse, trimV1, getConfigValue } from '../../util.js';
import { setAdditionalHeaders } from '../../additional-headers.js';
import { createHash } from 'node:crypto';
import { pipeLlamaCppCompactStream, getLlamaCppStreamMeta, createBackpressureWriter, createGenerationRecord, createResumableWriter, detachFromResponse, handleGenerationResume, encodeContent, encodeStoredReplyFrame, encodeIndexFrame, encodeReasoningFrame, encodeProbabilitiesFrame, encodeControlFrame, writeStoredMessagesFrame } from './llamacpp-compact-stream.js';
import { resolveTextGenBackend, resolveServerUrl } from '../../textgen-backend-resolve.js';
import { resolveConnectionProfile } from '../../connection-profile-resolve.js';
import { mergeTextGenPreset } from '../../textgen-preset-merge.js';
import { createTextGenGenerationData } from '../../textgen-generation-data.js';
import { constructPrompt, getInstructStoppingSequences } from '../../instruct-template-format.js';
import { readSettingsFor, settingsContextOf } from '../../settings-reads.js';
import { readBundle } from '../../bundle-store.js';
import { resolveTokenizer, encodeWithTokenizer, resolveProfileTokenizerSetting, createTokenizerOutcome, sendTokenizerWarnings, tokenizerAnswer, tokenizerIdentity } from '../../tokenizer-resolve.js';
import { createLlamaCppPropsCheck, llamaCppPropsModelName } from '../../llamacpp-props.js';
import { createStoredCounter, writeBack } from '../../token-count-store.js';
import { fetchTextgenStatus, lookupBackendModel, rememberRemoteTokenization } from '../../backend-status.js';
import { rememberOpenRouterModels } from '../../openrouter-models.js';
import { resolveTextCompletionGenerationInput } from '../../text-completion-generation-input.js';
import { buildTextCompletionPrompt } from '../../prompt/text-prompt.js';
import { startItemizing } from '../../prompt-itemization.js';
import { generateTurnOf, textCompletionQuietInput } from '../../page-writes.js';
import { storeUserMessage, withStoredMessages } from '../../stored-messages.js';
import { readCardContent } from '../characters.js';
import { getGroupsByIds } from '../groups.js';
import { attachStoredReply, persistAssistantReply, replyTextAsPageShows, unreadableReplyWarning } from '../../assistant-reply-persist.js';
import { noteReplyReasoning, noteReplyText, readReplyFinishSettings } from '../../reply-reasoning.js';
import { answerSessionOnHeaders, chatContext } from '../../chat-request.js';
import { logBackendFailure } from '../../backend-unreachable.js';
import { withGenerationStop, generationIdFor, isGenerationStopped, onGenerationStop, onGenerationStopFlush, stoppableController, handleGenerationStop } from '../../generation-stop.js';
import { macroVariableChanges, storeMacroVariables } from '../../macro-facts.js';

export const router = express.Router();

/**
 * Re-shapes Ollama's own JSON-lines generation stream (`{"response": "...", "thinking": "..."}` per
 * line, NOT SSE) into the same compact binary wire format (llamacpp-compact-stream.js,
 * X-ST-Stream-Format: compact-v1) every other raw-action streaming path in this file uses - unlike
 * those, this always re-encodes (there is no "forward the upstream bytes untouched" fallback here:
 * Ollama's own wire shape was never SSE-JSON to begin with, so a caller with `persist` unset still
 * gets the exact same compact re-shaping, just without the persistence side effect).
 *
 * `persist` (`pendingAssistantPersist`, see the `/generate` route below) is OPTIONAL: when set, this
 * accumulates `json.response` into a running buffer and persists it via `persistAssistantReply()`
 * once the stream ends (or the client disconnects early - whatever was generated so far is still a
 * real, if partial, reply, not nothing), writing the resulting `assistant_node_id` frame last, same
 * as `forwardAndPersistCompactStream()`.
 * @param {import('node-fetch').Response} jsonStream JSON stream
 * @param {import('express').Request} request Express request
 * @param {import('express').Response} response Express response
 * @param {object} [persist] `pendingAssistantPersist` - see above.
 * @param {Array<{kind: string, key: string, message: string, entries?: string[]}>|null} [warnings] The
 * `/generate` route's per-request warnings - when non-empty, written as their own control frame
 * (`{control: {warnings: ...}}`) before any content.
 * @returns {Promise<any>} Nothing valuable
 */
async function parseOllamaStream(jsonStream, request, response, persist, warnings = null) {
    /** @type {() => void} */
    let done = () => { };
    const finished = new Promise(resolve => { done = () => resolve(undefined); });
    try {
        if (!jsonStream.body) {
            throw new Error('No body in the response');
        }

        response.setHeader('X-ST-Stream-Format', 'compact-v1');
        const generationId = generationIdFor(response);
        response.setHeader('X-Generation-Id', generationId);
        const generationRecord = createGenerationRecord(generationId);
        const { writer: initialWriter, stopKeepalive } = createResumableWriter(createBackpressureWriter(response), generationRecord);
        writeStoredMessagesFrame(initialWriter, response);
        if (warnings?.length) {
            initialWriter.write(encodeControlFrame({ warnings }));
        }
        let writer = initialWriter;

        let partialData = '';
        let accumulatedText = '';
        let settled = false;

        const finishPersist = () => {
            if (settled) return;
            settled = true;
            if (persist && accumulatedText) {
                persistAssistantReply(persist, accumulatedText)
                    .then(persisted => {
                        const frame = encodeStoredReplyFrame(persisted, persist);
                        if (frame) writer.write(frame);
                    })
                    .catch(error => console.error('Failed to persist streamed Ollama assistant reply:', error))
                    .finally(() => {
                        writer.end();
                        done();
                    });
            } else {
                writer.end();
                done();
            }
        };

        jsonStream.body.on('data', (data) => {
            if (isGenerationStopped(response)) return;
            const chunk = data.toString();
            partialData += chunk;
            while (true) {
                let json;
                try {
                    json = JSON.parse(partialData);
                } catch (e) {
                    break;
                }
                const text = json.response || '';
                const thinking = json.thinking || '';
                if (thinking) noteReplyReasoning(persist, thinking);
                if (persist) {
                    accumulatedText += text;
                    noteReplyText(persist, accumulatedText);
                }
                if (thinking) writer.write(encodeReasoningFrame(thinking));
                if (text) writer.write(encodeContent(text));
                partialData = '';
            }
        });

        request.socket.on('close', function () {
            stopKeepalive();
            writer = detachFromResponse(generationRecord);
        });

        jsonStream.body.on('end', () => {
            finishPersist();
        });
        jsonStream.body.on('error', () => {
            finishPersist();
        });
        await finished;
    } catch (error) {
        console.error('Error forwarding streaming response:', error);
        if (!response.headersSent) {
            return response.status(500).send({ error: true });
        } else {
            return response.end();
        }
    }
}

/**
 * @param {import('node-fetch').Response} fetchResponse
 * @param {import('express').Response} response
 * @param {object|null|undefined} persist
 * @param {(json: any) => string|undefined} extractText
 * @param {((json: any) => any)|null} [extractProbabilities]
 * @param {Array<{kind: string, key: string, message: string, entries?: string[]}>|null} [warnings]
 * @returns {Promise<void>}
 */
export async function forwardAndPersistCompactStream(fetchResponse, response, persist, extractText, extractProbabilities = null, warnings = null) {
    if (!fetchResponse.ok || !fetchResponse.body) {
        return forwardFetchResponse(fetchResponse, response);
    }

    let statusCode = fetchResponse.status;
    if (statusCode === 401) statusCode = 400;
    response.statusCode = statusCode;
    response.statusMessage = fetchResponse.statusText;
    response.setHeader('X-ST-Stream-Format', 'compact-v1');
    const generationId = generationIdFor(response);
    response.setHeader('X-Generation-Id', generationId);

    let sseBuffer = '';
    let text = '';
    let lastIndex = 0;

    const generationRecord = createGenerationRecord(generationId);
    const { writer: initialWriter, stopKeepalive } = createResumableWriter(createBackpressureWriter(response), generationRecord);
    let writer = initialWriter;
    writeStoredMessagesFrame(writer, response);
    if (warnings?.length) {
        writer.write(encodeControlFrame({ warnings }));
    }
    const safeWrite = (chunk) => writer.write(chunk);

    const onSocketClose = () => {
        stopKeepalive();
        writer = detachFromResponse(generationRecord);
    };
    response.socket?.once('close', onSocketClose);

    const COALESCE_BYTES = 256;
    const COALESCE_MS = 40;
    let pendingContent = Buffer.alloc(0);
    let firstContentSent = false;
    let flushTimer = null;

    const flushPendingContent = () => {
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        if (pendingContent.length) {
            safeWrite(pendingContent);
            pendingContent = Buffer.alloc(0);
        }
    };

    const emitContent = (chunkText) => {
        const encoded = encodeContent(chunkText);
        if (!encoded.length) return;
        if (!firstContentSent) {
            firstContentSent = true;
            safeWrite(encoded);
            return;
        }
        pendingContent = pendingContent.length ? Buffer.concat([pendingContent, encoded]) : encoded;
        if (pendingContent.length >= COALESCE_BYTES) {
            flushPendingContent();
        } else if (!flushTimer) {
            flushTimer = setTimeout(flushPendingContent, COALESCE_MS);
        }
    };

    const handleEvent = (json) => {
        const index = json?.choices?.[0]?.index;
        if (typeof index === 'number' && index !== lastIndex) {
            lastIndex = index;
            flushPendingContent();
            safeWrite(encodeIndexFrame(index));
        }

        const reasoning = json?.choices?.[0]?.reasoning ?? json?.choices?.[0]?.thinking;
        if (reasoning) {
            noteReplyReasoning(persist, reasoning);
            flushPendingContent();
            safeWrite(encodeReasoningFrame(reasoning));
        }

        const probabilities = extractProbabilities?.(json);
        if (probabilities) {
            flushPendingContent();
            safeWrite(encodeProbabilitiesFrame(probabilities));
        }

        const chunkText = extractText(json) ?? '';
        if (chunkText) {
            text += chunkText;
            if (persist) noteReplyText(persist, text);
            emitContent(chunkText);
        }
    };

    const processLine = (rawLine) => {
        if (isGenerationStopped(response)) return;
        const trimmed = rawLine.trim();
        if (!trimmed.startsWith('data:')) return;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        try {
            handleEvent(JSON.parse(payload));
        } catch (error) {
            console.warn('Failed to parse streamed SSE event while accumulating text for persistence (compact stream):', error);
        }
    };

    onGenerationStopFlush(response, flushPendingContent);

    await new Promise((resolve) => {
        fetchResponse.body.on('data', (chunk) => {
            sseBuffer += chunk.toString('utf-8');
            let idx;
            while ((idx = sseBuffer.indexOf('\n')) !== -1) {
                const rawLine = sseBuffer.slice(0, idx);
                sseBuffer = sseBuffer.slice(idx + 1);
                processLine(rawLine);
            }
        });
        fetchResponse.body.once('end', resolve);
        fetchResponse.body.once('error', resolve);
        fetchResponse.body.once('close', resolve);
    });

    if (sseBuffer) {
        processLine(sseBuffer);
    }

    flushPendingContent();

    if (persist && text) {
        const persisted = await persistAssistantReply(persist, text);
        const frame = encodeStoredReplyFrame(persisted, persist);
        if (frame) safeWrite(frame);
    }

    response.socket?.off('close', onSocketClose);
    writer.end();
}

/**
 * Abort KoboldCpp generation request.
 * @param {import('express').Request} request the generation request
 * @param {string} url Server base URL
 * @returns {Promise<void>} Promise resolving when we are done
 */
async function abortKoboldCppRequest(request, url) {
    try {
        const args = {
            method: 'POST',
            headers: {},
        };

        setAdditionalHeaders(request, args, url);
        const abortResponse = await fetch(`${url}/api/extra/abort`, args);

        if (!abortResponse.ok) {
            console.error('Error sending abort request to Kobold:', abortResponse.status, abortResponse.statusText);
        }
    } catch (error) {
        console.error(error);
    }
}

//************** Ooba/OpenAI text completions API
router.post('/status', async function (request, response) {
    if (!request.body) return response.sendStatus(400);

    try {
        if (request.body.api_server.indexOf('localhost') !== -1) {
            request.body.api_server = request.body.api_server.replace('localhost', '127.0.0.1');
        }

        const baseUrl = trimV1(request.body.api_server);

        const args = {
            headers: { 'Content-Type': 'application/json' },
        };

        setAdditionalHeaders(request, args, baseUrl);

        const apiType = request.body.api_type;
        const status = await fetchTextgenStatus(baseUrl, apiType, args);

        if (!status.ok) {
            return response.sendStatus(400);
        }

        if (apiType === TEXTGEN_TYPES.OOBA) {
            rememberRemoteTokenization('textgenerationwebui', apiType, baseUrl, status.supportsTokenization);
        }

        if (apiType === TEXTGEN_TYPES.OPENROUTER) {
            rememberOpenRouterModels(status.data);
        }

        if (status.supportsTokenization) {
            response.setHeader('x-supports-tokenization', 'true');
        }

        return response.send({ result: status.result, data: status.data });
    } catch (error) {
        logBackendFailure(request.body.api_server, error, () => console.error(error));
        return response.sendStatus(500);
    }
});

router.post('/props', async function (request, response) {
    if (!request.body.api_server) return response.sendStatus(400);

    try {
        const baseUrl = trimV1(request.body.api_server);
        const args = {
            headers: {},
        };

        setAdditionalHeaders(request, args, baseUrl);

        const apiType = request.body.api_type;
        let propsUrl = baseUrl + '/props';
        if (apiType === TEXTGEN_TYPES.LLAMACPP && request.body.model) {
            propsUrl += `?model=${encodeURIComponent(request.body.model)}`;
        }
        const propsReply = await fetch(propsUrl, args);

        if (!propsReply.ok) {
            return response.sendStatus(400);
        }

        /** @type {any} */
        const props = await propsReply.json();
        // TEMPORARY: llama.cpp's /props endpoint has a bug which replaces the last newline with a \0
        if (apiType === TEXTGEN_TYPES.LLAMACPP && props.chat_template && props.chat_template.endsWith('\u0000')) {
            props.chat_template = props.chat_template.slice(0, -1) + '\n';
        }
        props.chat_template_hash = createHash('sha256').update(props.chat_template).digest('hex');
        return response.send(props);
    } catch (error) {
        logBackendFailure(request.body.api_server, error, () => console.error(error));
        return response.sendStatus(500);
    }
});

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
 * @param {import('../../page-writes.js').QuietPrompt} [params.quiet]
 * @returns {Promise<{ params: object, backend: {type: string, serverUrl: string, model: string|undefined}, anchorNodeId: string|null, anchorContent: object|null, activations: import('../../world-info/activation-record.js').ActivationRecord|null, tokenizerIdentity: string|null, tokenCountRows: import('../../token-count-store.js').PendingTokenRows, name1: string, name2: string, warnings: object[], itemize: () => Promise<import('../../prompt-itemization.js').PromptItemization> }>}
 */
export async function buildRawActionTextCompletionRequest(directories, {
    request, characterAvatar, groupId, chat, nodeId,
    type = 'normal', isImpersonate = false, isContinue = false, isSwipe = false, userMessageText, userMessageExtra, pageFacts = {}, pageInjections = {},
    tokenizerOptions = {}, quiet = {}, responseLength,
} = {}) {
    if (!characterAvatar && !groupId) {
        throw new Error('character_avatar or group_id is required');
    }
    if (nodeId === undefined) {
        throw new Error('node_id is required (pass null explicitly for a brand-new, empty conversation)');
    }

    const settingsContext = settingsContextOf({ avatar: characterAvatar, groupId, chat, nodeId });
    const backend = resolveTextGenBackend(directories, settingsContext);

    if (characterAvatar) {
        let raw;
        try {
            raw = await readCardContent(directories, characterAvatar);
        } catch { /* treated as not-found below, matching resolveSpeakers()'s convention */ }
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

    const { power_user: powerUser = {} } = readSettingsFor(directories, settingsContext, ['power_user']);
    const tokenizerState = {
        api: 'textgenerationwebui', type: backend.type, url: backend.serverUrl, model: backend.model ?? '',
        tokenizerSetting: powerUser.tokenizer,
    };
    const llamaCppProps = createLlamaCppPropsCheck({ reuse: false });
    const resolvedTokenizer = await resolveTokenizer(tokenizerState, { directories, llamaCppProps });
    const identity = await tokenizerIdentity(resolvedTokenizer, { textgenApiType: backend.type, llamaCppProps: llamaCppProps.props });
    const tokenizerOutcome = createTokenizerOutcome();
    const encodeOptions = {
        request, textgenBaseUrl: backend.serverUrl, textgenModel: backend.model, textgenApiType: backend.type,
        ...tokenizerOptions, outcome: tokenizerOutcome,
    };
    const storedCounter = createStoredCounter({
        resolved: resolvedTokenizer, identity, directories, encodeOptions,
        identityFacts: { textgenApiType: backend.type, llamaCppProps: llamaCppProps.props },
    });
    const encodeTokens = storedCounter.encodeText;
    const countTokens = storedCounter.countText;
    const countPromptTokens = storedCounter.countPromptText;

    const orchestratorInput = await resolveTextCompletionGenerationInput(directories, {
        avatar: characterAvatar, groupId, chatContext: chat, nodeId,
        type, isImpersonate, isContinue, isSwipe, userMessageText, userMessageExtra, pageFacts, pageInjections,
        countTokens, encodeTokens, countPromptTokens, amountGen: responseLength, macroExtras: textCompletionQuietInput(quiet),
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
        params: assembled.generate_data, backend, anchorNodeId, anchorContent, activations: assembled.activations, tokenizerIdentity: identity,
        macroVariables: macroVariableChanges(orchestratorInput.chatMetadata, orchestratorInput.macroFacts.globalVariables, orchestratorInput.variablesBefore),
        model: backend.model
            ?? (llamaCppProps.props ? llamaCppPropsModelName(llamaCppProps.props) : undefined)
            ?? lookupBackendModel({ api: 'textgenerationwebui', type: backend.type, url: backend.serverUrl, directories }),
        tokenCountRows: storedCounter.pending,
        name1: orchestratorInput.name1, name2: orchestratorInput.name2,
        warnings: sendTokenizerWarnings(tokenizerState, resolvedTokenizer, tokenizerOutcome, assembled.droppedEntries),
        itemize: async () => ({ ...(await assembled.itemize()), tokenizer: tokenizerAnswer(tokenizerState, resolvedTokenizer, tokenizerOutcome) }),
    };
}

router.post('/generate', withGenerationStop(async function (request, response) {
    if (!request.body) return response.sendStatus(400);

    let pendingAssistantPersist = null;

    /** @type {Array<{kind: string, key: string, message: string, entries?: string[]}>} */
    const warnings = [];

    /** @type {import('../../token-count-store.js').PendingTokenRows | null} */
    let tokenCountRows = null;
    const storeTokenCountRows = () => {
        if (!tokenCountRows) return;
        writeBack(request.user.directories, tokenCountRows)
            .catch(error => console.error('Failed to store token counts:', error));
    };

    try {
        if (request.body.connection_profile_id) {
            const { profile, selectedApiMap } = resolveConnectionProfile(request.user.directories, request.body.connection_profile_id);
            if (selectedApiMap.selected !== 'textgenerationwebui') {
                return response.status(400).send({ error: true, message: `Profile does not target a text completion backend (targets: ${selectedApiMap.selected})` });
            }

            const { name1 = '', name2 = '', isGroup = false, messages, max_tokens: maxTokens, isImpersonate = false, isContinue = false, type = 'quiet' } = request.body;
            if (!Array.isArray(messages)) {
                return response.status(400).send({ error: true, message: 'messages must be an array' });
            }

            const instructPreset = profile.instruct ? await readBundle(request.user.directories, 'template.instruct', profile.instruct) : null;
            const contextPreset = profile.context ? await readBundle(request.user.directories, 'template.context', profile.context) : null;
            const finalPrompt = instructPreset
                ? constructPrompt(messages, instructPreset, { name1, name2, isGroup })
                : messages.map(m => m.content).join('\n\n');
            const stoppingStrings = instructPreset
                ? getInstructStoppingSequences(instructPreset, contextPreset ?? {}, { name1, name2 })
                : [];

            const { 'textgenerationwebui_settings': baseSettings, power_user: powerUser = {} } = readSettingsFor(request.user.directories, settingsContextOf({}), ['textgenerationwebui_settings', 'power_user']);
            const preset = profile.preset ? await readBundle(request.user.directories, 'preset.textgenerationwebui', profile.preset) : null;
            const settings = mergeTextGenPreset({ ...baseSettings, type: selectedApiMap.type }, preset);

            const apiServerUrl = profile['api-url'] || resolveServerUrl(settings);

            const tokenizerState = {
                api: 'textgenerationwebui', type: selectedApiMap.type, url: apiServerUrl, model: profile.model ?? '',
                tokenizerSetting: resolveProfileTokenizerSetting(profile.tokenizer, powerUser.tokenizer),
            };
            const resolvedTokenizer = await resolveTokenizer(tokenizerState, { directories: request.user.directories });
            const tokenizerOutcome = createTokenizerOutcome();
            const encodeOptions = {
                request, textgenBaseUrl: apiServerUrl, textgenModel: profile.model, textgenApiType: selectedApiMap.type,
                outcome: tokenizerOutcome,
            };
            /** @type {string[]} */
            const droppedBiasEntries = [];

            const params = await createTextGenGenerationData(
                settings, profile.model, finalPrompt, maxTokens, isImpersonate, isContinue, null, type,
                {
                    stoppingStrings, macroContext: { name1, name2 },
                    logitBiasContext: {
                        encode: (text) => encodeWithTokenizer(resolvedTokenizer, text, encodeOptions),
                        dropped: droppedBiasEntries,
                    },
                },
            );
            warnings.push(...sendTokenizerWarnings(tokenizerState, resolvedTokenizer, tokenizerOutcome, droppedBiasEntries));

            if (request.body.overrides && typeof request.body.overrides === 'object' && !Array.isArray(request.body.overrides)) {
                Object.assign(params, _.omit(request.body.overrides, ['api_type', 'api_server', 'model', 'prompt', 'stop', 'stopping_strings']));
            }

            const stream = !!request.body.stream;
            request.body = { ...params, stream, api_type: selectedApiMap.type, api_server: apiServerUrl };
        } else if (request.body.owner_id && (request.body.character_avatar || request.body.group_id)) {
            const {
                character_avatar: characterAvatar, group_id: groupId, type = 'normal',
            } = request.body;
            const isImpersonate = type === 'impersonate';
            const isContinue = type === 'continue';
            const isSwipe = type === 'swipe' || type === 'regenerate';

            const directories = request.user.directories;
            const chat = await chatContext(request, { avatar: characterAvatar, group: groupId });
            if (!chat) {
                return response.status(400).send({ error: true, message: groupId ? `Group not found: ${groupId}` : `Character not found: ${characterAvatar}` });
            }
            answerSessionOnHeaders(response, chat.session);
            const turn = await generateTurnOf(response, chat, request.body);
            if (!turn) return;
            const { nodeId, userMessageText, userMessageExtra, quiet, responseLength, pageFacts, pageInjections } = turn;

            /** @type {Awaited<ReturnType<typeof buildRawActionTextCompletionRequest>>} */
            let built;
            try {
                built = await buildRawActionTextCompletionRequest(directories, {
                    request, characterAvatar, groupId, chat, nodeId,
                    type, isImpersonate, isContinue, isSwipe, userMessageText, userMessageExtra, quiet, responseLength, pageFacts, pageInjections,
                });
            } catch (error) {
                console.error('Failed to build raw-action text completion request:', error);
                return response.status(400).send({ error: true, message: error?.message ?? 'Could not resolve this generation request' });
            }
            warnings.push(...built.warnings);
            tokenCountRows = built.tokenCountRows;

            const skipPersistence = isImpersonate || type === 'quiet';
            let replyAnchorNodeId = built.anchorNodeId;
            const userMessage = turn.userMessage;
            if (!skipPersistence && typeof userMessageText === 'string') {
                const userNodeId = await storeUserMessage(response, {
                    chat, anchorNodeId: built.anchorNodeId, ref: request.body.user_message_ref,
                    message: userMessage,
                });
                if (!userNodeId) return;
                replyAnchorNodeId = userNodeId;
            }
            await storeMacroVariables(response, chat, nodeId, built.macroVariables);

            const continuesUserMessage = isContinue && replyAnchorNodeId !== built.anchorNodeId;
            if (!skipPersistence) {
                pendingAssistantPersist = {
                    chat, anchorNodeId: replyAnchorNodeId, name2: built.name2,
                    isSwipe, isContinue, anchorContent: continuesUserMessage ? userMessage : built.anchorContent,
                    activations: built.activations,
                    sentNodeId: replyAnchorNodeId !== built.anchorNodeId ? replyAnchorNodeId : null,
                    warnings,
                    generationStop: response.locals.generationStop,
                    itemization: startItemizing(built.itemize),
                    finish: await readReplyFinishSettings(request.user.directories, {
                        mainApi: 'textgenerationwebui', source: built.backend.type, avatar: characterAvatar, groupId, name1: built.name1, name2: built.name2,
                        model: built.model,
                    }),
                };
                chat.session.actor();
            }

            const stream = !!request.body.stream;
            request.body = { ...built.params, stream, api_type: built.backend.type, api_server: built.backend.serverUrl };
        }

        if (!request.body.api_type) {
            const backend = resolveTextGenBackend(request.user.directories);
            request.body.api_type = backend.type;
            request.body.api_server = backend.serverUrl;
            if (backend.model !== undefined) {
                request.body.model = backend.model;
            }
        }

        if (request.body.api_server.indexOf('localhost') !== -1) {
            request.body.api_server = request.body.api_server.replace('localhost', '127.0.0.1');
        }

        const apiType = request.body.api_type;
        const baseUrl = request.body.api_server;

        const controller = stoppableController(response);
        if (request.body.api_type === TEXTGEN_TYPES.KOBOLDCPP) {
            onGenerationStop(response, () => abortKoboldCppRequest(request, trimV1(baseUrl)));
        }
        request.socket.removeAllListeners('close');
        request.socket.on('close', async function () {
            if (pendingAssistantPersist) return;

            if (request.body.api_type === TEXTGEN_TYPES.KOBOLDCPP && !response.writableEnded) {
                await abortKoboldCppRequest(request, trimV1(baseUrl));
            }

            controller.abort();
        });

        let url = trimV1(baseUrl);

        switch (request.body.api_type) {
            case TEXTGEN_TYPES.GENERIC:
            case TEXTGEN_TYPES.VLLM:
            case TEXTGEN_TYPES.FEATHERLESS:
            case TEXTGEN_TYPES.APHRODITE:
            case TEXTGEN_TYPES.OOBA:
            case TEXTGEN_TYPES.TABBY:
            case TEXTGEN_TYPES.KOBOLDCPP:
            case TEXTGEN_TYPES.TOGETHERAI:
            case TEXTGEN_TYPES.INFERMATICAI:
            case TEXTGEN_TYPES.HUGGINGFACE:
                url += '/v1/completions';
                break;
            case TEXTGEN_TYPES.DREAMGEN:
                url += '/api/openai/v1/completions';
                break;
            case TEXTGEN_TYPES.MANCER:
                url += '/oai/v1/completions';
                break;
            case TEXTGEN_TYPES.LLAMACPP:
                url += '/completion';
                break;
            case TEXTGEN_TYPES.OLLAMA:
                url += '/api/generate';
                break;
            case TEXTGEN_TYPES.OPENROUTER:
                url += '/v1/chat/completions';
                break;
        }

        const args = {
            method: 'POST',
            body: JSON.stringify(request.body),
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            timeout: 0,
        };

        setAdditionalHeaders(request, args, baseUrl);

        if (request.body.api_type === TEXTGEN_TYPES.TOGETHERAI) {
            request.body = _.pickBy(request.body, (_, key) => TOGETHERAI_KEYS.includes(key));
            args.body = JSON.stringify(request.body);
        }

        if (request.body.api_type === TEXTGEN_TYPES.INFERMATICAI) {
            request.body = _.pickBy(request.body, (_, key) => INFERMATICAI_KEYS.includes(key));
            args.body = JSON.stringify(request.body);
        }

        if (request.body.api_type === TEXTGEN_TYPES.FEATHERLESS) {
            request.body = _.pickBy(request.body, (_, key) => FEATHERLESS_KEYS.includes(key));
            args.body = JSON.stringify(request.body);
        }

        if (request.body.api_type === TEXTGEN_TYPES.DREAMGEN) {
            args.body = JSON.stringify(request.body);
        }

        if (request.body.api_type === TEXTGEN_TYPES.GENERIC) {
            request.body = _.pickBy(request.body, (_, key) => OPENAI_KEYS.includes(key));
            if (Array.isArray(request.body.stop)) { request.body.stop = request.body.stop.slice(0, 4); }
            args.body = JSON.stringify(request.body);
        }

        if (request.body.api_type === TEXTGEN_TYPES.OPENROUTER) {
            if (Array.isArray(request.body.provider) && request.body.provider.length > 0) {
                request.body.provider = {
                    allow_fallbacks: request.body.allow_fallbacks ?? true,
                    order: request.body.provider,
                };
            } else {
                delete request.body.provider;
            }

            if (Array.isArray(request.body.quantizations) && request.body.quantizations.length > 0) {
                request.body.provider ??= {};
                request.body.provider.quantizations = request.body.quantizations;
            }

            request.body = _.pickBy(request.body, (_, key) => OPENROUTER_KEYS.includes(key));
            args.body = JSON.stringify(request.body);
        }

        if (request.body.api_type === TEXTGEN_TYPES.VLLM) {
            request.body = _.pickBy(request.body, (_, key) => VLLM_KEYS.includes(key));
            args.body = JSON.stringify(request.body);
        }

        if (request.body.api_type === TEXTGEN_TYPES.OLLAMA) {
            const keepAlive = Number(getConfigValue('ollama.keepAlive', -1, 'number'));
            const numBatch = Number(getConfigValue('ollama.batchSize', -1, 'number'));
            if (numBatch > 0) {
                request.body.num_batch = numBatch;
            }
            args.body = JSON.stringify({
                model: request.body.model,
                prompt: request.body.prompt,
                stream: request.body.stream ?? false,
                keep_alive: keepAlive,
                raw: true,
                options: _.pickBy(request.body, (_, key) => OLLAMA_KEYS.includes(key)),
            });
        }

        if (request.body.api_type === TEXTGEN_TYPES.OLLAMA && request.body.stream) {
            const stream = await fetch(url, args);
            storeTokenCountRows();
            await parseOllamaStream(stream, request, response, pendingAssistantPersist, warnings);
        } else if (request.body.stream) {
            const completionsStream = await fetch(url, args);
            storeTokenCountRows();
            if (request.body.api_type === TEXTGEN_TYPES.LLAMACPP) {
                await pipeLlamaCppCompactStream(completionsStream, response, pendingAssistantPersist, warnings);
            } else if (request.body.api_type === TEXTGEN_TYPES.OPENROUTER) {
                await forwardAndPersistCompactStream(completionsStream, response, pendingAssistantPersist, json => json?.choices?.[0]?.delta?.content, null, warnings);
            } else {
                await forwardAndPersistCompactStream(completionsStream, response, pendingAssistantPersist, json => json?.choices?.[0]?.text, null, warnings);
            }
        } else {
            const completionsReply = await fetch(url, args);
            storeTokenCountRows();

            if (completionsReply.ok) {
                /** @type {any} */
                const data = await completionsReply.json();

                // Map InfermaticAI response to OAI completions format
                if (apiType === TEXTGEN_TYPES.INFERMATICAI) {
                    data.choices = (data?.choices || []).map(choice => ({ text: choice?.message?.content || choice.text, logprobs: choice?.logprobs, index: choice?.index }));
                }

                if (pendingAssistantPersist) {
                    const generatedText = replyTextAsPageShows(data, 'textgenerationwebui');
                    if (generatedText === null) {
                        warnings.push(unreadableReplyWarning(data, `textgenerationwebui|${apiType}`));
                    }
                    const persisted = await persistAssistantReply(pendingAssistantPersist, generatedText ?? '', { data });
                    attachStoredReply(data, persisted);
                }

                if (warnings.length) {
                    data.warnings = warnings;
                }

                return response.send(withStoredMessages(data, response));
            } else {
                const text = await completionsReply.text();
                const errorBody = { error: true, status: completionsReply.status, response: text };

                return !response.headersSent
                    ? response.send(errorBody)
                    : response.end();
            }
        }
    } catch (error) {
        const status = error?.status ?? error?.code ?? 'UNKNOWN';
        const text = error?.error ?? error?.statusText ?? error?.message ?? 'Unknown error on /generate endpoint';
        let value = { error: true, status: status, response: text };
        if (!isGenerationStopped(response)) logBackendFailure(request.body?.api_server, error, () => console.error('Endpoint error:', error));

        return !response.headersSent
            ? response.send(value)
            : response.end();
    }
}));

router.get('/generate/meta/:id', function (request, response) {
    const meta = getLlamaCppStreamMeta(request.params.id);

    if (!meta) {
        return response.sendStatus(404);
    }

    return response.json(meta);
});

router.get('/generate/resume/:id', handleGenerationResume);

router.post('/generate/stop/:id', handleGenerationStop);

const ollama = express.Router();

ollama.post('/download', async function (request, response) {
    try {
        if (!request.body.name || !request.body.api_server) return response.sendStatus(400);

        const name = request.body.name;
        const url = String(request.body.api_server).replace(/\/$/, '');
        console.debug('Pulling Ollama model:', name);

        const fetchResponse = await fetch(`${url}/api/pull`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: name,
                stream: false,
            }),
        });

        if (!fetchResponse.ok) {
            console.error('Download error:', fetchResponse.status, fetchResponse.statusText);
            return response.status(500).send({ error: true });
        }

        console.debug('Ollama pull response:', await fetchResponse.json());
        return response.send({ ok: true });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

ollama.post('/caption-image', async function (request, response) {
    try {
        if (!request.body.server_url || !request.body.model) {
            return response.sendStatus(400);
        }

        console.debug('Ollama caption request:', request.body);
        const baseUrl = trimV1(request.body.server_url);

        const fetchResponse = await fetch(`${baseUrl}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: request.body.model,
                prompt: request.body.prompt,
                images: [request.body.image],
                stream: false,
            }),
        });

        if (!fetchResponse.ok) {
            const errorText = await fetchResponse.text();
            console.error('Ollama caption error:', fetchResponse.status, fetchResponse.statusText, errorText);
            return response.status(500).send({ error: true });
        }

        /** @type {any} */
        const data = await fetchResponse.json();
        console.debug('Ollama caption response:', data);

        const caption = data?.response || '';

        if (!caption) {
            console.error('Ollama caption is empty.');
            return response.status(500).send({ error: true });
        }

        return response.send({ caption });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

const llamacpp = express.Router();

llamacpp.post('/props', async function (request, response) {
    try {
        if (!request.body.server_url) {
            return response.sendStatus(400);
        }

        console.debug('LlamaCpp props request:', request.body);
        const baseUrl = trimV1(request.body.server_url);

        const fetchResponse = await fetch(`${baseUrl}/props`, {
            method: 'GET',
        });

        if (!fetchResponse.ok) {
            console.error('LlamaCpp props error:', fetchResponse.status, fetchResponse.statusText);
            return response.status(500).send({ error: true });
        }

        const data = await fetchResponse.json();
        console.debug('LlamaCpp props response:', data);

        return response.send(data);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

llamacpp.post('/slots', async function (request, response) {
    try {
        if (!request.body.server_url) {
            return response.sendStatus(400);
        }
        if (!/^(erase|info|restore|save)$/.test(request.body.action)) {
            return response.sendStatus(400);
        }

        console.debug('LlamaCpp slots request:', request.body);
        const baseUrl = trimV1(request.body.server_url);

        let fetchResponse;
        if (request.body.action === 'info') {
            fetchResponse = await fetch(`${baseUrl}/slots`, {
                method: 'GET',
            });
        } else {
            if (!/^\d+$/.test(request.body.id_slot)) {
                return response.sendStatus(400);
            }
            if (request.body.action !== 'erase' && !request.body.filename) {
                return response.sendStatus(400);
            }

            fetchResponse = await fetch(`${baseUrl}/slots/${request.body.id_slot}?action=${request.body.action}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filename: request.body.action !== 'erase' ? `${request.body.filename}` : undefined,
                }),
            });
        }

        if (!fetchResponse.ok) {
            console.error('LlamaCpp slots error:', fetchResponse.status, fetchResponse.statusText);
            return response.status(500).send({ error: true });
        }

        const data = await fetchResponse.json();
        console.debug('LlamaCpp slots response:', data);

        return response.send(data);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

const tabby = express.Router();

tabby.post('/download', async function (request, response) {
    try {
        const baseUrl = String(request.body.api_server).replace(/\/$/, '');

        const args = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request.body),
            timeout: 0,
        };

        setAdditionalHeaders(request, args, baseUrl);

        // Check key permissions
        const permissionResponse = await fetch(`${baseUrl}/v1/auth/permission`, {
            headers: args.headers,
        });

        if (permissionResponse.ok) {
            /** @type {any} */
            const permissionJson = await permissionResponse.json();

            if (permissionJson.permission !== 'admin') {
                return response.status(403).send({ error: true });
            }
        } else {
            console.error('API Permission error:', permissionResponse.status, permissionResponse.statusText);
            return response.status(500).send({ error: true });
        }

        const fetchResponse = await fetch(`${baseUrl}/v1/download`, args);

        if (!fetchResponse.ok) {
            console.error('Download error:', fetchResponse.status, fetchResponse.statusText);
            return response.status(500).send({ error: true });
        }

        return response.send({ ok: true });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.use('/ollama', ollama);
router.use('/llamacpp', llamacpp);
router.use('/tabby', tabby);
