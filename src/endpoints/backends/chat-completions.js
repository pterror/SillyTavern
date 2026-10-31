/* eslint-disable dot-notation */
import { createHmac } from 'node:crypto';
import process from 'node:process';
import express from 'express';
import fetch from 'node-fetch';
import urlJoin from 'url-join';
import _ from 'lodash';

import {
    AIMLAPI_HEADERS,
    AZURE_OPENAI_KEYS,
    CHAT_COMPLETION_SOURCES,
    GEMINI_SAFETY,
    NANOGPT_REASONING_EFFORT_MAP,
    OPENAI_FIXED_REASONING_EFFORT,
    OPENAI_REASONING_EFFORT_MAP,
    OPENAI_REASONING_EFFORT_MODELS,
    OPENAI_VERBOSITY_MODELS,
    OPENROUTER_HEADERS,
    VERTEX_SAFETY,
    SILICONFLOW_ENDPOINT,
    MINIMAX_ENDPOINT,
    ZAI_ENDPOINT,
    POLLINATIONS_ENDPOINT,
} from '../../constants.js';
import {
    forwardFetchResponse,
    getConfigValue,
    tryParse,
    uuidv4,
    mergeObjectWithYaml,
    excludeKeysByYaml,
    color,
    trimTrailingSlash,
    flattenSchema,
} from '../../util.js';
import {
    convertClaudeMessages,
    convertGooglePrompt,
    convertTextCompletionPrompt,
    convertCohereMessages,
    convertMistralMessages,
    convertAI21Messages,
    convertXAIMessages,
    cachingAtDepthForOpenRouterClaude,
    cachingAtDepthForClaude,
    getPromptNames,
    calculateClaudeBudgetTokens,
    calculateGoogleBudgetTokens,
    postProcessPrompt,
    PROMPT_PROCESSING_TYPE,
    addAssistantPrefix,
    embedOpenRouterMedia,
    addReasoningContentToToolCalls,
    cachingSystemPromptForOpenRouter,
    addOpenRouterSignatures,
} from '../../prompt-converters.js';

import { readSecret, SECRET_KEYS } from '../secrets.js';
import { resolveConnectionProfile } from '../../connection-profile-resolve.js';
import { mergeChatCompletionPreset } from '../../chat-completion-preset-merge.js';
import { createGenerationParameters } from '../../chat-completion-generation-data.js';
import { substituteParams } from '../../macro-substitution.js';
import { refreshLlamaCppDetection } from '../../custom-llamacpp.js';
import { createLlamaCppPropsCheck } from '../../llamacpp-props.js';
import { writeBack } from '../../token-count-store.js';
import { readSettingsFor, settingsContextOf } from '../../settings-reads.js';
import { readBundle } from '../../bundle-store.js';
import { resolveChatCompletionGenerationInput } from '../../chat-completion-generation-input.js';
import { resolveTokenizer, sendTokenizerWarnings, createTokenizerOutcome } from '../../tokenizer-resolve.js';
import { readConnectionStateHeader } from '../../connection-state-header.js';
import { fetchOpenRouterModels, rememberOpenRouterModels } from '../../openrouter-models.js';
import { prepareOpenAIMessages } from '../../chat-completion-prepare-messages.js';
import { generateTurnOf } from '../../page-writes.js';
import { readCardContent } from '../characters.js';
import { getGroupsByIds } from '../groups.js';
import { attachStoredReply, persistAssistantReply, replyTextAsPageShows, unreadableReplyWarning } from '../../assistant-reply-persist.js';
import { noteReplyReasoning, noteReplyText, readReplyFinishSettings } from '../../reply-reasoning.js';
import { itemizationOf } from '../../itemization-of.js';
import { answerSessionOnHeaders, chatContext } from '../../chat-request.js';
import { storedForm } from '../../chat-engine.js';
import { storeUserMessage, withStoredMessages } from '../../stored-messages.js';
import { getEnabledServerTools, toOpenAIToolSchema } from '../../server-tools.js';
import {
    TEXT_COMPLETION_MODELS,
    computeLogitBias,
    computeUpstreamLogitBias,
} from '../tokenizers.js';
import { getVertexAIAuth, getProjectIdFromServiceAccount } from '../google.js';
import { getCookieSecret } from '../../users.js';
import { fetchGoogleModels, GoogleModelsHttpError } from './google-models.js';
import { encodeContent, encodeIndexFrame, encodeReasoningFrame, encodeStoredReplyFrame, encodeToolCallDeltaFrame, encodeControlFrame, createGenerationRecord, createResumableWriter, detachFromResponse, handleGenerationResume, writeStoredMessagesFrame } from './llamacpp-compact-stream.js';
import { withGenerationStop, generationIdFor, isGenerationStopped, onGenerationStopFlush, stoppableController, handleGenerationStop } from '../../generation-stop.js';
import { macroVariableChanges, storeMacroVariables } from '../../macro-facts.js';

const API_OPENAI = 'https://api.openai.com/v1';
const API_CLAUDE = 'https://api.anthropic.com/v1';
const API_MISTRAL = 'https://api.mistral.ai/v1';
const API_COHERE_V1 = 'https://api.cohere.ai/v1';
const API_COHERE_V2 = 'https://api.cohere.ai/v2';
const API_PERPLEXITY = 'https://api.perplexity.ai';
const API_GROQ = 'https://api.groq.com/openai/v1';
const API_MAKERSUITE = 'https://generativelanguage.googleapis.com';
const API_VERTEX_AI = 'https://us-central1-aiplatform.googleapis.com';
const API_AI21 = 'https://api.ai21.com/studio/v1';
const API_CHUTES = 'https://llm.chutes.ai/v1';
const API_ELECTRONHUB = 'https://api.electronhub.ai/v1';
const API_NANOGPT = 'https://nano-gpt.com/api/v1';
const API_DEEPSEEK = 'https://api.deepseek.com/beta';
const API_XAI = 'https://api.x.ai/v1';
const API_AIMLAPI = 'https://api.aimlapi.com/v1';
const API_POLLINATIONS = 'https://gen.pollinations.ai/v1';
const API_POLLINATIONS_ANON = 'https://text.pollinations.ai/v1';
const API_MOONSHOT = 'https://api.moonshot.ai/v1';
const API_FIREWORKS = 'https://api.fireworks.ai/inference/v1';
const API_COMETAPI = 'https://api.cometapi.com/v1';
const API_ZAI_COMMON = 'https://api.z.ai/api/paas/v4';
const API_ZAI_CODING = 'https://api.z.ai/api/coding/paas/v4';
const API_SILICONFLOW = 'https://api.siliconflow.com/v1';
const API_SILICONFLOW_CN = 'https://api.siliconflow.cn/v1';
const API_MINIMAX = 'https://api.minimax.io/v1';
const API_MINIMAX_CN = 'https://api.minimaxi.com/v1';
const API_WORKERS_AI = 'https://api.cloudflare.com/client/v4/accounts';

/**
 * Module-scoped Claude caching configuration values.
 */
const cacheTTL = getConfigValue('claude.extendedTTL', false, 'boolean') ? '1h' : '5m';
const enableSystemPromptCache = getConfigValue('claude.enableSystemPromptCache', false, 'boolean');
const cachingAtDepth = (() => {
    const value = getConfigValue('claude.cachingAtDepth', -1, 'number');
    return Number.isInteger(value) && value >= 0 ? value : -1;
})();
const enableAdaptiveThinking = getConfigValue('claude.enableAdaptiveThinking', true, 'boolean');

/**
 * Lazily-cached HMAC key (instance cookie secret) for session-affinity hashing.
 * @type {string|undefined}
 */
let affinityKey;
function getAffinityKey() {
    if (affinityKey === undefined) {
        affinityKey = getCookieSecret(globalThis.DATA_ROOT);
    }
    return affinityKey;
}

/**
 * Cache for cacheable (writing) OpenRouter model IDs.
 * @type {string[]}
 */
const openRouterCacheableModels = [];

/**
 * Checks if an OpenRouter model supports prompt cache writing.
 * Uses a cache to avoid repeated API calls.
 * @param {string} modelId - The OpenRouter model ID
 * @returns {Promise<boolean>} `true` if the model supports writing cache
 */
async function isOpenRouterModelCacheable(modelId) {
    if (openRouterCacheableModels.includes(modelId)) {
        return true;
    }

    try {
        const models = await fetchOpenRouterModels();

        if (!models) {
            return false;
        }

        const model = models.find(m => m.id === modelId);
        const supportsCache = model?.pricing?.input_cache_write != null;

        if (supportsCache) {
            openRouterCacheableModels.push(modelId);
        }

        return supportsCache;
    } catch (error) {
        console.warn(`Failed to check OpenRouter cache support for ${modelId}:`, error.message);
        return false;
    }
}

/**
 * Gets OpenRouter transforms based on the request.
 * @param {import('express').Request} request Express request
 * @returns {string[] | undefined} OpenRouter transforms
 */
function getOpenRouterTransforms(request) {
    switch (request.body.middleout) {
        case 'on':
            return ['middle-out'];
        case 'off':
            return [];
        case 'auto':
            return undefined;
    }
}

/**
 * Gets OpenRouter plugins based on the request.
 * @param {import('express').Request} request
 * @returns {any[]} OpenRouter plugins
 */
function getOpenRouterPlugins(request) {
    const plugins = [];

    if (request.body.enable_web_search) {
        plugins.push({ 'id': 'web' });
    }

    return plugins;
}

/**
 * Hacky way to use JSON schema only if json_object format is supported.
 * @param {object} bodyParams Additional body parameters
 * @param {object[]} messages Array of messages
 * @param {object} jsonSchema JSON schema object
 */
function setJsonObjectFormat(bodyParams, messages, jsonSchema) {
    bodyParams['response_format'] = {
        type: 'json_object',
    };
    const message = {
        role: 'user',
        content: `JSON schema for the response:\n${JSON.stringify(jsonSchema.value, null, 4)}`,
    };
    messages.push(message);
}

/**
 * Sends a request to Claude API.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 * @param {object|null} [persist] `pendingAssistantPersist` from the `/generate` route (`null`/`undefined`
 * for every non-raw-action call). When set, persists the ASSISTANT's real reply text - the actual
 * `type: 'text'` content block(s) only, never a `type: 'thinking'` block - onto the message tree via the
 * shared `persistAssistantReply()`, for both streaming (teed via `forwardAndPersistCompactStream()`, accumulating
 * only `content_block_delta` events whose `delta.type === 'text_delta'`) and non-streaming. Purely additive:
 * the bytes/JSON actually sent to the client are unaffected either way.
 * @param {Array<{kind: string, key: string, message: string, entries?: string[]}>|null} [warnings] The `/generate`
 * route's per-request warnings - passed to the stream writer, or set as the reply's `warnings`, only when non-empty.
 * @param {(() => void) | null} [onDispatched] Called once the backend request has been sent.
 */
async function sendClaudeRequest(request, response, persist, warnings = null, onDispatched = null) {
    const apiUrl = new URL(request.body.reverse_proxy || API_CLAUDE).toString();
    const apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.CLAUDE, request.body.secret_id);
    const divider = '-'.repeat(process.stdout.columns);

    if (!apiKey) {
        console.warn(color.red(`Claude API key is missing.\n${divider}`));
        return response.status(400).send({ error: true });
    }

    try {
        const controller = stoppableController(response);
        request.socket.removeAllListeners('close');
        request.socket.on('close', function () {
            if (persist) return;
            controller.abort();
        });
        const additionalHeaders = {};
        const betaHeaders = ['output-128k-2025-02-19', 'context-1m-2025-08-07'];
        const useTools = Array.isArray(request.body.tools) && request.body.tools.length > 0;
        const useSystemPrompt = Boolean(request.body.use_sysprompt);
        const convertedPrompt = convertClaudeMessages(request.body.messages, request.body.assistant_prefill, useSystemPrompt, useTools, getPromptNames(request));
        // Unanchored to also match prefixed ids passed through proxies, e.g. 'anthropic/claude-fable-5'
        const isFableModel = /claude-fable/.test(request.body.model);
        const useNativeJsonOutput = /claude-(fable-5-1|opus-5-5)/.test(request.body.model);
        const isClaude5Model = /claude-(opus-5|sonnet-5)/.test(request.body.model);
        const useThinking = /^claude-(3-7|opus-4|sonnet-4|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6|opus-4-7)/.test(request.body.model) || isFableModel || isClaude5Model;
        const useWebSearch = (/^claude-(3-5|3-7|opus-4|sonnet-4|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6|opus-4-7)/.test(request.body.model) || isFableModel || isClaude5Model) && Boolean(request.body.enable_web_search);
        const isLimitedSampling = /^claude-(opus-4-1|sonnet-4-5|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6)/.test(request.body.model);
        const useVerbosity = /^claude-(opus-4-5|opus-4-6|sonnet-4-6|opus-4-7|opus-4-8)/.test(request.body.model) || isFableModel || isClaude5Model;
        const noPrefillModel = /^claude-(opus-4-6|sonnet-4-6|opus-4-7|opus-4-8)/.test(request.body.model) || isFableModel || isClaude5Model;
        const isAdaptiveModel = /^claude-(opus-4-7|opus-4-8)/.test(request.body.model) || isFableModel || isClaude5Model || (enableAdaptiveThinking && /^claude-(opus-4-6|sonnet-4-6)/.test(request.body.model));
        const noSamplingModel = /^claude-(opus-4-7|opus-4-8)/.test(request.body.model) || isFableModel || isClaude5Model;
        let fixThinkingPrefill = false;
        // Add custom stop sequences
        const stopSequences = [];
        if (Array.isArray(request.body.stop)) {
            stopSequences.push(...request.body.stop);
        }

        const requestBody = {
            /** @type {any} */ system: [],
            messages: convertedPrompt.messages,
            model: request.body.model,
            max_tokens: request.body.max_tokens,
            stop_sequences: stopSequences,
            temperature: request.body.temperature,
            top_p: request.body.top_p,
            top_k: request.body.top_k,
            stream: request.body.stream,
        };
        if (useSystemPrompt) {
            if (enableSystemPromptCache && Array.isArray(convertedPrompt.systemPrompt) && convertedPrompt.systemPrompt.length) {
                convertedPrompt.systemPrompt[convertedPrompt.systemPrompt.length - 1].cache_control = { type: 'ephemeral', ttl: cacheTTL };
            }

            requestBody.system = convertedPrompt.systemPrompt;
        } else {
            delete requestBody.system;
        }
        if (useTools) {
            betaHeaders.push('tools-2024-05-16');
            requestBody.tool_choice = { type: request.body.tool_choice };
            requestBody.tools = request.body.tools
                .filter(tool => tool.type === 'function')
                .map(tool => tool.function)
                .map(fn => ({ name: fn.name, description: fn.description, input_schema: flattenSchema(fn.parameters, request.body.chat_completion_source) }));

            if (enableSystemPromptCache && requestBody.tools.length) {
                requestBody.tools[requestBody.tools.length - 1].cache_control = { type: 'ephemeral', ttl: cacheTTL };
            }
        }

        if (request.body.json_schema) {
            if (useNativeJsonOutput) {
                requestBody.output_config = {
                    format: {
                        type: 'json_schema',
                        schema: request.body.json_schema.value,
                    },
                };
            } else {
                const jsonTool = {
                    name: request.body.json_schema.name,
                    description: request.body.json_schema.description || 'Well-formed JSON object',
                    input_schema: request.body.json_schema.value,
                };
                requestBody.tools = [...(requestBody.tools || []), jsonTool];
                requestBody.tool_choice = { type: 'tool', name: request.body.json_schema.name };
            }
        }

        if (useWebSearch) {
            const webSearchTool = [{
                'type': 'web_search_20250305',
                'name': 'web_search',
            }];
            requestBody.tools = [...webSearchTool, ...(requestBody.tools || [])];
        }

        if (cachingAtDepth !== -1) {
            cachingAtDepthForClaude(convertedPrompt.messages, cachingAtDepth, cacheTTL);
        }

        if (enableSystemPromptCache || cachingAtDepth !== -1) {
            betaHeaders.push('prompt-caching-2024-07-31');
            betaHeaders.push('extended-cache-ttl-2025-04-11');
        }

        if (isLimitedSampling) {
            if (requestBody.top_p < 1) {
                delete requestBody.temperature;
            } else {
                delete requestBody.top_p;
            }
        }

        if (noSamplingModel) {
            delete requestBody.temperature;
            delete requestBody.top_p;
            delete requestBody.top_k;
        }

        const reasoningEffort = request.body.reasoning_effort;
        const includeReasoning = Boolean(request.body.include_reasoning);
        const budgetTokens = calculateClaudeBudgetTokens(requestBody.max_tokens, reasoningEffort, requestBody.stream, isAdaptiveModel);

        // Adaptive thinking: returns a string effort level (like Gemini 3)
        if (useThinking && typeof budgetTokens === 'string') {
            fixThinkingPrefill = true;
            requestBody.thinking = { type: 'adaptive' };
            if (noSamplingModel && includeReasoning) {
                requestBody.thinking.display = 'summarized';
            }
            requestBody.output_config ??= {};
            requestBody.output_config.effort = budgetTokens;
            // top_k is not allowed in adaptive mode
            delete requestBody.top_k;
        } else if (useThinking && (isFableModel || isClaude5Model) && reasoningEffort === 'auto' && includeReasoning) {
            // Fable/Claude 5 auto thinking is already enabled, but readable summaries require an explicit display request.
            fixThinkingPrefill = true;
            requestBody.thinking = { type: 'adaptive', display: 'summarized' };
        } else if (useThinking && Number.isInteger(budgetTokens)) {
            // Traditional thinking: returns a numeric budget
            fixThinkingPrefill = true;
            const minThinkTokens = 1024;
            if (requestBody.max_tokens <= minThinkTokens) {
                const newValue = requestBody.max_tokens + minThinkTokens;
                console.warn(color.yellow(`Claude thinking requires a minimum of ${minThinkTokens} response tokens.`));
                requestBody.max_tokens = newValue;
            }
            requestBody.thinking = {
                type: 'enabled',
                budget_tokens: budgetTokens,
            };

            // NO I CAN'T SILENTLY IGNORE THE TEMPERATURE.
            delete requestBody.temperature;
            delete requestBody.top_p;
            delete requestBody.top_k;
        }

        if ((fixThinkingPrefill || noPrefillModel) && convertedPrompt.messages.length && convertedPrompt.messages[convertedPrompt.messages.length - 1].role === 'assistant') {
            convertedPrompt.messages[convertedPrompt.messages.length - 1].role = 'user';
        }

        // Verbosity = 'effort' (same values as OpenAI) - only if not already set by adaptive thinking
        if (useVerbosity && request.body.verbosity && !requestBody.output_config?.effort) {
            betaHeaders.push('effort-2025-11-24');
            requestBody.output_config ??= {};
            requestBody.output_config.effort = request.body.verbosity;
        }

        if (betaHeaders.length) {
            additionalHeaders['anthropic-beta'] = betaHeaders.join(',');
        }


        const generateResponse = await fetch(apiUrl + '/messages', {
            method: 'POST',
            signal: controller.signal,
            body: JSON.stringify(requestBody),
            headers: {
                'Content-Type': 'application/json',
                'anthropic-version': '2023-06-01',
                'x-api-key': apiKey,
                ...additionalHeaders,
            },
        });
        onDispatched?.();

        if (request.body.stream) {
            await forwardAndPersistCompactStream(generateResponse, response, persist,
                json => (json?.type === 'content_block_delta' && json?.delta?.type === 'text_delta') ? json.delta.text : undefined,
                json => json?.delta?.thinking || undefined, warnings);
        } else {
            if (!generateResponse.ok) {
                const generateResponseText = await generateResponse.text();
                console.warn(color.red(`Claude API returned error: ${generateResponse.status} ${generateResponse.statusText}\n${generateResponseText}\n${divider}`));
                return response.status(500).send({ error: true });
            }

            /** @type {any} */
            const generateResponseJson = await generateResponse.json();
            const responseText = generateResponseJson?.content?.[0]?.text || '';

            // Wrap it back to OAI format + save the original content
            const reply = { choices: [{ 'message': { 'content': responseText } }], content: generateResponseJson.content };

            const persistedText = Array.isArray(generateResponseJson?.content)
                ? generateResponseJson.content.filter(block => block?.type === 'text').map(block => block.text).join('')
                : '';
            if (persist) {
                const persisted = await persistAssistantReply(persist, persistedText, { data: reply });
                attachStoredReply(reply, persisted);
            }
            if (warnings?.length) reply.warnings = warnings;

            return response.send(withStoredMessages(reply, response));
        }
    } catch (error) {
        console.error(color.red(`Error communicating with Claude: ${error}\n${divider}`));
        if (!response.headersSent) {
            return response.status(500).send({ error: true });
        }
    }
}

/**
 * Sends a request to Google AI API.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 * @param {object|null} [persist] `pendingAssistantPersist` from the `/generate` route (`null`/`undefined`
 * for every non-raw-action call). When set, persists the ASSISTANT's real reply text onto the message
 * tree via the shared `persistAssistantReply()`, for both streaming (teed via
 * `forwardAndPersistCompactStream()`) and non-streaming - in both cases extracting only real
 * `candidates[0].content.parts` entries with `!part.thought` (Gemini's own "thought"/reasoning parts
 * are excluded), matching this function's own existing, unmodified non-streaming `responseText`
 * extraction below verbatim. Purely additive: the bytes/JSON actually sent to the client are
 * unaffected either way.
 * @param {Array<{kind: string, key: string, message: string, entries?: string[]}>|null} [warnings] The `/generate`
 * route's per-request warnings - passed to the stream writer, or set as the reply's `warnings`, only when non-empty.
 * @param {(() => void) | null} [onDispatched] Called once the backend request has been sent.
 */
async function sendMakerSuiteRequest(request, response, persist, warnings = null, onDispatched = null) {
    const useVertexAi = request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.VERTEXAI;
    const apiName = useVertexAi ? 'Google Vertex AI' : 'Google AI Studio';
    let apiUrl;
    let apiKey;

    let authHeader;
    let authType;

    if (useVertexAi) {
        apiUrl = new URL(request.body.reverse_proxy || API_VERTEX_AI);

        try {
            const auth = await getVertexAIAuth(request);
            authHeader = auth.authHeader;
            authType = auth.authType;
        } catch (error) {
            console.warn(`${apiName} authentication failed: ${error.message}`);
            return response.status(400).send({ error: true, message: error.message });
        }
    } else {
        apiUrl = new URL(request.body.reverse_proxy || API_MAKERSUITE);
        apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.MAKERSUITE, request.body.secret_id);

        if (!request.body.reverse_proxy && !apiKey) {
            console.warn(`${apiName} API key is missing.`);
            return response.status(400).send({ error: true });
        }

        authHeader = `Bearer ${apiKey}`;
        authType = 'api_key';
    }

    const model = String(request.body.model);
    const stream = Boolean(request.body.stream);
    const enableWebSearch = Boolean(request.body.enable_web_search);
    const requestImages = Boolean(request.body.request_images);
    const reasoningEffort = String(request.body.reasoning_effort);
    const includeReasoning = Boolean(request.body.include_reasoning);
    const aspectRatio = String(request.body.request_image_aspect_ratio);
    const imageSize = String(request.body.request_image_resolution);
    const isGemma3 = /gemma-3/.test(model);
    const isLearnLM = model.includes('learnlm');

    const responseMimeType = request.body.responseMimeType ?? (request.body.json_schema ? 'application/json' : undefined);
    const responseSchema = request.body.responseSchema ?? (request.body.json_schema ? request.body.json_schema.value : undefined);

    const generationConfig = {
        stopSequences: request.body.stop,
        candidateCount: 1,
        maxOutputTokens: request.body.max_tokens,
        temperature: request.body.temperature,
        topP: request.body.top_p,
        topK: request.body.top_k || undefined,
        responseMimeType: responseMimeType,
        responseSchema: responseSchema,
        seed: request.body.seed,
    };

    function getGeminiBody() {
        // #region UGLY MODEL LISTS AREA
        const imageGenerationModels = [
            'gemini-2.0-flash-exp',
            'gemini-2.0-flash-exp-image-generation',
            'gemini-2.0-flash-preview-image-generation',
            'gemini-2.5-flash-image-preview',
            'gemini-2.5-flash-image',
            'gemini-3-pro-image',
            'gemini-3.1-flash-image',
        ];

        const isThinkingConfigModel = m => (/^gemini-2.5-(flash|pro)/.test(m) && !/-image(-preview)?$/.test(m)) || (/^gemini-3[.\d]*-(flash|pro)/.test(m)) || /^gemini-4-argon(?:$|-)/.test(m);
        const isImageSizeModel = m => /^gemini-3/.test(m);
        // https://ai.google.dev/gemini-api/docs/latest-model#api-changes-and-parameter-updates
        const noSamplingModel = /gemini-3\.[678]-flash|gemini-3\.5-flash-lite|^gemini-4-argon(?:$|-)/.test(model);

        const noSearchModels = [
            'gemini-2.0-flash-lite',
            'gemini-2.0-flash-lite-001',
            'gemini-2.0-flash-lite-preview-02-05',
            'gemini-robotics-er-1.5-preview',
        ];
        // #endregion

        if (!Array.isArray(generationConfig.stopSequences) || !generationConfig.stopSequences.length) {
            delete generationConfig.stopSequences;
        }

        if (noSamplingModel) {
            delete generationConfig.temperature;
            delete generationConfig.topP;
            delete generationConfig.topK;
            delete generationConfig.candidateCount;
        }

        const enableImageModality = requestImages && imageGenerationModels.includes(model);
        const enableImageConfig = enableImageModality && (aspectRatio || imageSize);
        if (enableImageModality) {
            generationConfig.responseModalities = ['text', 'image'];
            if (enableImageConfig) {
                generationConfig.imageConfig = {};
                if (imageSize && isImageSizeModel(model)) {
                    generationConfig.imageConfig.imageSize = imageSize;
                }
                if (aspectRatio) {
                    generationConfig.imageConfig.aspectRatio = aspectRatio;
                }
            }
        }

        const useSystemPrompt = !enableImageModality && !isGemma3 && request.body.use_sysprompt;

        const tools = [];
        const prompt = convertGooglePrompt(request.body.messages, model, useSystemPrompt, getPromptNames(request));
        const safetySettings = [...GEMINI_SAFETY, ...(useVertexAi ? VERTEX_SAFETY : [])];

        if (Array.isArray(request.body.tools) && request.body.tools.length > 0 && !enableImageModality && !isGemma3) {
            const functionDeclarations = [];
            const customTools = [];
            for (const tool of request.body.tools) {
                if (tool.type === 'function') {
                    if (tool.function.parameters?.$schema) {
                        delete tool.function.parameters.$schema;
                    }
                    if (tool.function.parameters?.properties && Object.keys(tool.function.parameters.properties).length === 0) {
                        delete tool.function.parameters;
                    }
                    functionDeclarations.push(tool.function);
                } else if (tool[tool.type]) {
                    customTools.push({ [tool.type]: tool[tool.type] });
                }
            }
            if (functionDeclarations.length > 0) {
                tools.push({ function_declarations: functionDeclarations });
            }
            // Custom tools are only supported when no function calling is present
            if (functionDeclarations.length === 0 && customTools.length > 0) {
                tools.push(...customTools);
            }
        }

        if (enableWebSearch && !enableImageModality && !isGemma3 && !isLearnLM && !noSearchModels.includes(model)) {
            // Tool use with function calling is unsupported
            if (!tools.some(t => t.function_declarations)) {
                tools.push({ google_search: {} });
            }
        }

        if (isThinkingConfigModel(model)) {
            const thinkingConfig = { includeThoughts: includeReasoning };

            const thinkingBudget = calculateGoogleBudgetTokens(generationConfig.maxOutputTokens, reasoningEffort, model);
            if (typeof thinkingBudget === 'number' && Number.isInteger(thinkingBudget)) {
                thinkingConfig.thinkingBudget = thinkingBudget;
            }

            if (typeof thinkingBudget === 'string' && thinkingBudget.length > 0) {
                thinkingConfig.thinkingLevel = thinkingBudget;
            }

            // Vertex doesn't allow mixing disabled thinking with includeThoughts
            if (useVertexAi && thinkingBudget === 0 && thinkingConfig.includeThoughts) {
                thinkingConfig.includeThoughts = false;
            }

            generationConfig.thinkingConfig = thinkingConfig;
        }

        let body = {
            contents: prompt.contents,
            safetySettings: safetySettings,
            generationConfig: generationConfig,
        };

        if (useSystemPrompt && Array.isArray(prompt.system_instruction.parts) && prompt.system_instruction.parts.length) {
            body.systemInstruction = prompt.system_instruction;
        }

        if (tools.length) {
            body.tools = tools;

            const toolChoice = request.body.tool_choice;
            let functionCallingConfig;

            // Translate OpenAI's `tool_choice` to Gemini's `functionCallingConfig`
            if (typeof toolChoice === 'string') {
                switch (toolChoice) {
                    case 'none':
                        functionCallingConfig = { mode: 'NONE' };
                        break;
                    case 'required':
                        functionCallingConfig = { mode: 'ANY' };
                        break;
                    case 'auto':
                        functionCallingConfig = { mode: 'AUTO' };
                        break;
                }
            } else if (typeof toolChoice === 'object' && toolChoice?.function?.name) {
                // Force a specific function call
                functionCallingConfig = {
                    mode: 'ANY',
                    allowedFunctionNames: [toolChoice.function.name],
                };
            }

            if (functionCallingConfig) {
                body.toolConfig = { functionCallingConfig };
            }
        }

        return body;
    }

    const body = getGeminiBody();

    try {
        const controller = stoppableController(response);
        request.socket.removeAllListeners('close');
        request.socket.on('close', function () {
            if (persist) return;
            controller.abort();
        });

        const apiVersion = getConfigValue('gemini.apiVersion', 'v1beta');
        const responseType = (stream ? 'streamGenerateContent' : 'generateContent');

        let url;
        let headers = {
            'Content-Type': 'application/json',
        };

        if (useVertexAi) {
            if (authType === 'express') {
                // For Express mode (API key authentication), use the key parameter
                const keyParam = authHeader.replace('Bearer ', '');
                const region = request.body.vertexai_region || 'us-central1';
                const projectId = request.body.vertexai_express_project_id;
                const baseUrl = region === 'global'
                    ? 'https://aiplatform.googleapis.com'
                    : `https://${region}-aiplatform.googleapis.com`;
                url = projectId
                    ? `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:${responseType}?key=${keyParam}${stream ? '&alt=sse' : ''}`
                    : `${baseUrl}/v1/publishers/google/models/${model}:${responseType}?key=${keyParam}${stream ? '&alt=sse' : ''}`;
            } else if (authType === 'full') {
                // For Full mode (service account authentication), use project-specific URL
                // Get project ID from Service Account JSON
                const serviceAccountJson = readSecret(request.user.directories, SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT, request.body.secret_id);
                if (!serviceAccountJson) {
                    console.warn('Vertex AI Service Account JSON is missing.');
                    return response.status(400).send({ error: true });
                }

                let projectId;
                try {
                    const serviceAccount = JSON.parse(serviceAccountJson);
                    projectId = getProjectIdFromServiceAccount(serviceAccount);
                } catch (error) {
                    console.error('Failed to extract project ID from Service Account JSON:', error);
                    return response.status(400).send({ error: true });
                }
                const region = request.body.vertexai_region || 'us-central1';
                // Handle global region differently - no region prefix in hostname
                if (region === 'global') {
                    url = `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:${responseType}${stream ? '?alt=sse' : ''}`;
                } else {
                    url = `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:${responseType}${stream ? '?alt=sse' : ''}`;
                }
                headers['Authorization'] = authHeader;
            } else {
                // For proxy mode, use the original URL with Authorization header
                url = `${apiUrl.toString().replace(/\/$/, '')}/v1/publishers/google/models/${model}:${responseType}${stream ? '?alt=sse' : ''}`;
                headers['Authorization'] = authHeader;
            }
        } else {
            url = `${apiUrl.toString().replace(/\/$/, '')}/${apiVersion}/models/${model}:${responseType}?key=${apiKey}${stream ? '&alt=sse' : ''}`;
        }

        const generateResponse = await fetch(url, {
            body: JSON.stringify(body),
            method: 'POST',
            headers: headers,
            signal: controller.signal,
        });
        onDispatched?.();

        if (stream) {
            try {
                await forwardAndPersistCompactStream(generateResponse, response, persist, json => {
                    const parts = json?.candidates?.[0]?.content?.parts;
                    return Array.isArray(parts) ? parts.filter(part => !part.thought).map(part => part.text ?? '').join('') : undefined;
                }, json => json?.candidates?.[0]?.content?.parts?.find(part => part.thought)?.text || undefined, warnings);
            } catch (error) {
                console.error('Error forwarding streaming response:', error);
                if (!response.headersSent) {
                    return response.status(500).send({ error: true });
                }
            }
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn(`${apiName} API returned error: ${generateResponse.status} ${generateResponse.statusText} ${errorText}`);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }

            /** @type {any} */
            const generateResponseJson = await generateResponse.json();

            const candidates = generateResponseJson?.candidates;
            if (!candidates || candidates.length === 0) {
                let message = `${apiName} API returned no candidate`;
                console.warn(message, generateResponseJson);
                if (generateResponseJson?.promptFeedback?.blockReason) {
                    message += `\nPrompt was blocked due to : ${generateResponseJson.promptFeedback.blockReason}`;
                }
                return response.send({ error: { message } });
            }

            const responseContent = candidates[0].content ?? candidates[0].output;
            const functionCall = (candidates?.[0]?.content?.parts ?? []).some(part => part.functionCall);
            const inlineData = (candidates?.[0]?.content?.parts ?? []).some(part => part.inlineData);

            const responseText = typeof responseContent === 'string' ? responseContent : responseContent?.parts?.filter(part => !part.thought)?.map(part => part.text)?.join('\n\n');
            if (!responseText && !functionCall && !inlineData) {
                let message = `${apiName} Candidate text empty`;
                console.warn(message, generateResponseJson);
                return response.send({ error: { message } });
            }

            // Wrap it back to OAI format (responseContent includes thought signatures in parts array)
            const reply = { choices: [{ 'message': { 'content': responseText } }], responseContent };

            if (persist) {
                const persisted = await persistAssistantReply(persist, responseText ?? '', { data: reply });
                attachStoredReply(reply, persisted);
            }
            if (warnings?.length) reply.warnings = warnings;

            return response.send(withStoredMessages(reply, response));
        }
    } catch (error) {
        console.error(`Error communicating with ${apiName} API:`, error);
        if (!response.headersSent) {
            return response.status(500).send({ error: true });
        }
    }
}

/**
 * Sends a request to AI21 API.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 * @param {object|null} [persist] `pendingAssistantPersist` from the `/generate` route (`null`/`undefined`
 * for every non-raw-action call). When set, persists the ASSISTANT's real reply text onto the message
 * tree via the shared `persistAssistantReply()`, for both streaming (teed via
 * `forwardAndPersistCompactStream()`) and non-streaming. AI21's `/chat/completions` endpoint is real,
 * verified OpenAI-Chat-Completions-shaped (`{choices: [{message: {content}}]}` non-streaming,
 * `{choices: [{delta: {content}}]}` per SSE chunk while streaming - see `body` above: this function
 * always builds and sends a real `messages: [...]` request to that same endpoint). Purely additive:
 * the bytes/JSON actually sent to the client are unaffected either way.
 * @param {Array<{kind: string, key: string, message: string, entries?: string[]}>|null} [warnings] The `/generate`
 * route's per-request warnings - passed to the stream writer, or set as the reply's `warnings`, only when non-empty.
 * @param {(() => void) | null} [onDispatched] Called once the backend request has been sent.
 */
async function sendAI21Request(request, response, persist, warnings = null, onDispatched = null) {
    if (!request.body) return response.sendStatus(400);

    const apiKey = readSecret(request.user.directories, SECRET_KEYS.AI21, request.body.secret_id);
    if (!apiKey) {
        console.warn('AI21 API key is missing.');
        return response.status(400).send({ error: true });
    }

    const bodyParams = {};
    const controller = stoppableController(response);
    request.socket.removeAllListeners('close');
    request.socket.on('close', function () {
        if (persist) return;
        controller.abort();
    });
    // Hack to support JSON schema
    if (request.body.json_schema) {
        bodyParams.response_format = {
            type: 'json_object',
        };
        const message = {
            role: 'user',
            content: `JSON schema for the response:\n${JSON.stringify(request.body.json_schema.value, null, 4)}`,
        };
        request.body.messages.push(message);
    }
    const convertedPrompt = convertAI21Messages(request.body.messages, getPromptNames(request));
    const body = {
        messages: convertedPrompt,
        model: request.body.model,
        max_tokens: request.body.max_tokens,
        temperature: request.body.temperature,
        top_p: request.body.top_p,
        stop: request.body.stop,
        stream: request.body.stream,
        tools: request.body.tools,
        ...bodyParams,
    };
    const options = {
        method: 'POST',
        headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
    };


    try {
        const generateResponse = await fetch(API_AI21 + '/chat/completions', options);
        onDispatched?.();
        if (request.body.stream) {
            await forwardAndPersistCompactStream(generateResponse, response, persist, json => json?.choices?.[0]?.delta?.content, null, warnings);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn(`AI21 API returned error: ${generateResponse.status} ${generateResponse.statusText} ${errorText}`);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();

            if (persist) {
                const persisted = await persistAssistantReply(persist, generateResponseJson?.choices?.[0]?.message?.content ?? '', { data: generateResponseJson });
                attachStoredReply(generateResponseJson, persisted);
            }
            if (warnings?.length) generateResponseJson.warnings = warnings;

            return response.send(withStoredMessages(generateResponseJson, response));
        }
    } catch (error) {
        console.error('Error communicating with AI21 API: ', error);
        if (!response.headersSent) {
            response.send({ error: true });
        } else {
            response.end();
        }
    }
}

/**
 * Sends a request to MistralAI API.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 * @param {object|null} [persist] `pendingAssistantPersist` from the `/generate` route (`null`/`undefined`
 * for every non-raw-action call). When set, persists the ASSISTANT's real reply text onto the message
 * tree via the shared `persistAssistantReply()`, for both streaming (teed via
 * `forwardAndPersistCompactStream()`) and non-streaming. MistralAI's `/chat/completions` endpoint is
 * standard, verified OpenAI-Chat-Completions-shaped (`{choices: [{message: {content}}]}`
 * non-streaming, `{choices: [{delta: {content}}]}` per SSE chunk while streaming - see `requestBody`
 * above: this function always builds and sends a real `messages: [...]` request to that same
 * endpoint, no Mistral-specific response reshaping). Purely additive: the bytes/JSON actually sent to
 * the client are unaffected either way.
 * @param {Array<{kind: string, key: string, message: string, entries?: string[]}>|null} [warnings] The `/generate`
 * route's per-request warnings - passed to the stream writer, or set as the reply's `warnings`, only when non-empty.
 * @param {(() => void) | null} [onDispatched] Called once the backend request has been sent.
 */
async function sendMistralAIRequest(request, response, persist, warnings = null, onDispatched = null) {
    const apiUrl = new URL(request.body.reverse_proxy || API_MISTRAL).toString();
    const apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.MISTRALAI, request.body.secret_id);

    if (!apiKey) {
        console.warn('MistralAI API key is missing.');
        return response.status(400).send({ error: true });
    }

    try {
        const messages = convertMistralMessages(request.body.messages, getPromptNames(request));
        const controller = stoppableController(response);
        request.socket.removeAllListeners('close');
        request.socket.on('close', function () {
            if (persist) return;
            controller.abort();
        });

        const requestBody = {
            'model': request.body.model,
            'messages': messages,
            'temperature': request.body.temperature,
            'top_p': request.body.top_p,
            'frequency_penalty': request.body.frequency_penalty,
            'presence_penalty': request.body.presence_penalty,
            'max_tokens': request.body.max_tokens,
            'stream': request.body.stream,
            'safe_prompt': request.body.safe_prompt,
            'random_seed': request.body.seed === -1 ? undefined : request.body.seed,
            'stop': Array.isArray(request.body.stop) && request.body.stop.length > 0 ? request.body.stop : undefined,
        };

        if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            requestBody['tools'] = request.body.tools;
            requestBody['tool_choice'] = request.body.tool_choice;
        }

        if (request.body.json_schema) {
            requestBody['response_format'] = {
                type: 'json_schema',
                json_schema: {
                    name: request.body.json_schema.name,
                    description: request.body.json_schema.description,
                    schema: request.body.json_schema.value,
                    strict: request.body.json_schema.strict ?? true,
                },
            };
        }

        const config = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
            timeout: 0,
        };


        const generateResponse = await fetch(apiUrl + '/chat/completions', config);
        onDispatched?.();
        if (request.body.stream) {
            await forwardAndPersistCompactStream(generateResponse, response, persist, json => json?.choices?.[0]?.delta?.content,
                json => json.choices?.find(choice => choice?.delta?.content?.[0]?.thinking)?.delta?.content?.[0]?.thinking?.[0]?.text || undefined, warnings);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn(`MistralAI API returned error: ${generateResponse.status} ${generateResponse.statusText} ${errorText}`);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();

            if (persist) {
                const persisted = await persistAssistantReply(persist, generateResponseJson?.choices?.[0]?.message?.content ?? '', { data: generateResponseJson });
                attachStoredReply(generateResponseJson, persisted);
            }
            if (warnings?.length) generateResponseJson.warnings = warnings;

            return response.send(withStoredMessages(generateResponseJson, response));
        }
    } catch (error) {
        console.error('Error communicating with MistralAI API: ', error);
        if (!response.headersSent) {
            response.send({ error: true });
        } else {
            response.end();
        }
    }
}

/**
 * Sends a request to Cohere API.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 * @param {object|null} [persist] `pendingAssistantPersist` from the `/generate` route (`null`/`undefined`
 * for every non-raw-action call). When set, persists the ASSISTANT's real reply text onto the message
 * tree via the shared `persistAssistantReply()`, for both streaming (teed via
 * `forwardAndPersistCompactStream()`) and non-streaming. Cohere's `/v2/chat` endpoint (`apiUrl` below) is
 * genuinely NOT an OpenAI-Chat-Completions clone - verified against this function's own request body
 * (`messages`, not a `prompt`/legacy `chat_history` shape) and against the real Cohere v2 response
 * shape this codebase's own client already parses (`extractMessageFromData()` in public/script.js
 * reads `data.message.content[0].text`/`data.message.tool_plan`; `parseStreamData()` in
 * public/scripts/sse-stream.js reads `delta.message.content.text` off `content-delta`/`tool-plan-delta`
 * SSE events). Non-streaming extraction here matches that shape exactly: every real `type: 'text'`
 * block in `message.content` (never any other block type, mirroring sendClaudeRequest's own
 * `content`-array filter), falling back to `message.tool_plan` only when there is no real text content
 * (a tool-call-only reply, where `tool_plan` is the only human-readable text in the response at all -
 * the same fallback the existing client-side `extractMessageFromData()` already relies on). Streaming
 * mirrors this identically, accumulating `content-delta`/`tool-plan-delta` events' own
 * `delta.message.content.text` field - the exact same event types/field `parseStreamData()` already
 * treats as real reply-text chunks. Purely additive: the bytes/JSON actually sent to the client are
 * unaffected either way.
 * @param {Array<{kind: string, key: string, message: string, entries?: string[]}>|null} [warnings] The `/generate`
 * route's per-request warnings - passed to the stream writer, or set as the reply's `warnings`, only when non-empty.
 * @param {(() => void) | null} [onDispatched] Called once the backend request has been sent.
 */
async function sendCohereRequest(request, response, persist, warnings = null, onDispatched = null) {
    const apiKey = readSecret(request.user.directories, SECRET_KEYS.COHERE, request.body.secret_id);
    const controller = stoppableController(response);
    request.socket.removeAllListeners('close');
    request.socket.on('close', function () {
        if (persist) return;
        controller.abort();
    });

    if (!apiKey) {
        console.warn('Cohere API key is missing.');
        return response.status(400).send({ error: true });
    }

    try {
        const convertedHistory = convertCohereMessages(request.body.messages, getPromptNames(request));
        const tools = [];

        if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            tools.push(...request.body.tools);
            tools.forEach(tool => {
                if (tool?.function?.parameters?.$schema) {
                    delete tool.function.parameters.$schema;
                }
            });
        }

        // https://docs.cohere.com/reference/chat
        const requestBody = {
            stream: Boolean(request.body.stream),
            model: request.body.model,
            messages: convertedHistory.chatHistory,
            temperature: request.body.temperature,
            max_tokens: request.body.max_tokens,
            k: request.body.top_k,
            p: request.body.top_p,
            seed: request.body.seed,
            stop_sequences: request.body.stop,
            frequency_penalty: request.body.frequency_penalty,
            presence_penalty: request.body.presence_penalty,
            documents: [],
            tools: tools,
        };

        const canDoSafetyMode = String(request.body.model).endsWith('08-2024');
        if (canDoSafetyMode) {
            requestBody.safety_mode = 'OFF';
        }

        if (request.body.json_schema) {
            requestBody.response_format = {
                type: 'json_schema',
                schema: request.body.json_schema.value,
            };
        }


        const config = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
            timeout: 0,
        };

        const apiUrl = API_COHERE_V2 + '/chat';

        if (request.body.stream) {
            const stream = await fetch(apiUrl, config);
            onDispatched?.();
            await forwardAndPersistCompactStream(stream, response, persist, json =>
                (typeof json?.delta === 'object' && typeof json?.delta?.message === 'object' && ['content-delta', 'tool-plan-delta'].includes(json?.type))
                    ? (json.delta.message.content?.text ?? '')
                    : undefined, null, warnings);
        } else {
            const generateResponse = await fetch(apiUrl, config);
            onDispatched?.();
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn(`Cohere API returned error: ${generateResponse.status} ${generateResponse.statusText} ${errorText}`);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();

            if (persist) {
                const contentText = Array.isArray(generateResponseJson?.message?.content)
                    ? generateResponseJson.message.content.filter(block => block?.type === 'text').map(block => block.text ?? '').join('')
                    : '';
                const persisted = await persistAssistantReply(persist, contentText || generateResponseJson?.message?.tool_plan || '', { data: generateResponseJson });
                attachStoredReply(generateResponseJson, persisted);
            }
            if (warnings?.length) generateResponseJson.warnings = warnings;

            return response.send(withStoredMessages(generateResponseJson, response));
        }
    } catch (error) {
        console.error('Error communicating with Cohere API: ', error);
        if (!response.headersSent) {
            response.send({ error: true });
        } else {
            response.end();
        }
    }
}

/**
 * Sends a request to DeepSeek API.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 * @param {object|null} [persist] `pendingAssistantPersist` from the `/generate` route (`null`/`undefined`
 * for every non-raw-action call). When set, persists the ASSISTANT's real reply text onto the message
 * tree via the shared `persistAssistantReply()`, for both streaming (teed via
 * `forwardAndPersistCompactStream()`) and non-streaming. DeepSeek's `/chat/completions` endpoint is
 * standard, verified OpenAI-Chat-Completions-shaped (`{choices: [{message: {content}}]}`
 * non-streaming, `{choices: [{delta: {content}}]}` per SSE chunk while streaming - see `requestBody`
 * above: this function always builds and sends a real `messages: [...]` request to that same
 * endpoint). DeepSeek's reasoner models place reasoning output in a SEPARATE `reasoning_content` field
 * alongside (not inside) `content`, both non-streaming (`message.reasoning_content`) and while
 * streaming (`delta.reasoning_content`) - persistence here reads only `content`/`delta.content`, never
 * `reasoning_content`, so reasoning output is never mistaken for the reply, exactly like this
 * function's own existing, unmodified client-facing response (`response.send(generateResponseJson)`
 * as-is) already leaves `reasoning_content` untouched too. Purely additive: the bytes/JSON actually
 * sent to the client are unaffected either way.
 * @param {Array<{kind: string, key: string, message: string, entries?: string[]}>|null} [warnings] The `/generate`
 * route's per-request warnings - passed to the stream writer, or set as the reply's `warnings`, only when non-empty.
 * @param {(() => void) | null} [onDispatched] Called once the backend request has been sent.
 */
async function sendDeepSeekRequest(request, response, persist, warnings = null, onDispatched = null) {
    const apiUrl = new URL(request.body.reverse_proxy || API_DEEPSEEK).toString();
    const apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.DEEPSEEK, request.body.secret_id);

    if (!apiKey && !request.body.reverse_proxy) {
        console.warn('DeepSeek API key is missing.');
        return response.status(400).send({ error: true });
    }

    const controller = stoppableController(response);
    request.socket.removeAllListeners('close');
    request.socket.on('close', function () {
        if (persist) return;
        controller.abort();
    });

    try {
        let bodyParams = {};

        if (request.body.logprobs > 0) {
            bodyParams['top_logprobs'] = request.body.logprobs;
            bodyParams['logprobs'] = true;
        }

        if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            bodyParams['tools'] = request.body.tools;
            bodyParams['tool_choice'] = request.body.tool_choice;

            // DeepSeek doesn't permit empty required arrays
            bodyParams.tools.forEach(tool => {
                const required = tool?.function?.parameters?.required;
                if (Array.isArray(required) && required.length === 0) {
                    delete tool.function.parameters.required;
                }
            });
        }

        // Hack to support JSON schema
        if (request.body.json_schema) {
            bodyParams.response_format = {
                type: 'json_object',
            };
            const message = {
                role: 'user',
                content: `JSON schema for the response:\n${JSON.stringify(request.body.json_schema.value, null, 4)}`,
            };
            request.body.messages.push(message);
        }

        const processedMessages = addAssistantPrefix(postProcessPrompt(request.body.messages, PROMPT_PROCESSING_TYPE.SEMI_TOOLS, getPromptNames(request)), bodyParams.tools, 'prefix');
        addReasoningContentToToolCalls(processedMessages);

        if (request.body.include_reasoning && request.body.reasoning_effort) {
            bodyParams['reasoning_effort'] = request.body.reasoning_effort;
        }

        const requestBody = {
            'messages': processedMessages,
            'model': request.body.model,
            'temperature': request.body.temperature,
            'max_tokens': request.body.max_tokens,
            'stream': request.body.stream,
            'presence_penalty': request.body.presence_penalty,
            'frequency_penalty': request.body.frequency_penalty,
            'top_p': request.body.top_p,
            'stop': request.body.stop,
            'seed': request.body.seed,
            'thinking': { type: request.body.include_reasoning ? 'enabled' : 'disabled' },
            ...bodyParams,
        };

        const config = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        };


        const generateResponse = await fetch(apiUrl + '/chat/completions', config);
        onDispatched?.();

        if (request.body.stream) {
            await forwardAndPersistCompactStream(generateResponse, response, persist, json => json?.choices?.[0]?.delta?.content,
                json => json.choices?.find(choice => choice?.delta?.reasoning_content)?.delta?.reasoning_content || undefined, warnings);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn(`DeepSeek API returned error: ${generateResponse.status} ${generateResponse.statusText} ${errorText}`);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();

            if (persist) {
                const persisted = await persistAssistantReply(persist, generateResponseJson?.choices?.[0]?.message?.content ?? '', { data: generateResponseJson });
                attachStoredReply(generateResponseJson, persisted);
            }
            if (warnings?.length) generateResponseJson.warnings = warnings;

            return response.send(withStoredMessages(generateResponseJson, response));
        }
    } catch (error) {
        console.error('Error communicating with DeepSeek API: ', error);
        if (!response.headersSent) {
            response.send({ error: true });
        } else {
            response.end();
        }
    }
}

/**
 * Sends a request to XAI API.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 * @param {object|null} [persist] `pendingAssistantPersist` from the `/generate` route (`null`/`undefined`
 * for every non-raw-action call). When set, persists the ASSISTANT's real reply text onto the message
 * tree via the shared `persistAssistantReply()`, for both streaming (teed via
 * `forwardAndPersistCompactStream()`) and non-streaming. xAI's `/chat/completions` endpoint is standard,
 * verified OpenAI-Chat-Completions-shaped (`{choices: [{message: {content}}]}` non-streaming,
 * `{choices: [{delta: {content}}]}` per SSE chunk while streaming - see `requestBody` above: this
 * function always builds and sends a real `messages: [...]` request to that same endpoint). Grok's
 * reasoning models can likewise carry reasoning output in a separate field alongside `content` -
 * persistence here reads only `content`/`delta.content`, exactly matching this function's own existing
 * client-facing response, which forwards `generateResponseJson` unmodified. Purely additive: the
 * bytes/JSON actually sent to the client are unaffected either way.
 * @param {Array<{kind: string, key: string, message: string, entries?: string[]}>|null} [warnings] The `/generate`
 * route's per-request warnings - passed to the stream writer, or set as the reply's `warnings`, only when non-empty.
 * @param {(() => void) | null} [onDispatched] Called once the backend request has been sent.
 */
async function sendXaiRequest(request, response, persist, warnings = null, onDispatched = null) {
    const apiUrl = new URL(request.body.reverse_proxy || API_XAI).toString();
    const apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.XAI, request.body.secret_id);

    if (!apiKey && !request.body.reverse_proxy) {
        console.warn('xAI API key is missing.');
        return response.status(400).send({ error: true });
    }

    const controller = stoppableController(response);
    request.socket.removeAllListeners('close');
    request.socket.on('close', function () {
        if (persist) return;
        controller.abort();
    });

    try {
        let bodyParams = {};

        if (request.body.logprobs > 0) {
            bodyParams['top_logprobs'] = request.body.logprobs;
            bodyParams['logprobs'] = true;
        }

        if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            bodyParams['tools'] = request.body.tools;
            bodyParams['tool_choice'] = request.body.tool_choice;
        }

        if (Array.isArray(request.body.stop) && request.body.stop.length > 0) {
            bodyParams['stop'] = request.body.stop;
        }

        if (request.body.reasoning_effort) {
            bodyParams['reasoning_effort'] = request.body.reasoning_effort === 'high' ? 'high' : 'low';
        }

        if (request.body.json_schema) {
            bodyParams['response_format'] = {
                type: 'json_schema',
                json_schema: {
                    name: request.body.json_schema.name,
                    strict: request.body.json_schema.strict ?? true,
                    schema: request.body.json_schema.value,
                },
            };
        }

        const processedMessages = request.body.messages = convertXAIMessages(request.body.messages, getPromptNames(request));

        const requestBody = {
            'messages': processedMessages,
            'model': request.body.model,
            'temperature': request.body.temperature,
            'max_tokens': request.body.max_tokens,
            'max_completion_tokens': request.body.max_completion_tokens,
            'stream': request.body.stream,
            'presence_penalty': request.body.presence_penalty,
            'frequency_penalty': request.body.frequency_penalty,
            'top_p': request.body.top_p,
            'seed': request.body.seed,
            'n': request.body.n,
            ...bodyParams,
        };

        const config = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        };


        const generateResponse = await fetch(apiUrl + '/chat/completions', config);
        onDispatched?.();

        if (request.body.stream) {
            await forwardAndPersistCompactStream(generateResponse, response, persist, json => json?.choices?.[0]?.delta?.content,
                json => json.choices?.find(choice => choice?.delta?.reasoning_content)?.delta?.reasoning_content || undefined, warnings);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn(`xAI API returned error: ${generateResponse.status} ${generateResponse.statusText} ${errorText}`);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();

            if (persist) {
                const persisted = await persistAssistantReply(persist, generateResponseJson?.choices?.[0]?.message?.content ?? '', { data: generateResponseJson });
                attachStoredReply(generateResponseJson, persisted);
            }
            if (warnings?.length) generateResponseJson.warnings = warnings;

            return response.send(withStoredMessages(generateResponseJson, response));
        }
    } catch (error) {
        console.error('Error communicating with xAI API: ', error);
        if (!response.headersSent) {
            response.send({ error: true });
        } else {
            response.end();
        }
    }
}

/**
 * Sends a request to AI/ML API.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 * @param {object|null} [persist] `pendingAssistantPersist` from the `/generate` route (`null`/`undefined`
 * for every non-raw-action call). When set, persists the ASSISTANT's real reply text onto the message
 * tree via the shared `persistAssistantReply()`, for both streaming (teed via
 * `forwardAndPersistCompactStream()`) and non-streaming. AI/ML API's `/chat/completions` endpoint is
 * standard, verified OpenAI-Chat-Completions-shaped (`{choices: [{message: {content}}]}`
 * non-streaming, `{choices: [{delta: {content}}]}` per SSE chunk while streaming - see `requestBody`
 * above: this function always builds and sends a real `messages: [...]` request to that same
 * endpoint, an aggregator that proxies many underlying models but exposes a single uniform
 * OpenAI-compatible surface). Purely additive: the bytes/JSON actually sent to the client are
 * unaffected either way.
 * @param {Array<{kind: string, key: string, message: string, entries?: string[]}>|null} [warnings] The `/generate`
 * route's per-request warnings - passed to the stream writer, or set as the reply's `warnings`, only when non-empty.
 * @param {(() => void) | null} [onDispatched] Called once the backend request has been sent.
 */
async function sendAimlapiRequest(request, response, persist, warnings = null, onDispatched = null) {
    const apiUrl = API_AIMLAPI;
    const apiKey = readSecret(request.user.directories, SECRET_KEYS.AIMLAPI, request.body.secret_id);

    if (!apiKey) {
        console.warn('AI/ML API key is missing.');
        return response.status(400).send({ error: true });
    }

    const controller = stoppableController(response);
    request.socket.removeAllListeners('close');
    request.socket.on('close', function () {
        if (persist) return;
        controller.abort();
    });

    try {
        let bodyParams = {};

        if (request.body.logprobs > 0) {
            bodyParams['top_logprobs'] = request.body.logprobs;
            bodyParams['logprobs'] = true;
        }

        if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            bodyParams['tools'] = request.body.tools;
            bodyParams['tool_choice'] = request.body.tool_choice;
        }

        if (Array.isArray(request.body.stop) && request.body.stop.length > 0) {
            bodyParams['stop'] = request.body.stop;
        }

        if (request.body.reasoning_effort) {
            bodyParams['reasoning_effort'] = request.body.reasoning_effort;
        }

        if (request.body.json_schema) {
            bodyParams['response_format'] = {
                type: 'json_schema',
                json_schema: {
                    name: request.body.json_schema.name,
                    description: request.body.json_schema.description,
                    schema: request.body.json_schema.value,
                    strict: request.body.json_schema.strict ?? true,
                },
            };
        }

        const requestBody = {
            'messages': request.body.messages,
            'model': request.body.model,
            'temperature': request.body.temperature,
            'max_tokens': request.body.max_tokens,
            'stream': request.body.stream,
            'presence_penalty': request.body.presence_penalty,
            'frequency_penalty': request.body.frequency_penalty,
            'top_p': request.body.top_p,
            'seed': request.body.seed,
            'n': request.body.n,
            ...bodyParams,
        };

        const config = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
                ...AIMLAPI_HEADERS,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        };


        const generateResponse = await fetch(apiUrl + '/chat/completions', config);
        onDispatched?.();

        if (request.body.stream) {
            await forwardAndPersistCompactStream(generateResponse, response, persist, json => json?.choices?.[0]?.delta?.content, extractGenericReasoning, warnings);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn(`AI/ML API returned error: ${generateResponse.status} ${generateResponse.statusText} ${errorText}`);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();

            if (persist) {
                const persisted = await persistAssistantReply(persist, generateResponseJson?.choices?.[0]?.message?.content ?? '', { data: generateResponseJson });
                attachStoredReply(generateResponseJson, persisted);
            }
            if (warnings?.length) generateResponseJson.warnings = warnings;

            return response.send(withStoredMessages(generateResponseJson, response));
        }
    } catch (error) {
        console.error('Error communicating with AI/ML API: ', error);
        if (!response.headersSent) {
            response.send({ error: true });
        } else {
            response.end();
        }
    }
}

/**
 * Sends a request to Electron Hub.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 * @param {object|null} [persist] `pendingAssistantPersist` from the `/generate` route (`null`/`undefined`
 * for every non-raw-action call). When set, persists the ASSISTANT's real reply text onto the message
 * tree via the shared `persistAssistantReply()`, for both streaming (teed via
 * `forwardAndPersistCompactStream()`) and non-streaming. Electron Hub's `/chat/completions` endpoint is a
 * multi-model aggregator exposing a standard, verified OpenAI-Chat-Completions-shaped surface
 * (`{choices: [{message: {content}}]}` non-streaming, `{choices: [{delta: {content}}]}` per SSE chunk
 * while streaming - see `requestBody` above: this function always builds and sends a real
 * `messages: [...]` request to that same endpoint, no ElectronHub-specific response reshaping). No
 * reasoning/thinking-adjacent field (e.g. a separate `reasoning_content`) is read/exposed anywhere in
 * this function - checked, not assumed - so plain `content`/`delta.content` is the whole reply.
 * Purely additive: the bytes/JSON actually sent to the client are unaffected either way.
 * @param {Array<{kind: string, key: string, message: string, entries?: string[]}>|null} [warnings] The `/generate`
 * route's per-request warnings - passed to the stream writer, or set as the reply's `warnings`, only when non-empty.
 * @param {(() => void) | null} [onDispatched] Called once the backend request has been sent.
 */
async function sendElectronHubRequest(request, response, persist, warnings = null, onDispatched = null) {
    const apiUrl = API_ELECTRONHUB;
    const apiKey = readSecret(request.user.directories, SECRET_KEYS.ELECTRONHUB, request.body.secret_id);

    if (!apiKey) {
        console.warn('Electron Hub key is missing.');
        return response.status(400).send({ error: true });
    }

    const controller = stoppableController(response);
    request.socket.removeAllListeners('close');
    request.socket.on('close', function () {
        if (persist) return;
        controller.abort();
    });

    try {
        let bodyParams = {};

        if (request.body.enable_web_search) {
            bodyParams['web_search'] = true;
        }

        if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            bodyParams['tools'] = request.body.tools;
            bodyParams['tool_choice'] = request.body.tool_choice;
        }

        if (request.body.reasoning_effort) {
            bodyParams['reasoning_effort'] = request.body.reasoning_effort;
        }

        if (request.body.json_schema) {
            bodyParams['response_format'] = {
                type: 'json_schema',
                json_schema: {
                    name: request.body.json_schema.name,
                    description: request.body.json_schema.description,
                    schema: request.body.json_schema.value,
                    strict: request.body.json_schema.strict ?? true,
                },
            };
        }

        const isClaude = /^claude-/.test(request.body.model);

        if (Array.isArray(request.body.messages) && isClaude) {
            if (enableSystemPromptCache) {
                cachingSystemPromptForOpenRouter(request.body.messages, cacheTTL);
            }

            if (cachingAtDepth !== -1) {
                cachingAtDepthForOpenRouterClaude(request.body.messages, cachingAtDepth, cacheTTL);
            }
        }

        const requestBody = {
            'messages': request.body.messages,
            'model': request.body.model,
            'temperature': request.body.temperature,
            'max_tokens': request.body.max_tokens,
            'stream': request.body.stream,
            'presence_penalty': request.body.presence_penalty,
            'frequency_penalty': request.body.frequency_penalty,
            'top_p': request.body.top_p,
            'top_k': request.body.top_k,
            'logit_bias': request.body.logit_bias,
            'seed': request.body.seed,
            ...bodyParams,
        };

        const config = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        };


        const generateResponse = await fetch(apiUrl + '/chat/completions', config);
        onDispatched?.();

        if (request.body.stream) {
            await forwardAndPersistCompactStream(generateResponse, response, persist, json => json?.choices?.[0]?.delta?.content, extractGenericReasoning, warnings);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn('Electron Hub returned error: ', errorText);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();

            if (persist) {
                const persisted = await persistAssistantReply(persist, generateResponseJson?.choices?.[0]?.message?.content ?? '', { data: generateResponseJson });
                attachStoredReply(generateResponseJson, persisted);
            }
            if (warnings?.length) generateResponseJson.warnings = warnings;

            return response.send(withStoredMessages(generateResponseJson, response));
        }
    } catch (error) {
        console.error('Error communicating with Electron Hub: ', error);
        if (!response.headersSent) {
            response.send({ error: true });
        } else {
            response.end();
        }
    }
}

/**
 * Sends a request to Chutes.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 * @param {object|null} [persist] `pendingAssistantPersist` from the `/generate` route (`null`/`undefined`
 * for every non-raw-action call). When set, persists the ASSISTANT's real reply text onto the message
 * tree via the shared `persistAssistantReply()`, for both streaming (teed via
 * `forwardAndPersistCompactStream()`) and non-streaming. Chutes' `/chat/completions` endpoint is a
 * multi-model aggregator exposing a standard, verified OpenAI-Chat-Completions-shaped surface
 * (`{choices: [{message: {content}}]}` non-streaming, `{choices: [{delta: {content}}]}` per SSE chunk
 * while streaming - see `requestBody` above: this function always builds and sends a real
 * `messages: [...]` request to that same endpoint, no Chutes-specific response reshaping). Chutes
 * hosts reasoning-capable open models and this function does forward a `reasoning_effort` request
 * field, but no reasoning/thinking-adjacent RESPONSE field (e.g. a separate `reasoning_content`) is
 * read/exposed anywhere in this function - checked, not assumed - so plain `content`/`delta.content`
 * is the whole reply. Purely additive: the bytes/JSON actually sent to the client are unaffected
 * either way.
 * @param {Array<{kind: string, key: string, message: string, entries?: string[]}>|null} [warnings] The `/generate`
 * route's per-request warnings - passed to the stream writer, or set as the reply's `warnings`, only when non-empty.
 * @param {(() => void) | null} [onDispatched] Called once the backend request has been sent.
 */
async function sendChutesRequest(request, response, persist, warnings = null, onDispatched = null) {
    const apiUrl = API_CHUTES;
    const apiKey = readSecret(request.user.directories, SECRET_KEYS.CHUTES, request.body.secret_id);

    if (!apiKey) {
        console.warn('Chutes key is missing.');
        return response.status(400).send({ error: true });
    }

    const controller = stoppableController(response);
    request.socket.removeAllListeners('close');
    request.socket.on('close', function () {
        if (persist) return;
        controller.abort();
    });

    try {
        let bodyParams = {};

        if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            bodyParams['tools'] = request.body.tools;
            bodyParams['tool_choice'] = request.body.tool_choice;
        }

        if (request.body.logprobs > 0) {
            bodyParams['top_logprobs'] = request.body.logprobs;
            bodyParams['logprobs'] = true;
        }

        if (request.body.json_schema) {
            bodyParams['response_format'] = {
                type: 'json_schema',
                json_schema: {
                    name: request.body.json_schema.name,
                    description: request.body.json_schema.description,
                    schema: request.body.json_schema.value,
                    strict: request.body.json_schema.strict ?? true,
                },
            };
        }

        const requestBody = {
            'messages': request.body.messages,
            'model': request.body.model,
            'temperature': request.body.temperature,
            'max_tokens': request.body.max_tokens,
            'stream': request.body.stream,
            'presence_penalty': request.body.presence_penalty,
            'frequency_penalty': request.body.frequency_penalty,
            'repetition_penalty': request.body.repetition_penalty,
            'min_p': request.body.min_p,
            'top_p': request.body.top_p,
            'top_k': request.body.top_k,
            'seed': request.body.seed,
            'stop': request.body.stop,
            'reasoning_effort': request.body.reasoning_effort,
            'logit_bias': request.body.logit_bias,
            ...bodyParams,
        };

        const config = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        };


        const generateResponse = await fetch(apiUrl + '/chat/completions', config);
        onDispatched?.();

        if (request.body.stream) {
            await forwardAndPersistCompactStream(generateResponse, response, persist, json => json?.choices?.[0]?.delta?.content, extractGenericReasoning, warnings);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn('Chutes returned error: ', errorText);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();

            if (persist) {
                const persisted = await persistAssistantReply(persist, generateResponseJson?.choices?.[0]?.message?.content ?? '', { data: generateResponseJson });
                attachStoredReply(generateResponseJson, persisted);
            }
            if (warnings?.length) generateResponseJson.warnings = warnings;

            return response.send(withStoredMessages(generateResponseJson, response));
        }
    } catch (error) {
        console.error('Error communicating with Chutes: ', error);
        if (!response.headersSent) {
            response.send({ error: true });
        } else {
            response.end();
        }
    }
}

/**
 * Sends a request to MiniMax.
 * @param {express.Request} request Express request
 * @param {express.Response} response Express response
 * @param {object|null} [persist] `pendingAssistantPersist` from the `/generate` route (`null`/`undefined`
 * for every non-raw-action call). When set, persists the ASSISTANT's real reply text onto the message
 * tree via the shared `persistAssistantReply()`, for both streaming (teed via
 * `forwardAndPersistCompactStream()`) and non-streaming. This function targets MiniMax's own
 * `/chat/completions` endpoint (`apiUrl` above, either the global or CN host) with a real
 * `messages: [...]` request body it builds itself (`requestBody` above) - it does NOT build a
 * MiniMax-native-shaped request, and does not reshape the response in any way before
 * `response.send(generateResponseJson)`, so no MakerSuite/Cohere-style reuse of a pre-existing
 * reshaped `responseText` applies here: this is a standard, verified OpenAI-Chat-Completions-shaped
 * body (`{choices: [{message: {content}}]}` non-streaming, `{choices: [{delta: {content}}]}` per SSE
 * chunk while streaming), same as AI21/MistralAI/DeepSeek/AI-ML-API/xAI/Chutes/ElectronHub. No
 * reasoning/thinking-adjacent field (e.g. a separate `reasoning_content`) is read/exposed anywhere in
 * this function - checked, not assumed - so plain `content`/`delta.content` is the whole reply.
 * Purely additive: the bytes/JSON actually sent to the client are unaffected either way.
 * @param {Array<{kind: string, key: string, message: string, entries?: string[]}>|null} [warnings] The `/generate`
 * route's per-request warnings - passed to the stream writer, or set as the reply's `warnings`, only when non-empty.
 * @param {(() => void) | null} [onDispatched] Called once the backend request has been sent.
 */
async function sendMinimaxRequest(request, response, persist, warnings = null, onDispatched = null) {
    const apiUrl = request.body.minimax_endpoint === MINIMAX_ENDPOINT.CN
        ? API_MINIMAX_CN : API_MINIMAX;
    const apiKey = readSecret(request.user.directories, SECRET_KEYS.MINIMAX, request.body.secret_id);

    if (!apiKey) {
        console.warn('MiniMax key is missing.');
        return response.status(400).send({ error: true });
    }

    const controller = stoppableController(response);
    request.socket.removeAllListeners('close');
    request.socket.on('close', function () {
        if (persist) return;
        controller.abort();
    });

    try {
        // MiniMax does not allow consecutive messages with the same role.
        // Merge them into a single message to avoid "invalid chat setting (2013)".
        const messages = postProcessPrompt(request.body.messages, PROMPT_PROCESSING_TYPE.MERGE_TOOLS, getPromptNames(request));

        let bodyParams = {};

        if (Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            bodyParams['tools'] = request.body.tools;
            bodyParams['tool_choice'] = request.body.tool_choice;
        }

        const requestBody = {
            'messages': messages,
            'model': request.body.model,
            'temperature': request.body.temperature,
            'max_tokens': request.body.model === 'M2-her' ? Math.min(request.body.max_tokens, 2048) : request.body.max_tokens,
            'stream': request.body.stream,
            'top_p': request.body.top_p,
            'stop': request.body.stop,
            ...bodyParams,
        };

        const config = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        };


        const generateResponse = await fetch(apiUrl + '/chat/completions', config);
        onDispatched?.();

        if (request.body.stream) {
            await forwardAndPersistCompactStream(generateResponse, response, persist, json => json?.choices?.[0]?.delta?.content, null, warnings);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn('MiniMax returned error: ', errorText);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();

            if (persist) {
                const persisted = await persistAssistantReply(persist, generateResponseJson?.choices?.[0]?.message?.content ?? '', { data: generateResponseJson });
                attachStoredReply(generateResponseJson, persisted);
            }
            if (warnings?.length) generateResponseJson.warnings = warnings;

            return response.send(withStoredMessages(generateResponseJson, response));
        }
    } catch (error) {
        console.error('Error communicating with MiniMax: ', error);
        if (!response.headersSent) {
            response.send({ error: true });
        } else {
            response.end();
        }
    }
}

/**
 * @param {express.Request} request Express request object (contains request.body with all generate_data)
 * @param {express.Response} response Express response object
 * @param {object|null} [persist] `pendingAssistantPersist` from the `/generate` route (`null`/`undefined`
 * for every non-raw-action call). When set, persists the ASSISTANT's real reply text onto the message
 * tree via the shared `persistAssistantReply()`, for both streaming (teed via
 * `forwardAndPersistCompactStream()`) and non-streaming. Azure OpenAI's deployment-based URL/auth scheme
 * (`azure_base_url`/`azure_deployment_name`/`azure_api_version`/`api-key` header - see `url`/`config`
 * above) only affects WHERE/HOW the request is sent, never the response shape: Azure serves Microsoft's
 * own hosted copy of the real OpenAI Chat Completions API, so the response body this function already
 * forwards unmodified (`response.send(json)`) is standard, verified OpenAI-Chat-Completions-shaped
 * (`{choices: [{message: {content}}]}` non-streaming, `{choices: [{delta: {content}}]}` per SSE chunk
 * while streaming). Azure can front reasoning models (this function forwards `reasoning_effort` for
 * `OPENAI_REASONING_EFFORT_MODELS`), but no reasoning/thinking-adjacent RESPONSE field (e.g. a separate
 * `reasoning_content`) is read/exposed anywhere in this function - checked, not assumed - so plain
 * `content`/`delta.content` is the whole reply. Purely additive: the bytes/JSON actually sent to the
 * client are unaffected either way.
 * @param {Array<{kind: string, key: string, message: string, entries?: string[]}>|null} [warnings] The `/generate`
 * route's per-request warnings - passed to the stream writer, or set as the reply's `warnings`, only when non-empty.
 * @param {(() => void) | null} [onDispatched] Called once the backend request has been sent.
 */
async function sendAzureOpenAIRequest(request, response, persist, warnings = null, onDispatched = null) {
    // 1. GATHER & VALIDATE SETTINGS
    const { azure_base_url, azure_deployment_name, azure_api_version } = request.body;
    const apiKey = readSecret(request.user.directories, SECRET_KEYS.AZURE_OPENAI, request.body.secret_id);
    if (!azure_base_url || !azure_deployment_name || !azure_api_version || !apiKey) {
        return response.status(400).send({
            error: {
                message: 'Azure OpenAI configuration is incomplete. Please provide Base URL, Deployment Name, API Version, and API Key in the connection settings.',
            },
        });
    }

    // 2. PREPARE THE REQUEST
    const url = new URL(`/openai/deployments/${azure_deployment_name}/chat/completions`, azure_base_url);
    url.searchParams.set('api-version', azure_api_version);
    const endpointUrl = url.toString();

    // Create the base payload with all standard parameters
    const apiRequestBody = /** @type {any} */ ({});
    for (const key of AZURE_OPENAI_KEYS) {
        if (Object.hasOwn(request.body, key)) {
            apiRequestBody[key] = request.body[key];
        }
    }

    // Handle Structured Output (JSON Mode) by translating the custom `json_schema` object.
    if (request.body.json_schema) {
        apiRequestBody['response_format'] = {
            type: 'json_schema',
            json_schema: {
                name: request.body.json_schema.name,
                strict: request.body.json_schema.strict ?? true,
                schema: request.body.json_schema.value,
            },
        };
    }

    // Adjust logprobs for Azure OpenAI, which follows the OpenAI Chat Completions API spec.
    if (typeof apiRequestBody.logprobs === 'number' && apiRequestBody.logprobs > 0) {
        apiRequestBody.top_logprobs = apiRequestBody.logprobs;
        apiRequestBody.logprobs = true;
    }

    // Do not send reasoning effort to models which do not support it
    apiRequestBody['reasoning_effort'] = OPENAI_REASONING_EFFORT_MODELS.includes(request.body.model)
        ? OPENAI_FIXED_REASONING_EFFORT[request.body.model] ?? OPENAI_REASONING_EFFORT_MAP[request.body.reasoning_effort] ?? request.body.reasoning_effort
        : undefined;

    const controller = stoppableController(response);
    request.socket.removeAllListeners('close');
    request.socket.on('close', () => { if (!persist) controller.abort(); });

    const config = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'api-key': apiKey,
        },
        body: JSON.stringify(apiRequestBody),
        signal: controller.signal,
    };

    try {
        const fetchResponse = await fetch(endpointUrl, config);
        onDispatched?.();

        if (request.body.stream) {
            return await forwardAndPersistCompactStream(fetchResponse, response, persist, json => json?.choices?.[0]?.delta?.content, null, warnings);
        }

        if (fetchResponse.ok) {
            /** @type {any} */
            const json = await fetchResponse.json();

            if (persist) {
                const persisted = await persistAssistantReply(persist, json?.choices?.[0]?.message?.content ?? '', { data: json });
                attachStoredReply(json, persisted);
            }
            if (warnings?.length) json.warnings = warnings;

            return response.send(withStoredMessages(json, response));
        }

        const text = await fetchResponse.text();
        const data = tryParse(text) || { error: { message: fetchResponse.statusText || 'Unknown error occurred' } };
        return response.status(500).send(data);
    } catch (error) {
        const message = error.name === 'AbortError'
            ? 'Request was aborted by the client.'
            : (error.message || 'An unknown network error occurred.');
        return response.status(500).send({ error: { message, ...error } });
    }
}

export const router = express.Router();

router.post('/status', async function (request, statusResponse) {
    try {
        if (!request.body) return statusResponse.sendStatus(400);

        let apiUrl = '';
        let apiKey = '';
        let headers = {};
        let queryParams = {};

        if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.OPENAI) {
            apiUrl = new URL(request.body.reverse_proxy || API_OPENAI).toString();
            apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.OPENAI, request.body.secret_id);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.OPENROUTER) {
            apiUrl = 'https://openrouter.ai/api/v1';
            apiKey = readSecret(request.user.directories, SECRET_KEYS.OPENROUTER, request.body.secret_id);
            // OpenRouter needs to pass the Referer and X-Title: https://openrouter.ai/docs#requests
            headers = { ...OPENROUTER_HEADERS };
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.MISTRALAI) {
            apiUrl = new URL(request.body.reverse_proxy || API_MISTRAL).toString();
            apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.MISTRALAI, request.body.secret_id);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.CUSTOM) {
            apiUrl = request.body.custom_url;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.CUSTOM, request.body.secret_id);
            headers = {};
            mergeObjectWithYaml(headers, request.body.custom_include_headers);
            void refreshLlamaCppDetection(apiUrl, { 'Authorization': 'Bearer ' + apiKey, ...headers });
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.COHERE) {
            apiUrl = API_COHERE_V1;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.COHERE, request.body.secret_id);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.CHUTES) {
            apiUrl = API_CHUTES;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.CHUTES, request.body.secret_id);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.ELECTRONHUB) {
            apiUrl = API_ELECTRONHUB;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.ELECTRONHUB, request.body.secret_id);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.NANOGPT) {
            apiUrl = API_NANOGPT;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.NANOGPT, request.body.secret_id);
            headers = {};
            queryParams = { detailed: true };
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.DEEPSEEK) {
            apiUrl = new URL(request.body.reverse_proxy || API_DEEPSEEK.replace('/beta', '')).toString();
            apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.DEEPSEEK, request.body.secret_id);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.XAI) {
            apiUrl = new URL(request.body.reverse_proxy || API_XAI).toString();
            apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.XAI, request.body.secret_id);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.AIMLAPI) {
            apiUrl = API_AIMLAPI;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.AIMLAPI, request.body.secret_id);
            headers = { ...AIMLAPI_HEADERS };
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.POLLINATIONS) {
            const isAnonymous = request.body.pollinations_endpoint === POLLINATIONS_ENDPOINT.ANONYMOUS;
            apiUrl = 'https://gen.pollinations.ai/text';
            apiKey = isAnonymous ? 'anonymous' : readSecret(request.user.directories, SECRET_KEYS.POLLINATIONS, request.body.secret_id);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.GROQ) {
            apiUrl = API_GROQ;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.GROQ, request.body.secret_id);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.COMETAPI) {
            apiUrl = API_COMETAPI;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.COMETAPI, request.body.secret_id);
            headers = {};
            throw new Error('This provider is temporarily disabled.');
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.MOONSHOT) {
            apiUrl = new URL(request.body.reverse_proxy || API_MOONSHOT).toString();
            apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.MOONSHOT, request.body.secret_id);
            headers = {};
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.FIREWORKS) {
            apiKey = readSecret(request.user.directories, SECRET_KEYS.FIREWORKS, request.body.secret_id);
            const modelsUrl = 'https://api.fireworks.ai/v1/accounts/fireworks/models?filter=supports_serverless%3Dtrue&pageSize=200';

            try {
                const response = await fetch(modelsUrl, {
                    method: 'GET',
                    headers: {
                        'Authorization': 'Bearer ' + apiKey,
                        ...headers,
                    },
                });

                if (response.ok) {
                    /** @type {any} */
                    const data = await response.json();
                    const models = Array.isArray(data?.models)
                        ? data.models
                            .filter(m => m?.contextLength > 0 && m?.kind !== 'EMBEDDING_MODEL')
                            .map(m => ({
                                id: m.name,
                                name: m.displayName,
                                context_length: m.contextLength,
                                supports_tools: m.supportsTools,
                                supports_image_input: m.supportsImageInput,
                            }))
                        : [];

                    // Add fast router versions for models that have them
                    const fastRouters = {
                        'accounts/fireworks/models/glm-5p2': 'accounts/fireworks/routers/glm-5p2-fast',
                        'accounts/fireworks/models/kimi-k2p6': 'accounts/fireworks/routers/kimi-k2p6-fast',
                        'accounts/fireworks/models/kimi-k2p7-code': 'accounts/fireworks/routers/kimi-k2p7-code-fast',
                        'accounts/fireworks/models/kimi-k3': 'accounts/fireworks/routers/kimi-k3-fast',
                    };
                    for (const [standardId, fastId] of Object.entries(fastRouters)) {
                        const standard = models.find(m => m.id === standardId);
                        if (standard) {
                            models.push({
                                ...standard,
                                id: fastId,
                                name: standard.name + ' (fast)',
                            });
                        }
                    }

                    console.debug('Available Fireworks models:', models.map(m => m.id));
                    return statusResponse.send({ data: models });
                } else {
                    console.warn('Fireworks models endpoint failed:', response.status, response.statusText);
                    return statusResponse.send({ error: true, data: { data: [] } });
                }
            } catch (error) {
                console.error('Error fetching Fireworks models:', error);
                return statusResponse.send({ error: true, data: { data: [] } });
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.MAKERSUITE) {
            apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.MAKERSUITE, request.body.secret_id);
            apiUrl = trimTrailingSlash(request.body.reverse_proxy || API_MAKERSUITE);
            const apiVersion = getConfigValue('gemini.apiVersion', 'v1beta');
            const modelsUrl = !apiKey && request.body.reverse_proxy
                ? `${apiUrl}/${apiVersion}/models`
                : `${apiUrl}/${apiVersion}/models?key=${apiKey}`;

            if (!apiKey && !request.body.reverse_proxy) {
                console.warn('Google AI Studio API key is missing.');
                return statusResponse.status(400).send({ error: true });
            }

            try {
                const models = await fetchGoogleModels(modelsUrl);
                console.info('Available Google AI Studio models:', models.map(m => m.id));
                return statusResponse.send({ data: models });
            } catch (error) {
                if (error instanceof GoogleModelsHttpError) {
                    console.warn('Google AI Studio models endpoint failed:', error.status, error.statusText);
                    return statusResponse.send({ error: true, bypass: true, data: { data: [] } });
                }

                console.error('Error fetching Google AI Studio models:', error);
                return statusResponse.send({ error: true, bypass: true, data: { data: [] } });
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.AZURE_OPENAI) {
            const { azure_base_url, azure_deployment_name, azure_api_version } = request.body;
            const apiKey = readSecret(request.user.directories, SECRET_KEYS.AZURE_OPENAI, request.body.secret_id);

            // 1) Validate configuration from the frontend
            if (!apiKey || !azure_base_url || !azure_deployment_name || !azure_api_version) {
                console.warn('Azure OpenAI status check failed: missing config from frontend.');
                return statusResponse.status(400).send({ error: true, message: 'Azure configuration is incomplete.' });
            }
            // 2) Build URLs using the URL API for consistency and robustness.
            const modelsUrl = new URL('/openai/models', azure_base_url);
            modelsUrl.searchParams.set('api-version', azure_api_version);

            const chatUrl = new URL(`/openai/deployments/${azure_deployment_name}/chat/completions`, azure_base_url);
            chatUrl.searchParams.set('api-version', azure_api_version);

            // Map common status codes to user-friendly error messages
            const azureStatusErrorMap = {
                400: 'API version may be invalid for this resource.',
                401: 'Invalid API key or insufficient permissions.',
                403: 'Invalid API key or insufficient permissions.',
                404: 'Endpoint URL appears incorrect (404).',
            };

            try {
                // ---- A) GET /models: fast sanity check for endpoint + api key + api version ----
                const apiConfigTest = await fetch(modelsUrl, {
                    method: 'GET',
                    headers: { 'api-key': apiKey, 'Accept': 'application/json' },
                });

                if (!apiConfigTest.ok) {
                    let errText = '';
                    try { errText = await apiConfigTest.text(); } catch { /* response body may be empty */ }

                    console.warn('Azure OpenAI GET /models failed:', apiConfigTest.status, apiConfigTest.statusText, errText || '');

                    const defaultMessage = `Azure Models endpoint error: ${apiConfigTest.statusText}`;
                    const message = azureStatusErrorMap[apiConfigTest.status] ?? defaultMessage;
                    return statusResponse.status(apiConfigTest.status).send({ error: true, message });
                }

                // ---- B) POST /chat/completions: verify deployment + read underlying model ID ----
                // Small, deterministic probe to minimize cost/latency
                const modelPayload = {
                    messages: [{ role: 'user', content: 'Say word Hi' }],
                    stream: false,
                    max_completion_tokens: 5,
                };

                const modelRequest = await fetch(chatUrl, {
                    method: 'POST',
                    headers: { 'api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify(modelPayload),
                });

                let modelResponse;
                try {
                    modelResponse = await modelRequest.json();
                } catch {
                    modelResponse = { raw: 'Failed to parse JSON response from chat completions probe.' };
                }

                const modelId = /** @type {any} */ (modelResponse)?.model;
                if (!modelId) {
                    console.warn('Azure status check succeeded but could not find a model ID in the response.');
                    console.debug('Azure Response Body:', modelResponse);
                    // Keep a benign success to avoid UX disruption in the UI
                    return statusResponse.send({ data: [] });
                }

                console.info(color.green('Azure OpenAI connection successful. Detected model:'), modelId);
                // Consistent response format: always an array of { id }
                return statusResponse.send({ data: [{ id: modelId }] });
            } catch (error) {
                console.error('Azure OpenAI status check connection error:', error);
                return statusResponse.status(500).send({ error: true, message: 'Failed to connect to the Azure endpoint.' });
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.SILICONFLOW) {
            const defaultApiUrl = request.body.siliconflow_endpoint === SILICONFLOW_ENDPOINT.CN
                ? API_SILICONFLOW_CN : API_SILICONFLOW;
            apiUrl = defaultApiUrl;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.SILICONFLOW, request.body.secret_id);
            headers = {};
            queryParams = { type: 'text', sub_type: 'chat' };
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.WORKERS_AI) {
            apiKey = readSecret(request.user.directories, SECRET_KEYS.WORKERS_AI, request.body.secret_id);

            if (!apiKey) {
                console.warn('Cloudflare Workers AI API key is missing.');
                return statusResponse.status(400).send({ error: true });
            }

            try {
                const accountId = String(request.body.workers_ai_account_id || '').trim();
                if (!accountId) {
                    console.warn('Cloudflare Workers AI Account ID is missing.');
                    return statusResponse.status(400).send({ error: true });
                }

                const modelsUrl = new URL(`${API_WORKERS_AI}/${encodeURIComponent(accountId)}/ai/models/search`);
                modelsUrl.searchParams.set('task', 'Text Generation');
                modelsUrl.searchParams.set('per_page', '1000');

                const response = await fetch(modelsUrl, {
                    method: 'GET',
                    headers: {
                        'Authorization': 'Bearer ' + apiKey,
                    },
                });

                if (response.ok) {
                    /** @type {any} */
                    const data = await response.json();
                    const models = Array.isArray(data?.result)
                        ? data.result.map(model => ({ ...model, id: model.name }))
                        : [];

                    console.debug('Available Cloudflare Workers AI models:', models.map(m => m.id));
                    return statusResponse.send({ data: models });
                } else {
                    console.warn('Cloudflare Workers AI models endpoint failed:', response.status, response.statusText);
                    return statusResponse.status(response.status).send({ error: true });
                }
            } catch (error) {
                console.error('Error fetching Cloudflare Workers AI models:', error);
                return statusResponse.status(500).send({ error: true });
            }
        } else {
            console.warn('This chat completion source is not supported yet.');
            return statusResponse.status(400).send({ error: true });
        }

        if (!apiKey && !request.body.reverse_proxy && request.body.chat_completion_source !== CHAT_COMPLETION_SOURCES.CUSTOM) {
            console.warn('Chat Completion API key is missing.');
            return statusResponse.status(400).send({ error: true });
        }

        const modelsUrl = new URL(urlJoin(apiUrl, '/models'));
        Object.keys(queryParams).forEach(key => {
            modelsUrl.searchParams.append(key, queryParams[key]);
        });
        const response = await fetch(modelsUrl, {
            method: 'GET',
            headers: {
                'Authorization': 'Bearer ' + apiKey,
                ...headers,
            },
        });

        if (response.ok) {
            /** @type {any} */
            let data = await response.json();

            if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.POLLINATIONS && Array.isArray(data)) {
                data = { data: data.map(model => ({ id: model.name, ...model })) };
            }

            if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.CHUTES && Array.isArray(data?.data)) {
                data.data = data.data
                    .filter(model => model?.id)
                    .map(model => {
                        if (model.pricing?.prompt !== undefined && model.pricing?.completion !== undefined) {
                            return {
                                ...model,
                                pricing: {
                                    ...model.pricing,
                                    input: model.pricing.prompt,
                                    output: model.pricing.completion,
                                },
                            };
                        }
                        return model;
                    });
            }

            statusResponse.send(data);

            if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.COHERE && Array.isArray(data?.models)) {
                data.data = data.models.map(model => ({ id: model.name, ...model }));
            }

            if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.OPENROUTER && Array.isArray(data?.data)) {
                rememberOpenRouterModels(data.data);
                let models = [];

                data.data.forEach(model => {
                    const context_length = model.context_length;
                    const tokens_dollar = Number(1 / (1000 * model.pricing?.prompt));
                    const tokens_rounded = (Math.round(tokens_dollar * 1000) / 1000).toFixed(0);
                    models[model.id] = {
                        tokens_per_dollar: tokens_rounded + 'k',
                        context_length: context_length,
                    };
                });

                console.info('Available OpenRouter models:', models);
            } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.MISTRALAI) {
                // no-op
            } else {
                const models = data?.data;

                if (Array.isArray(models)) {
                    const modelIds = models.filter(x => x && typeof x === 'object').map(x => x.id).sort();
                    console.info('Available models:', modelIds);
                } else {
                    console.warn('Chat Completion endpoint did not return a list of models.');
                }
            }
        } else {
            console.error('Chat Completion status check failed. Either Access Token is incorrect or API endpoint is down.');
            statusResponse.send({ error: true, data: { data: [] } });
        }
    } catch (e) {
        console.error(e);

        if (!statusResponse.headersSent) {
            statusResponse.send({ error: true });
        } else {
            statusResponse.end();
        }
    }
});

/**
 * @param {string} source
 * @param {string|null|undefined} model
 * @param {string[]} droppedEntries
 * @param {import('../../tokenizer-resolve.js').TokenizerOutcome} [outcome]
 * @param {import('../../tokenizer-map-resolution.js').ChatCompletionConnection} [connection]
 * @returns {Promise<Array<{kind: string, key: string, message: string, entries?: string[]}>>}
 */
async function chatCompletionSendWarnings(source, model, droppedEntries, outcome = createTokenizerOutcome(), connection = {}) {
    if (droppedEntries.length === 0 && !outcome.countEstimated && !outcome.usedCopy && !outcome.downloads?.length) {
        return [];
    }
    const state = { api: 'openai', source, model: model ?? '', ...(source === CHAT_COMPLETION_SOURCES.CUSTOM ? { url: connection.url } : {}) };
    return sendTokenizerWarnings(state, await resolveTokenizer(state, connection), outcome, droppedEntries);
}

/**
 * @param {any} settings
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {object} macroContext
 * @param {import('../../llamacpp-props.js').LlamaCppPropsCheck} [llamaCppProps]
 * @returns {import('../../tokenizer-map-resolution.js').ChatCompletionConnection}
 */
function chatCompletionConnection(settings, directories, macroContext, llamaCppProps = undefined) {
    if (settings.chat_completion_source !== CHAT_COMPLETION_SOURCES.CUSTOM) {
        return { directories };
    }
    return { url: settings.custom_url, directories, customIncludeHeaders: substituteParams(settings.custom_include_headers, macroContext), llamaCppProps };
}

/**
 * @param {any} value
 * @returns {string}
 */
function toAsciiJson(value) {
    return JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

router.post('/bias', async function (request, response) {
    if (!request.body || !Array.isArray(request.body))
        return response.sendStatus(400);

    const state = readConnectionStateHeader(request);
    if (state === null) {
        return response.sendStatus(400);
    }

    try {
        if (state) {
            const dropped = [];
            const result = await computeLogitBias(request.body, state.model ?? '', dropped, state.source, { url: state.url, directories: request.user.directories });
            response.set('X-ST-Tokenizer-Dropped', toAsciiJson(dropped));
            return response.send(result);
        }
        const result = await computeUpstreamLogitBias(request.body, String(request.query.model || ''));
        return response.send(result);
    } catch (error) {
        console.error(error);
        return response.send({});
    }
});

const SERVER_TOOL_ROUND_LIMIT = 5;

/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {object} params
 * @param {string} [params.characterAvatar]
 * @param {string} [params.groupId]
 * @param {string} params.ownerId
 * @param {import('../../chat-request.js').ChatContext} params.chat
 * @param {string|null} params.nodeId
 * @param {string} [params.type]
 * @param {boolean} [params.isImpersonate]
 * @param {boolean} [params.isContinue]
 * @param {boolean} [params.isSwipe]
 * @param {string} [params.userMessageText]
 * @param {import('../../macro-facts.js').PageMacroFacts} [params.pageFacts]
 * @param {import('../../extension-prompt-table.js').ExtensionPromptTable} [params.pageInjections]
 * @param {object} [params.userMessageExtra]
 * @param {any[]} [params.clientToolSchemas]
 * @param {object} [params.jsonSchema]
 * @param {string[]} [params.stealthClientToolNames]
 * @param {import('../../page-writes.js').QuietPrompt} [params.quiet]
 * @returns {Promise<{ params: object, settings: object, anchorNodeId: string|null, anchorContent: object|null, name1: string, name2: string, enabledServerTools: import('../../server-tools.js').ServerToolRegistration[], enabledClientToolNames: Set<string>, enabledStealthClientToolNames: Set<string>, warnings: Array<{kind: string, key: string, message: string, entries?: string[]}>, tokenCountRows: import('../../token-count-store.js').PendingTokenRows }>}
 */
export async function buildRawActionChatCompletionRequest(directories, {
    characterAvatar, groupId, ownerId, chat, nodeId,
    type = 'normal', isImpersonate = false, isContinue = false, isSwipe = false, userMessageText, userMessageExtra, pageFacts = {}, pageInjections = {},
    clientToolSchemas, stealthClientToolNames, jsonSchema = null, quiet = {}, responseLength,
} = {}) {
    if (!ownerId) {
        throw new Error('owner_id is required');
    }
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
        } catch { /* treated as not-found below, matching buildRawActionTextCompletionRequest()'s convention */ }
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

    const { oai_settings: savedSettings = {}, power_user: powerUser = {} } = readSettingsFor(directories, settingsContextOf({ avatar: characterAvatar, groupId, chat, nodeId }), ['oai_settings', 'power_user']);
    const settings = responseLength === undefined ? savedSettings : { ...savedSettings, openai_max_tokens: responseLength };

    const mediaInliningEnabled = Boolean(settings.media_inlining);
    const llamaCppProps = createLlamaCppPropsCheck({ reuse: false });
    /** @type {import('../../token-count-store.js').PendingTokenRows} */
    const tokenCountRows = { counts: [], ids: [] };
    const orchestratorInput = await resolveChatCompletionGenerationInput(directories, {
        avatar: characterAvatar, groupId, chatContext: chat, nodeId,
        type, isImpersonate, isContinue, isSwipe, userMessageText, userMessageExtra, pageFacts, pageInjections, llamaCppProps, tokenCountRows,
        quietPrompt: quiet.quietPrompt, quietImage: quiet.quietImage, responseLength,
        macroExtras: {
            imageInlining: mediaInliningEnabled, videoInlining: mediaInliningEnabled, audioInlining: mediaInliningEnabled,
        },
    });

    if (nodeId === null) {
        if (orchestratorInput.chatResolutionAmbiguous) {
            throw new Error('node_id is required: this chat is not at its start - pass the node_id of the message to generate from (null is only valid in a new chat)');
        }
        anchorNodeId = orchestratorInput.resolvedNodeId;
    }

    if ((isContinue || isSwipe) && orchestratorInput.rawChatLength === 0) {
        throw new Error('Cannot continue/swipe an empty chat.');
    }

    const { chat: messages } = await prepareOpenAIMessages(orchestratorInput, false);

    const biasPresetEntries = settings.bias_preset_selected ? settings.bias_presets?.[settings.bias_preset_selected] : undefined;
    const useLogprobs = Boolean(powerUser.request_token_probabilities);
    const serverToolCtx = { directories, ownerId, characterAvatar, groupId };
    const enabledServerTools = await getEnabledServerTools(serverToolCtx);
    const serverToolNames = new Set(enabledServerTools.map(tool => tool.name));

    const clientToolsByName = new Map();
    if (Array.isArray(clientToolSchemas)) {
        for (const entry of clientToolSchemas) {
            const name = entry?.function?.name;
            if (entry?.type !== 'function' || typeof name !== 'string' || !name || typeof entry.function.description !== 'string') {
                continue;
            }
            if (serverToolNames.has(name)) {
                console.warn(color.yellow(`Dropping client-advertised tool "${name}": a server-native tool with this name is already registered and takes priority.`));
                continue;
            }
            if (!clientToolsByName.has(name)) {
                clientToolsByName.set(name, entry);
            }
        }
    }
    const enabledClientToolNames = new Set(clientToolsByName.keys());

    const enabledStealthClientToolNames = new Set(
        Array.isArray(stealthClientToolNames)
            ? stealthClientToolNames.filter(name => typeof name === 'string' && enabledClientToolNames.has(name))
            : [],
    );

    const combinedToolSchemas = [...enabledServerTools.map(toOpenAIToolSchema), ...clientToolsByName.values()];
    const toolsPayload = combinedToolSchemas.length > 0
        ? { tools: combinedToolSchemas, tool_choice: 'auto' }
        : undefined;
    /** @type {string[]} */
    const droppedBiasEntries = [];
    const { generate_data } = await createGenerationParameters(settings, orchestratorInput.model, type, messages, {
        directories,
        macroContext: orchestratorInput.macroContext,
        biasPresetEntries,
        droppedBiasEntries,
        useLogprobs,
        chatId: anchorNodeId,
        toolsPayload,
        jsonSchema,
        llamaCppProps,
        tokenCountRows,
    });

    const anchorChat = orchestratorInput.macroContext.chat;
    const anchorContent = anchorChat.length > 0 ? anchorChat[anchorChat.length - 1] : null;

    const warnings = await chatCompletionSendWarnings(settings.chat_completion_source, orchestratorInput.model, droppedBiasEntries, orchestratorInput.tokenizerOutcome,
        chatCompletionConnection(settings, directories, orchestratorInput.macroContext, llamaCppProps));

    return {
        params: generate_data, settings, anchorNodeId, anchorContent, name1: orchestratorInput.macroContext.name1, name2: orchestratorInput.name2, enabledServerTools, enabledClientToolNames, enabledStealthClientToolNames, warnings, tokenCountRows,
        macroVariables: macroVariableChanges(orchestratorInput.macroContext.chatMetadata, orchestratorInput.macroContext.globalVariables, orchestratorInput.variablesBefore),
    };
}

/**
 * @param {import('express').Response} res
 */
function createChatCompactStreamWriter(res) {
    /** @type {Buffer[]} */
    let pending = [];
    let waitingDrain = false;
    let ended = false;

    function flush() {
        if (waitingDrain || ended || pending.length === 0 || res.writableEnded) return;
        const chunk = pending.length === 1 ? pending[0] : Buffer.concat(pending);
        pending = [];
        const ok = res.write(chunk);
        if (!ok) {
            waitingDrain = true;
            res.once('drain', () => {
                waitingDrain = false;
                flush();
            });
        }
    }

    return {
        write(/** @type {Buffer} */ buf) {
            if (ended || res.writableEnded || !buf || !buf.length) return;
            pending.push(buf);
            flush();
        },
        end() {
            if (ended) return;
            ended = true;
            if (res.writableEnded) {
                pending = [];
                return;
            }
            if (pending.length) {
                const chunk = Buffer.concat(pending);
                pending = [];
                res.end(chunk);
            } else {
                res.end();
            }
        },
    };
}

function extractGenericReasoning(json) {
    return json?.choices?.find(choice => choice?.delta?.reasoning_content)?.delta?.reasoning_content
        ?? json?.choices?.find(choice => choice?.delta?.reasoning)?.delta?.reasoning
        ?? undefined;
}

/**
 * @param {import('node-fetch').Response} fetchResponse
 * @param {import('express').Response} response
 * @param {object|null|undefined} persist
 * @param {(json: any) => string|undefined} extractText
 * @param {((json: any) => string|undefined)|null} [extractReasoning]
 * @param {Array<{kind: string, key: string, message: string, entries?: string[]}>|null} [warnings]
 * @returns {Promise<void>}
 */
async function forwardAndPersistCompactStream(fetchResponse, response, persist, extractText, extractReasoning = null, warnings = null) {
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

    const generationRecord = createGenerationRecord(generationId);
    const { writer: initialWriter, stopKeepalive } = createResumableWriter(createChatCompactStreamWriter(response), generationRecord);
    let writer = initialWriter;
    writeStoredMessagesFrame(writer, response);
    if (warnings?.length) {
        writer.write(encodeControlFrame({ warnings }));
    }
    let sseBuffer = '';
    let accumulatedText = '';
    let lastIndex = 0;

    let contentBuffer = '';
    let firstContentSent = false;
    let flushTimer = null;
    const FLUSH_INTERVAL_MS = 40;
    const FLUSH_BYTES = 256;

    function clearFlushTimer() {
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
    }

    function flushContentBuffer() {
        clearFlushTimer();
        if (!contentBuffer) return;
        const text = contentBuffer;
        contentBuffer = '';
        writer.write(encodeContent(text));
    }

    function scheduleFlush() {
        if (flushTimer) return;
        flushTimer = setTimeout(() => {
            flushTimer = null;
            flushContentBuffer();
        }, FLUSH_INTERVAL_MS);
    }

    function addContent(text) {
        if (!text) return;
        accumulatedText += text;
        if (persist) noteReplyText(persist, accumulatedText);
        if (!firstContentSent) {
            firstContentSent = true;
            writer.write(encodeContent(text));
            return;
        }
        contentBuffer += text;
        if (Buffer.byteLength(contentBuffer, 'utf-8') >= FLUSH_BYTES) {
            flushContentBuffer();
        } else {
            scheduleFlush();
        }
    }

    function handleJson(json) {
        const index = typeof json?.choices?.[0]?.index === 'number' ? json.choices[0].index : 0;
        if (index !== lastIndex) {
            flushContentBuffer();
            writer.write(encodeIndexFrame(index));
            lastIndex = index;
        }

        const reasoningText = extractReasoning ? extractReasoning(json) : undefined;
        if (reasoningText) {
            noteReplyReasoning(persist, reasoningText);
            flushContentBuffer();
            writer.write(encodeReasoningFrame(reasoningText));
        }

        addContent(extractText(json));
    }

    const onSocketClose = () => {
        stopKeepalive();
        writer = detachFromResponse(generationRecord);
    };
    response.socket?.once('close', onSocketClose);
    onGenerationStopFlush(response, flushContentBuffer);

    await new Promise((resolve) => {
        fetchResponse.body.on('data', (chunk) => {
            sseBuffer += chunk.toString('utf-8');
            let idx;
            while ((idx = sseBuffer.indexOf('\n')) !== -1) {
                const rawLine = sseBuffer.slice(0, idx);
                sseBuffer = sseBuffer.slice(idx + 1);
                if (isGenerationStopped(response)) continue;

                const trimmed = rawLine.trim();
                if (!trimmed.startsWith('data:')) continue;
                const payload = trimmed.slice(5).trim();
                if (!payload || payload === '[DONE]') continue;

                try {
                    handleJson(JSON.parse(payload));
                } catch (error) {
                    console.warn('Failed to parse streamed SSE event while accumulating text for persistence:', error);
                }
            }
        });
        fetchResponse.body.once('end', resolve);
        fetchResponse.body.once('error', resolve);
        fetchResponse.body.once('close', resolve);
    });

    flushContentBuffer();

    if (persist && accumulatedText) {
        const persisted = await persistAssistantReply(persist, accumulatedText);
        const frame = encodeStoredReplyFrame(persisted, persist);
        if (frame) writer.write(frame);
    }

    response.socket?.off('close', onSocketClose);
    writer.end();
}

/**
 * @param {object} target
 * @param {object} delta
 * @returns {void}
 */
function applyServerToolCallDelta(target, delta) {
    for (const key in delta) {
        if (!Object.prototype.hasOwnProperty.call(delta, key)) continue;
        if (key === '__proto__' || key === 'constructor') continue;

        const deltaValue = delta[key];
        const targetValue = target[key];

        if (deltaValue === null || deltaValue === undefined) {
            if (targetValue) continue;
            target[key] = deltaValue;
            continue;
        }

        if (typeof deltaValue === 'string') {
            if (key === 'id' || key === 'name' || key === 'type') {
                if (!targetValue) {
                    target[key] = deltaValue;
                }
            } else if (typeof targetValue === 'string') {
                target[key] = targetValue + deltaValue;
            } else {
                target[key] = deltaValue;
            }
        } else if (typeof deltaValue === 'object' && !Array.isArray(deltaValue)) {
            if (typeof targetValue !== 'object' || targetValue === null || Array.isArray(targetValue)) {
                target[key] = {};
            }
            applyServerToolCallDelta(target[key], deltaValue);
        } else {
            target[key] = deltaValue;
        }
    }
}

/**
 * @param {import('node-fetch').Response} fetchResponse
 * @param {import('express').Response} response
 * @param {object} persist
 * @param {object} pendingServerToolLoop
 * @param {(messages: object[]) => Promise<import('node-fetch').Response>} refetch
 * @param {Array<{kind: string, key: string, message: string, entries?: string[]}>|null} [warnings]
 * @returns {Promise<void>}
 */
async function forwardAndPersistCompactStreamWithServerTools(fetchResponse, response, persist, pendingServerToolLoop, refetch, warnings = null) {
    if (!fetchResponse.ok || !fetchResponse.body) {
        return forwardFetchResponse(fetchResponse, response);
    }

    response.statusCode = fetchResponse.status;
    response.statusMessage = fetchResponse.statusText;
    response.setHeader('X-ST-Stream-Format', 'compact-v1');
    const generationId = generationIdFor(response);
    response.setHeader('X-Generation-Id', generationId);

    const { writer } = createResumableWriter(createChatCompactStreamWriter(response), createGenerationRecord(generationId));
    writeStoredMessagesFrame(writer, response);
    if (warnings?.length) {
        writer.write(encodeControlFrame({ warnings }));
    }

    let buffer = '';
    let text = '';
    /** @type {any[]} */
    const toolCallsByIndex = [];

    fetchResponse.body.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (isGenerationStopped(response)) continue;
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;

            let json;
            try {
                json = JSON.parse(payload);
            } catch (error) {
                console.warn('Failed to parse streamed SSE event while accumulating tool calls for persistence (compact stream):', error);
                continue;
            }

            const delta = json?.choices?.[0]?.delta;
            const contentDelta = delta?.content;
            if (typeof contentDelta === 'string' && contentDelta) {
                text += contentDelta;
                noteReplyText(persist, text);
                writer.write(encodeContent(contentDelta));
            }

            const toolCallDeltas = delta?.tool_calls;
            if (Array.isArray(toolCallDeltas)) {
                for (const toolCallDelta of toolCallDeltas) {
                    const toolCallIndex = typeof toolCallDelta?.index === 'number' ? toolCallDelta.index : toolCallDeltas.indexOf(toolCallDelta);
                    if (Number.isNaN(toolCallIndex) || toolCallIndex < 0) continue;
                    if (toolCallsByIndex[toolCallIndex] === undefined) {
                        toolCallsByIndex[toolCallIndex] = {};
                    }
                    applyServerToolCallDelta(toolCallsByIndex[toolCallIndex], toolCallDelta);
                    writer.write(encodeToolCallDeltaFrame(toolCallDelta));
                }
            }
        }
    });

    const ended = new Promise((resolve) => {
        fetchResponse.body.once('end', resolve);
        fetchResponse.body.once('error', resolve);
        fetchResponse.body.once('close', resolve);
    });
    await ended;

    const toolCalls = toolCallsByIndex.filter(Boolean);
    if (toolCalls.length === 0 || isGenerationStopped(response)) {
        if (text) {
            const persisted = await persistAssistantReply(persist, text);
            const frame = encodeStoredReplyFrame(persisted, persist);
            if (frame) writer.write(frame);
        }
        writer.end();
        return;
    }

    const initialJson = { choices: [{ message: { role: 'assistant', content: text || null, tool_calls: toolCalls } }] };
    const roundResult = await runServerToolRounds({
        ...pendingServerToolLoop,
        leafNodeId: persist.anchorNodeId,
        isSwipe: persist.isSwipe,
        initialJson,
        refetch,
    });

    if (roundResult.ok === 'aborted') {
        writer.write(encodeControlFrame({ tool_call_aborted: true }));
        writer.end();
        return;
    }

    if (roundResult.ok === 'pending') {
        writer.write(encodeControlFrame({ tool_call_handoff: { node_id: roundResult.leafNodeId, pending_tool_calls: roundResult.pendingToolCalls } }));
        writer.end();
        return;
    }

    if (!roundResult.ok) {
        writer.write(encodeControlFrame({ error: { message: roundResult.message } }));
        writer.end();
        return;
    }

    const finalText = roundResult.json?.choices?.[0]?.message?.content ?? '';
    if (finalText) {
        writer.write(encodeContent(finalText));
    }

    persist.anchorNodeId = roundResult.leafNodeId;
    persist.isSwipe = false;
    persist.isContinue = false;
    if (finalText) {
        noteReplyText(persist, finalText);
        const persisted = await persistAssistantReply(persist, finalText);
        const frame = encodeStoredReplyFrame(persisted, persist);
        if (frame) writer.write(frame);
    }
    writer.end();
}

/**
 * @param {unknown} rawArguments
 * @returns {object}
 */
function parseServerToolArguments(rawArguments) {
    if (rawArguments === '' || rawArguments === undefined || rawArguments === null) {
        return {};
    }
    if (typeof rawArguments !== 'string') {
        return typeof rawArguments === 'object' ? rawArguments : {};
    }
    try {
        const parsed = JSON.parse(rawArguments);
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
        return {};
    }
}

/**
 * @param {object} params
 * @param {import('../../users.js').UserDirectoryList} params.directories
 * @param {string} params.ownerId
 * @param {import('../../chat-request.js').ChatContext} params.chat
 * @param {string} [params.characterAvatar]
 * @param {string} [params.groupId]
 * @param {import('../../server-tools.js').ServerToolRegistration[]} params.enabledTools
 * @param {Set<string>} params.clientToolNames
 * @param {any[]} [params.clientToolSchemas]
 * @param {Set<string>} [params.stealthToolNames]
 * @param {string} params.leafNodeId
 * @param {boolean} [params.isSwipe]
 * @param {any} params.initialJson
 * @param {(messages: object[]) => Promise<import('node-fetch').Response>} params.refetch
 * @returns {Promise< {ok: true, json: any, leafNodeId: string} | {ok: false, status: number, message: string} | {ok: 'pending', pendingToolCalls: {node_id: string, tool_call_id: string, name: string, arguments: object}[], leafNodeId: string} | {ok: 'aborted', leafNodeId: string} >}
 */
/**
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {import('../../token-count-store.js').PendingTokenRows | null} rows
 */
function storeTokenCountRowsInBackground(directories, rows) {
    if (!rows) return;
    writeBack(directories, rows).catch(error => console.error('Failed to store token counts:', error));
}

async function runServerToolRounds({ directories, ownerId, chat, characterAvatar, groupId, enabledTools, clientToolNames, clientToolSchemas, stealthToolNames = new Set(), leafNodeId, isSwipe = false, initialJson, refetch }) {
    const toolsByName = new Map(enabledTools.map(tool => [tool.name, tool]));
    let json = initialJson;
    let currentLeafId = leafNodeId;

    for (let round = 0; round < SERVER_TOOL_ROUND_LIMIT; round++) {
        const toolCalls = json?.choices?.[0]?.message?.tool_calls;
        if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
            return { ok: true, json, leafNodeId: currentLeafId };
        }

        const unknownCall = toolCalls.find(toolCall => {
            const name = toolCall?.function?.name;
            return !toolsByName.has(name) && !clientToolNames.has(name);
        });
        if (unknownCall) {
            return {
                ok: false,
                status: 422,
                message: `The backend called a tool named "${unknownCall?.function?.name}" that is neither a registered server-native tool nor one of the tools this request's own "client_tools" advertised. Only tools registered via registerServerTool() or listed in "client_tools" can be advertised/executed for a raw-action request.`,
            };
        }

        const hasStealthCall = toolCalls.some(toolCall => stealthToolNames.has(toolCall?.function?.name));
        if (hasStealthCall) {
            return { ok: 'aborted', leafNodeId: currentLeafId };
        }

        const invocations = [];
        const pendingToolCalls = [];
        for (const toolCall of toolCalls) {
            const name = toolCall.function.name;
            const rawArguments = toolCall.function.arguments;
            const args = parseServerToolArguments(rawArguments);
            const parameters = typeof rawArguments === 'string' ? rawArguments : JSON.stringify(args);
            const tool = toolsByName.get(name);

            if (!tool) {
                invocations.push({ id: toolCall.id, name, parameters, result: null, error: null });
                pendingToolCalls.push({ tool_call_id: toolCall.id, name, arguments: args });
                continue;
            }

            let result;
            let isError = false;
            try {
                const invokeResult = await tool.invoke(args, { directories, ownerId, characterAvatar, groupId });
                result = typeof invokeResult === 'string' ? invokeResult : JSON.stringify(invokeResult);
            } catch (error) {
                isError = true;
                result = error instanceof Error ? error.message : String(error);
                console.error(`Server-native tool "${tool.name}" threw during a raw-action tool-call round:`, error);
            }

            invocations.push({ id: toolCall.id, name: tool.name, parameters, result, error: isError });
        }

        const toolNames = invocations.map(invocation => invocation.name).join(', ');
        const toolTurnContent = {
            name: 'System', is_system: true, is_user: false,
            mes: `Tool calls: ${toolNames}`,
            extra: { tool_invocations: invocations },
            send_date: Date.now(),
        };

        const claimsSiblingSlot = round === 0 && isSwipe;
        const { chats } = chat.store;
        let after = currentLeafId;
        if (claimsSiblingSlot) {
            const replaced = await chats.messageOf(chat.tree, currentLeafId);
            if (!replaced) {
                return { ok: false, status: 500, message: 'Failed to persist the tool invocation results onto the chat.' };
            }
            after = replaced.parent === null ? null : (await chats.externalIds([replaced.parent]))[0];
        }
        const appendResult = await chats.appendMessages({
            tree: chat.tree, treeSpeaker: chat.treeSpeaker, after, contents: [toolTurnContent], actor: chat.session.actor(),
        });
        if (!appendResult.ok || !appendResult.node_ids?.length) {
            console.error('Failed to persist tool invocation turn:', appendResult.reason);
            return { ok: false, status: 500, message: 'Failed to persist the tool invocation results onto the chat.' };
        }
        currentLeafId = appendResult.node_ids[appendResult.node_ids.length - 1];

        if (pendingToolCalls.length > 0) {
            return {
                ok: 'pending',
                pendingToolCalls: pendingToolCalls.map(call => ({ ...call, node_id: currentLeafId })),
                leafNodeId: currentLeafId,
            };
        }

        const rebuilt = await buildRawActionChatCompletionRequest(directories, {
            characterAvatar, groupId, ownerId, chat, nodeId: currentLeafId, type: 'normal', clientToolSchemas,
        });

        const fetchResponse = await refetch(rebuilt.params.messages);
        storeTokenCountRowsInBackground(directories, rebuilt.tokenCountRows);
        if (!fetchResponse.ok) {
            const responseText = await fetchResponse.text().catch(() => '');
            return {
                ok: false,
                status: 502,
                message: `Backend request failed while resolving a server tool call: ${fetchResponse.statusText || responseText || 'Unknown error'}`,
            };
        }
        json = await fetchResponse.json();
    }

    return {
        ok: false,
        status: 500,
        message: `Exceeded the maximum of ${SERVER_TOOL_ROUND_LIMIT} server tool-call rounds without receiving a final plain-text reply from the backend.`,
    };
}

/**
 * @param {import('../../chat-request.js').ChatContext} chat
 * @param {string} nodeId
 * @param {any[]} toolResults
 * @returns {Promise<{ok: true}|{ok: false, status: number, message: string}>}
 */
async function resolvePendingToolResults(chat, nodeId, toolResults) {
    const { chats } = chat.store;
    const stored = await chats.messageOf(chat.tree, nodeId);
    if (!stored) {
        return { ok: false, status: 400, message: `Chat node not found: ${nodeId}` };
    }
    const [nodeContent] = await chats.decoded([stored]);

    const invocations = nodeContent.extra?.tool_invocations;
    if (!Array.isArray(invocations) || invocations.length === 0) {
        return { ok: false, status: 400, message: `Chat node "${nodeId}" has no pending tool invocations to resolve.` };
    }

    const invocationsById = new Map(invocations.map(invocation => [invocation.id, invocation]));
    const unknownIds = [];
    for (const entry of (Array.isArray(toolResults) ? toolResults : [])) {
        const id = entry?.id;
        const invocation = typeof id === 'string' ? invocationsById.get(id) : undefined;
        if (!invocation || invocation.result !== null) {
            if (!invocation) unknownIds.push(id);
            continue;
        }
        invocation.result = typeof entry.result === 'string' ? entry.result : JSON.stringify(entry.result ?? '');
        invocation.error = Boolean(entry.error);
    }

    if (unknownIds.length > 0) {
        return { ok: false, status: 400, message: `tool_results referenced unknown tool_call id(s) on node "${nodeId}": ${unknownIds.join(', ')}` };
    }
    const stillPending = invocations.filter(invocation => invocation.result === null);
    if (stillPending.length > 0) {
        return { ok: false, status: 400, message: `Not all pending tool calls on node "${nodeId}" were resolved by this request: ${stillPending.map(invocation => invocation.id).join(', ')}` };
    }

    const editResult = await chats.editMessages({
        tree: chat.tree, treeSpeaker: chat.treeSpeaker, actor: chat.session.actor(),
        edits: [{ node_id: nodeId, content: storedForm({ ...nodeContent, extra: { ...nodeContent.extra, tool_invocations: invocations } }) }],
    });
    if (editResult.refused.length) {
        console.error('Failed to persist tool_result:', editResult.refused[0].reason);
        return { ok: false, status: 500, message: 'Failed to persist the submitted tool result onto the chat.' };
    }
    return { ok: true };
}

router.post('/generate', withGenerationStop(async function (request, response) {
    let pendingAssistantPersist = null;

    let pendingServerToolLoop = null;

    /** @type {Array<{kind: string, key: string, message: string, entries?: string[]}>} */
    const warnings = [];

    /** @type {import('../../token-count-store.js').PendingTokenRows | null} */
    let tokenCountRows = null;
    const storeTokenCountRows = () => storeTokenCountRowsInBackground(request.user.directories, tokenCountRows);

    try {
        if (!request.body) return response.status(400).send({ error: true });

        if (request.body.connection_profile_id) {
            const { profile, selectedApiMap } = resolveConnectionProfile(request.user.directories, request.body.connection_profile_id);
            if (selectedApiMap.selected !== 'openai') {
                return response.status(400).send({ error: true, message: `Profile does not target a chat completion backend (targets: ${selectedApiMap.selected})` });
            }

            const { messages, max_tokens: maxTokens, type = 'quiet', name1 = '', name2 = '', stream: requestedStream } = request.body;
            if (!Array.isArray(messages)) {
                return response.status(400).send({ error: true, message: 'messages must be an array' });
            }

            const { 'oai_settings': baseSettings, proxies } = readSettingsFor(request.user.directories, settingsContextOf({}), ['oai_settings', 'proxies']);
            const preset = profile.preset ? await readBundle(request.user.directories, 'preset.openai', profile.preset) : null;
            const settings = mergeChatCompletionPreset({ ...baseSettings, chat_completion_source: selectedApiMap.source }, preset);

            if (profile['api-url']) {
                for (const field of ['custom_url', 'vertexai_region', 'zai_endpoint', 'siliconflow_endpoint', 'minimax_endpoint', 'pollinations_endpoint']) {
                    settings[field] = profile['api-url'];
                }
            }
            const proxyPreset = Array.isArray(proxies) ? proxies.find(p => p.name === profile.proxy) : undefined;
            if (proxyPreset) {
                settings.reverse_proxy = proxyPreset.url;
                settings.proxy_password = proxyPreset.password;
            }

            const biasPresetEntries = settings.bias_preset_selected ? settings.bias_presets?.[settings.bias_preset_selected] : undefined;
            /** @type {string[]} */
            const droppedBiasEntries = [];
            const { generate_data } = await createGenerationParameters(settings, profile.model, type, messages, { directories: request.user.directories, macroContext: { name1, name2 }, biasPresetEntries, droppedBiasEntries });
            warnings.push(...await chatCompletionSendWarnings(settings.chat_completion_source, profile.model, droppedBiasEntries, undefined,
                chatCompletionConnection(settings, request.user.directories, { name1, name2 })));

            if (request.body.overrides && typeof request.body.overrides === 'object' && !Array.isArray(request.body.overrides)) {
                Object.assign(generate_data, _.omit(request.body.overrides, ['chat_completion_source', 'model', 'messages', 'custom_url', 'reverse_proxy', 'proxy_password', 'secret_id']));
            }

            request.body = {
                ...generate_data,
                max_tokens: maxTokens ?? generate_data.max_tokens,
                stream: !!requestedStream,
                chat_completion_source: selectedApiMap.source,
                secret_id: profile['secret-id'],
                custom_prompt_post_processing: profile['prompt-post-processing'],
            };
        } else if (request.body.owner_id && (request.body.character_avatar || request.body.group_id)) {
            const {
                character_avatar: characterAvatar, group_id: groupId, owner_id: ownerId,
                type = 'normal',
                client_tools: clientToolSchemas,
                stealth_tool_names: stealthClientToolNames,
                tool_results: toolResults,
                json_schema: jsonSchema,
            } = request.body;
            const directories = request.user.directories;
            const chat = await chatContext(request, { avatar: characterAvatar, group: groupId });
            if (!chat) {
                return response.status(400).send({ error: true, message: groupId ? `Group not found: ${groupId}` : `Character not found: ${characterAvatar}` });
            }
            answerSessionOnHeaders(response, chat.session);
            const turn = await generateTurnOf(response, chat, request.body);
            if (!turn) return;
            const { nodeId, userMessageText, userMessageExtra, quiet, responseLength, pageFacts, pageInjections } = turn;

            const isToolResult = type === 'tool_result';
            if (isToolResult) {
                if (typeof nodeId !== 'string' || !nodeId) {
                    return response.status(400).send({ error: true, message: 'node_id is required for type: "tool_result" (the pending tool-call node being resolved).' });
                }
                if (!Array.isArray(toolResults) || toolResults.length === 0) {
                    return response.status(400).send({ error: true, message: 'tool_results must be a non-empty array for type: "tool_result".' });
                }
                const resolved = await resolvePendingToolResults(chat, nodeId, toolResults);
                if (!resolved.ok) {
                    return response.status(resolved.status).send({ error: true, message: resolved.message });
                }
            }

            const isImpersonate = type === 'impersonate';
            const isContinue = type === 'continue';
            const isSwipe = type === 'swipe' || type === 'regenerate';

            /** @type {Awaited<ReturnType<typeof buildRawActionChatCompletionRequest>>} */
            let built;
            try {
                built = await buildRawActionChatCompletionRequest(directories, {
                    characterAvatar, groupId, ownerId, chat, nodeId,
                    type: isToolResult ? 'normal' : type, isImpersonate, isContinue, isSwipe,
                    userMessageText: isToolResult ? undefined : userMessageText,
                    userMessageExtra: isToolResult ? undefined : userMessageExtra,
                    pageFacts,
                    pageInjections,
                    clientToolSchemas,
                    stealthClientToolNames,
                    jsonSchema,
                    quiet: isToolResult ? undefined : quiet,
                    responseLength: isToolResult ? undefined : responseLength,
                });
            } catch (error) {
                console.error('Failed to build raw-action chat completion request:', error);
                return response.status(400).send({ error: true, message: error?.message ?? 'Could not resolve this generation request' });
            }
            warnings.push(...built.warnings);
            tokenCountRows = built.tokenCountRows;

            const skipPersistence = isImpersonate || type === 'quiet';
            let replyAnchorNodeId = built.anchorNodeId;
            const userMessage = turn.userMessage;
            if (!isToolResult && !skipPersistence && typeof userMessageText === 'string') {
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
                chat.session.actor();
                pendingAssistantPersist = {
                    chat, anchorNodeId: replyAnchorNodeId, name2: built.name2,
                    isSwipe, isContinue, anchorContent: continuesUserMessage ? userMessage : built.anchorContent,
                    warnings,
                    generationStop: response.locals.generationStop,
                    itemization: itemizationOf(request.body.itemization, null),
                    finish: await readReplyFinishSettings(directories, {
                        mainApi: 'openai', source: built.settings.chat_completion_source, model: built.params?.model ?? null,
                        avatar: characterAvatar, groupId, name1: built.name1, name2: built.name2,
                    }),
                };
                if (built.enabledServerTools.length > 0 || built.enabledClientToolNames.size > 0) {
                    pendingServerToolLoop = {
                        directories, ownerId, chat, characterAvatar, groupId,
                        enabledTools: built.enabledServerTools,
                        clientToolNames: built.enabledClientToolNames,
                        stealthToolNames: built.enabledStealthClientToolNames,
                        clientToolSchemas,
                    };
                }
            }

            const stream = !!request.body.stream;
            request.body = { ...built.params, stream, chat_completion_source: built.settings.chat_completion_source };
        }

        const postProcessingType = request.body.custom_prompt_post_processing;
        if (Array.isArray(request.body.messages) && postProcessingType) {
            request.body.messages = postProcessPrompt(
                request.body.messages,
                postProcessingType,
                getPromptNames(request));
        }

        if (request.body.json_schema?.value) {
            request.body.json_schema.value = flattenSchema(request.body.json_schema.value, request.body.chat_completion_source);
        }

        switch (request.body.chat_completion_source) {
            case CHAT_COMPLETION_SOURCES.CLAUDE: return await sendClaudeRequest(request, response, pendingAssistantPersist, warnings, storeTokenCountRows);
            case CHAT_COMPLETION_SOURCES.AI21: return await sendAI21Request(request, response, pendingAssistantPersist, warnings, storeTokenCountRows);
            case CHAT_COMPLETION_SOURCES.MAKERSUITE: return await sendMakerSuiteRequest(request, response, pendingAssistantPersist, warnings, storeTokenCountRows);
            case CHAT_COMPLETION_SOURCES.VERTEXAI: return await sendMakerSuiteRequest(request, response, pendingAssistantPersist, warnings, storeTokenCountRows);
            case CHAT_COMPLETION_SOURCES.MISTRALAI: return await sendMistralAIRequest(request, response, pendingAssistantPersist, warnings, storeTokenCountRows);
            case CHAT_COMPLETION_SOURCES.COHERE: return await sendCohereRequest(request, response, pendingAssistantPersist, warnings, storeTokenCountRows);
            case CHAT_COMPLETION_SOURCES.DEEPSEEK: return await sendDeepSeekRequest(request, response, pendingAssistantPersist, warnings, storeTokenCountRows);
            case CHAT_COMPLETION_SOURCES.AIMLAPI: return await sendAimlapiRequest(request, response, pendingAssistantPersist, warnings, storeTokenCountRows);
            case CHAT_COMPLETION_SOURCES.XAI: return await sendXaiRequest(request, response, pendingAssistantPersist, warnings, storeTokenCountRows);
            case CHAT_COMPLETION_SOURCES.CHUTES: return await sendChutesRequest(request, response, pendingAssistantPersist, warnings, storeTokenCountRows);
            case CHAT_COMPLETION_SOURCES.MINIMAX: return await sendMinimaxRequest(request, response, pendingAssistantPersist, warnings, storeTokenCountRows);
            case CHAT_COMPLETION_SOURCES.ELECTRONHUB: return await sendElectronHubRequest(request, response, pendingAssistantPersist, warnings, storeTokenCountRows);
            case CHAT_COMPLETION_SOURCES.AZURE_OPENAI: return await sendAzureOpenAIRequest(request, response, pendingAssistantPersist, warnings, storeTokenCountRows);
        }

        let apiUrl;
        let apiKey;
        let headers;
        let bodyParams;
        const isTextCompletion = Boolean(request.body.model && TEXT_COMPLETION_MODELS.includes(request.body.model)) || typeof request.body.messages === 'string';

        if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.OPENAI) {
            apiUrl = new URL(request.body.reverse_proxy || API_OPENAI).toString();
            apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.OPENAI, request.body.secret_id);
            headers = {};
            bodyParams = {
                logprobs: request.body.logprobs,
                top_logprobs: undefined,
            };

            // Adjust logprobs params for Chat Completions API, which expects { top_logprobs: number; logprobs: boolean; }
            if (!isTextCompletion && bodyParams.logprobs > 0) {
                bodyParams.top_logprobs = bodyParams.logprobs;
                bodyParams.logprobs = true;
            }

            if (getConfigValue('openai.randomizeUserId', false, 'boolean')) {
                bodyParams['user'] = uuidv4();
            }

            embedOpenRouterMedia(request.body.messages, { audio: true, video: false });
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.OPENROUTER) {
            apiUrl = 'https://openrouter.ai/api/v1';
            apiKey = readSecret(request.user.directories, SECRET_KEYS.OPENROUTER, request.body.secret_id);
            // OpenRouter needs to pass the Referer and X-Title: https://openrouter.ai/docs#requests
            headers = { ...OPENROUTER_HEADERS };
            const includeReasoning = Boolean(request.body.include_reasoning);
            bodyParams = {
                transforms: getOpenRouterTransforms(request),
                plugins: getOpenRouterPlugins(request),
                reasoning: {
                    exclude: !includeReasoning,
                },
            };

            if (request.body.logprobs > 0) {
                bodyParams['top_logprobs'] = request.body.logprobs;
                bodyParams['logprobs'] = true;
            }

            if (request.body.min_p !== undefined) {
                bodyParams['min_p'] = request.body.min_p;
            }

            if (request.body.top_a !== undefined) {
                bodyParams['top_a'] = request.body.top_a;
            }

            if (request.body.repetition_penalty !== undefined) {
                bodyParams['repetition_penalty'] = request.body.repetition_penalty;
            }

            if (Array.isArray(request.body.provider) && request.body.provider.length > 0) {
                bodyParams['provider'] = {
                    allow_fallbacks: request.body.allow_fallbacks ?? true,
                    order: request.body.provider ?? [],
                };
            }

            if (Array.isArray(request.body.quantizations) && request.body.quantizations.length > 0) {
                bodyParams['provider'] ??= {};
                bodyParams['provider']['quantizations'] = request.body.quantizations;
            }

            if (request.body.use_fallback) {
                bodyParams['route'] = 'fallback';
            }

            if (request.body.reasoning_effort) {
                bodyParams['reasoning']['effort'] = request.body.reasoning_effort;
            }

            if (request.body.verbosity) {
                bodyParams['verbosity'] = request.body.verbosity;
            }

            if (request.body.json_schema) {
                bodyParams['response_format'] = {
                    type: 'json_schema',
                    json_schema: {
                        name: request.body.json_schema.name,
                        strict: request.body.json_schema.strict ?? true,
                        schema: request.body.json_schema.value,
                    },
                };
            }

            const isClaude = /^anthropic\/claude/.test(request.body.model);
            const isGemini = /google\/gemini/.test(request.body.model);
            const isCacheableGemini = isGemini && await isOpenRouterModelCacheable(request.body.model);
            const enableGeminiSystemPromptCache = getConfigValue('gemini.enableSystemPromptCache', false, 'boolean');

            if (Array.isArray(request.body.messages)) {
                embedOpenRouterMedia(request.body.messages, { audio: true, video: true });
                addOpenRouterSignatures(request.body.messages, request.body.model);

                if (isClaude) {
                    if (enableSystemPromptCache) {
                        cachingSystemPromptForOpenRouter(request.body.messages, cacheTTL);
                    }

                    if (cachingAtDepth !== -1) {
                        cachingAtDepthForOpenRouterClaude(request.body.messages, cachingAtDepth, cacheTTL);
                    }
                }

                if (isCacheableGemini && enableGeminiSystemPromptCache) {
                    cachingSystemPromptForOpenRouter(request.body.messages);
                }
            }

            if (isGemini) {
                bodyParams['safety_settings'] = GEMINI_SAFETY;
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.CUSTOM) {
            apiUrl = request.body.custom_url;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.CUSTOM, request.body.secret_id);
            headers = {};
            bodyParams = {
                logprobs: request.body.logprobs,
                top_logprobs: undefined,
            };

            // Adjust logprobs params for Chat Completions API, which expects { top_logprobs: number; logprobs: boolean; }
            if (!isTextCompletion && bodyParams.logprobs > 0) {
                bodyParams.top_logprobs = bodyParams.logprobs;
                bodyParams.logprobs = true;
            }

            mergeObjectWithYaml(bodyParams, request.body.custom_include_body);
            mergeObjectWithYaml(headers, request.body.custom_include_headers);
            embedOpenRouterMedia(request.body.messages, { audio: true, video: false });
            if (request.body.json_schema) {
                bodyParams['response_format'] = {
                    type: 'json_schema',
                    json_schema: {
                        name: request.body.json_schema.name,
                        strict: request.body.json_schema.strict ?? true,
                        schema: request.body.json_schema.value,
                    },
                };
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.PERPLEXITY) {
            apiUrl = API_PERPLEXITY;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.PERPLEXITY, request.body.secret_id);
            headers = {};
            bodyParams = {
                reasoning_effort: request.body.reasoning_effort,
            };
            request.body.messages = postProcessPrompt(request.body.messages, PROMPT_PROCESSING_TYPE.STRICT, getPromptNames(request));
            if (request.body.json_schema) {
                bodyParams['response_format'] = {
                    type: 'json_schema',
                    json_schema: {
                        schema: request.body.json_schema.value,
                    },
                };
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.GROQ) {
            apiUrl = API_GROQ;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.GROQ, request.body.secret_id);
            headers = {};
            bodyParams = {};
            if (request.body.json_schema) {
                bodyParams['response_format'] = {
                    type: 'json_schema',
                    json_schema: {
                        name: request.body.json_schema.name,
                        description: request.body.json_schema.description,
                        schema: request.body.json_schema.value,
                        strict: request.body.json_schema.strict ?? true,
                    },
                };
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.FIREWORKS) {
            apiUrl = API_FIREWORKS;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.FIREWORKS, request.body.secret_id);
            headers = {};
            bodyParams = {};
            if (request.body.reasoning_effort) {
                bodyParams['reasoning_effort'] = request.body.reasoning_effort;
            }
            if (request.body.json_schema) {
                bodyParams['response_format'] = {
                    type: 'json_schema',
                    json_schema: {
                        name: request.body.json_schema.name,
                        description: request.body.json_schema.description,
                        schema: request.body.json_schema.value,
                        strict: request.body.json_schema.strict ?? true,
                    },
                };
            }
            if (request.body.chat_id) {
                headers['x-session-affinity'] = createHmac('sha256', getAffinityKey()).update(request.body.chat_id).digest('hex').slice(0, 16);
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.NANOGPT) {
            apiUrl = API_NANOGPT;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.NANOGPT, request.body.secret_id);
            headers = {};
            bodyParams = {};
            if (request.body.nanogpt_provider) {
                headers['X-Provider'] = request.body.nanogpt_provider;
            }
            if (request.body.nanogpt_payg_override) {
                headers['X-Billing-Mode'] = 'paygo';
                bodyParams['billing_mode'] = 'paygo';
            }
            if (request.body.enable_web_search && !/:online$/.test(request.body.model)) {
                request.body.model = `${request.body.model}:online`;
            }
            if (request.body.min_p !== undefined) {
                bodyParams['min_p'] = request.body.min_p;
            }
            if (request.body.top_a !== undefined) {
                bodyParams['top_a'] = request.body.top_a;
            }
            if (request.body.repetition_penalty !== undefined) {
                bodyParams['repetition_penalty'] = request.body.repetition_penalty;
            }
            if (request.body.reasoning_effort) {
                const effort = NANOGPT_REASONING_EFFORT_MAP[request.body.reasoning_effort];
                bodyParams['reasoning'] = { effort: effort };
            }

            const isClaude = /(?:^|\/)claude[-_]/.test(request.body.model);
            if (enableSystemPromptCache && isClaude) {
                bodyParams['cache_control'] = {
                    'enabled': true,
                    'ttl': cacheTTL,
                };
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.POLLINATIONS) {
            const isAnonymous = request.body.pollinations_endpoint === POLLINATIONS_ENDPOINT.ANONYMOUS;
            apiUrl = isAnonymous ? API_POLLINATIONS_ANON : API_POLLINATIONS;
            apiKey = isAnonymous ? 'anonymous' : readSecret(request.user.directories, SECRET_KEYS.POLLINATIONS, request.body.secret_id);
            headers = {};
            bodyParams = {
                seed: request.body.seed ?? Math.floor(Math.random() * 99999999),
            };
            if (!isAnonymous) {
                bodyParams['reasoning_effort'] = request.body.reasoning_effort;
                if (request.body.json_schema) {
                    bodyParams['response_format'] = {
                        type: 'json_schema',
                        json_schema: {
                            schema: request.body.json_schema.value,
                        },
                    };
                }
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.MOONSHOT) {
            apiUrl = new URL(request.body.reverse_proxy || API_MOONSHOT).toString();
            apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.MOONSHOT, request.body.secret_id);
            headers = {};
            bodyParams = {
                thinking: {
                    type: request.body.include_reasoning ? 'enabled' : 'disabled',
                },
            };
            request.body.json_schema
                ? setJsonObjectFormat(bodyParams, request.body.messages, request.body.json_schema)
                : addAssistantPrefix(request.body.messages, [], 'partial');
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.COMETAPI) {
            apiUrl = API_COMETAPI;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.COMETAPI, request.body.secret_id);
            headers = {};
            bodyParams = {
                reasoning_effort: request.body.reasoning_effort,
            };
            throw new Error('This provider is temporarily disabled.');
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.ZAI) {
            const defaultApiUrl = request.body.zai_endpoint === ZAI_ENDPOINT.CODING ? API_ZAI_CODING : API_ZAI_COMMON;
            apiUrl = new URL(request.body.reverse_proxy || defaultApiUrl).toString();
            apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.ZAI, request.body.secret_id);
            headers = {
                'Accept-Language': 'en-US,en',
            };
            bodyParams = {
                thinking: {
                    type: request.body.include_reasoning ? 'enabled' : 'disabled',
                },
            };
            if (request.body.json_schema) {
                setJsonObjectFormat(bodyParams, request.body.messages, request.body.json_schema);
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.SILICONFLOW) {
            const defaultApiUrl = request.body.siliconflow_endpoint === SILICONFLOW_ENDPOINT.CN
                ? API_SILICONFLOW_CN : API_SILICONFLOW;
            apiUrl = defaultApiUrl;
            apiKey = readSecret(request.user.directories, SECRET_KEYS.SILICONFLOW, request.body.secret_id);
            headers = {};
            bodyParams = {};
            if (request.body.json_schema) {
                setJsonObjectFormat(bodyParams, request.body.messages, request.body.json_schema);
            }
        } else if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.WORKERS_AI) {
            apiKey = readSecret(request.user.directories, SECRET_KEYS.WORKERS_AI, request.body.secret_id);
            const accountId = String(request.body.workers_ai_account_id || '').trim();
            if (!accountId) {
                console.warn('Cloudflare Workers AI Account ID is missing.');
                return response.status(400).send({ error: true });
            }
            apiUrl = `${API_WORKERS_AI}/${encodeURIComponent(accountId)}/ai/v1`;
            headers = {};
            bodyParams = {
                repetition_penalty: request.body.repetition_penalty,
            };
            if (request.body.json_schema) {
                bodyParams['response_format'] = {
                    type: 'json_schema',
                    json_schema: request.body.json_schema.value,
                };
            }
        } else {
            console.warn('This chat completion source is not supported yet.');
            return response.status(400).send({ error: true });
        }

        // A few of OpenAIs reasoning models support reasoning effort
        if (request.body.reasoning_effort && [CHAT_COMPLETION_SOURCES.CUSTOM, CHAT_COMPLETION_SOURCES.OPENAI].includes(request.body.chat_completion_source)) {
            if (OPENAI_REASONING_EFFORT_MODELS.includes(request.body.model)) {
                bodyParams['reasoning_effort'] = OPENAI_FIXED_REASONING_EFFORT[request.body.model] ?? OPENAI_REASONING_EFFORT_MAP[request.body.reasoning_effort] ?? request.body.reasoning_effort;
            }
            if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.CUSTOM && /^koboldcpp\/(.+)$/.test(request.body.model)) {
                bodyParams['reasoning_effort'] = request.body.reasoning_effort;
            }
        }

        if (request.body.verbosity && [CHAT_COMPLETION_SOURCES.CUSTOM, CHAT_COMPLETION_SOURCES.OPENAI].includes(request.body.chat_completion_source)) {
            if (OPENAI_VERBOSITY_MODELS.test(request.body.model)) {
                bodyParams['verbosity'] = request.body.verbosity;
            }
        }

        if (!apiKey && !request.body.reverse_proxy && request.body.chat_completion_source !== CHAT_COMPLETION_SOURCES.CUSTOM) {
            console.warn('OpenAI API key is missing.');
            return response.status(400).send({ error: true });
        }

        // Add custom stop sequences
        if (Array.isArray(request.body.stop) && request.body.stop.length > 0) {
            bodyParams['stop'] = request.body.stop;
        }

        const textPrompt = isTextCompletion ? convertTextCompletionPrompt(request.body.messages) : '';
        const usesCompletionsEndpoint = isTextCompletion && request.body.chat_completion_source !== CHAT_COMPLETION_SOURCES.OPENROUTER;
        const endpointUrl = usesCompletionsEndpoint ?
            `${apiUrl}/completions` :
            `${apiUrl}/chat/completions`;

        const controller = stoppableController(response);
        request.socket.removeAllListeners('close');
        request.socket.on('close', function () {
            if (pendingAssistantPersist) return;
            controller.abort();
        });

        if (!isTextCompletion && Array.isArray(request.body.tools) && request.body.tools.length > 0) {
            bodyParams['tools'] = request.body.tools;
            bodyParams['tool_choice'] = request.body.tool_choice;
        }

        if (request.body.json_schema && !bodyParams['response_format']) {
            bodyParams['response_format'] = {
                type: 'json_schema',
                json_schema: {
                    name: request.body.json_schema.name,
                    strict: request.body.json_schema.strict ?? true,
                    schema: request.body.json_schema.value,
                },
            };
        }

        const requestBody = {
            'messages': isTextCompletion === false ? request.body.messages : undefined,
            'prompt': isTextCompletion === true ? textPrompt : undefined,
            'model': request.body.model,
            'temperature': request.body.temperature,
            'max_tokens': request.body.max_tokens,
            'max_completion_tokens': request.body.max_completion_tokens,
            'stream': request.body.stream,
            'presence_penalty': request.body.presence_penalty,
            'frequency_penalty': request.body.frequency_penalty,
            'top_p': request.body.top_p,
            'top_k': request.body.top_k,
            'stop': isTextCompletion === false ? request.body.stop : undefined,
            'logit_bias': request.body.logit_bias,
            'seed': request.body.seed,
            'n': request.body.n,
            ...bodyParams,
        };

        if (request.body.chat_completion_source === CHAT_COMPLETION_SOURCES.CUSTOM) {
            excludeKeysByYaml(requestBody, request.body.custom_exclude_body);
        }

        /** @type {import('node-fetch').RequestInit} */
        const config = {
            method: 'post',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
                ...headers,
            },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
        };


        const fetchResponse = await fetch(endpointUrl, config);
        storeTokenCountRows();

        if (request.body.stream) {
            if (pendingServerToolLoop) {
                return await forwardAndPersistCompactStreamWithServerTools(
                    fetchResponse, response, pendingAssistantPersist, pendingServerToolLoop,
                    (messages) => fetch(endpointUrl, { ...config, body: JSON.stringify({ ...requestBody, stream: false, messages }) }),
                    warnings,
                );
            }

            const streamedText = usesCompletionsEndpoint
                ? json => json?.choices?.[0]?.text
                : json => json?.choices?.[0]?.delta?.content;
            return await forwardAndPersistCompactStream(fetchResponse, response, pendingAssistantPersist, streamedText, extractGenericReasoning, warnings);
        }

        if (fetchResponse.ok) {
            /** @type {any} */
            let json = await fetchResponse.json();

            if (pendingServerToolLoop && Array.isArray(json?.choices?.[0]?.message?.tool_calls) && json.choices[0].message.tool_calls.length > 0) {
                const roundResult = await runServerToolRounds({
                    ...pendingServerToolLoop,
                    leafNodeId: pendingAssistantPersist.anchorNodeId,
                    isSwipe: pendingAssistantPersist.isSwipe,
                    initialJson: json,
                    refetch: (messages) => fetch(endpointUrl, { ...config, body: JSON.stringify({ ...requestBody, messages }) }),
                });
                if (roundResult.ok === 'aborted') {
                    return response.send(withStoredMessages({ aborted: true }, response));
                }
                if (roundResult.ok === 'pending') {
                    return response.send(withStoredMessages({ pending_tool_calls: roundResult.pendingToolCalls }, response));
                }
                if (!roundResult.ok) {
                    return response.status(roundResult.status).send({ error: true, message: roundResult.message });
                }
                json = roundResult.json;
                pendingAssistantPersist.anchorNodeId = roundResult.leafNodeId;
                pendingAssistantPersist.isSwipe = false;
                pendingAssistantPersist.isContinue = false;
            }

            if (pendingAssistantPersist) {
                const generatedText = replyTextAsPageShows(json, 'openai');
                if (generatedText === null) {
                    warnings.push(unreadableReplyWarning(json, `openai|${request.body.chat_completion_source}`));
                }
                const persisted = await persistAssistantReply(pendingAssistantPersist, generatedText ?? '', { data: json });
                attachStoredReply(json, persisted);
            }
            if (warnings?.length) json.warnings = warnings;

            return response.send(withStoredMessages(json, response));
        } else {
            const responseText = await fetchResponse.text();
            const errorData = tryParse(responseText);

            const message = fetchResponse.statusText || 'Unknown error occurred';
            const quota_error = fetchResponse.status === 429 && errorData?.error?.type === 'insufficient_quota';
            console.error('Chat completion request error: ', message, responseText);

            if (!response.headersSent) {
                response.send({ error: { message }, quota_error: quota_error });
            } else if (!response.writableEnded) {
                response.write(responseText);
            } else {
                response.end();
            }
        }
    } catch (error) {
        console.error('Generation failed', error);
        const message = error.code === 'ECONNREFUSED'
            ? `Connection refused: ${error.message}`
            : error.message || 'Unknown error occurred';

        if (!response.headersSent) {
            response.status(502).send({ error: { message, ...error } });
        } else {
            response.end();
        }
    }
}));

const multimodalModels = express.Router();

multimodalModels.post('/pollinations', async (_req, res) => {
    try {
        const response = await fetch('https://gen.pollinations.ai/models');

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();

        if (!Array.isArray(data)) {
            return res.json([]);
        }

        const multimodalModels = data
            .filter(m => Array.isArray(m?.input_modalities))
            .filter(m => m.input_modalities.includes('image'))
            .map(m => m.name);
        return res.json(multimodalModels);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/aimlapi', async (_req, res) => {
    try {
        const response = await fetch('https://api.aimlapi.com/v1/models');

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();

        if (!Array.isArray(data?.data)) {
            return res.json([]);
        }

        const multimodalModels = data.data.filter(m => m?.features?.includes('openai/chat-completion.vision')).map(m => m.id);
        return res.json(multimodalModels);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/nanogpt', async (_req, res) => {
    try {
        const response = await fetch('https://nano-gpt.com/api/v1/models?detailed=true');

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();

        if (!Array.isArray(data?.data)) {
            return res.json([]);
        }

        const multimodalModels = data.data.filter(m => m?.capabilities?.vision).map(m => m.id);
        return res.json(multimodalModels);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/electronhub', async (_req, res) => {
    try {
        const response = await fetch('https://api.electronhub.ai/v1/models');

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();
        const multimodalModels = data.data.filter(m => m.metadata?.vision).map(m => m.id);
        return res.json(multimodalModels);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/chutes', async (req, res) => {
    try {
        const key = readSecret(req.user.directories, SECRET_KEYS.CHUTES);

        if (!key) {
            return res.json([]);
        }

        const response = await fetch('https://llm.chutes.ai/v1/models', {
            headers: {
                'Authorization': `Bearer ${key}`,
            },
        });

        if (!response.ok) {
            return res.json([]);
        }

        const data = await response.json();

        const modelsData = /** @type {{object: string, data: Array<{id: string, input_modalities?: string[]}>}} */ (data);
        const multimodalModels = modelsData.data
            .filter(m => m.input_modalities?.includes('image'))
            .map(m => m.id);
        return res.json(multimodalModels);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/mistral', async (req, res) => {
    try {
        const key = readSecret(req.user.directories, SECRET_KEYS.MISTRALAI);

        if (!key) {
            return res.json([]);
        }

        const response = await fetch('https://api.mistral.ai/v1/models', {
            headers: {
                'Authorization': `Bearer ${key}`,
            },
        });

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();
        const multimodalModels = data.data.filter(m => m.capabilities?.vision).map(m => m.id);
        return res.json(multimodalModels);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/xai', async (req, res) => {
    try {
        const key = readSecret(req.user.directories, SECRET_KEYS.XAI);

        if (!key) {
            return res.json([]);
        }

        // xAI's /models endpoint doesn't return modality info, so we must use /language-models instead
        const response = await fetch('https://api.x.ai/v1/language-models', {
            headers: {
                'Authorization': `Bearer ${key}`,
            },
        });

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();
        const multimodalModels = data.models.filter(m => m.input_modalities?.includes('image')).map(m => m.id);
        if (!multimodalModels.includes('grok-4-0709')) {
            // The endpoint says it doesn't support images, but it does
            multimodalModels.push('grok-4-0709');
        }
        return res.json(multimodalModels);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/moonshot', async (req, res) => {
    try {
        const key = readSecret(req.user.directories, SECRET_KEYS.MOONSHOT);

        if (!key) {
            return res.json([]);
        }

        const response = await fetch('https://api.moonshot.ai/v1/models', {
            headers: {
                'Authorization': `Bearer ${key}`,
            },
        });

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();

        const multimodalModels = data.data.filter(m => m.supports_image_in).map(m => m.id);
        return res.json(multimodalModels);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

multimodalModels.post('/workers_ai', async (req, res) => {
    try {
        const key = readSecret(req.user.directories, SECRET_KEYS.WORKERS_AI);
        const accountId = String(req.body.workers_ai_account_id || '').trim();

        if (!key || !accountId) {
            return res.json([]);
        }

        const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/models/search?task=Text+Generation&per_page=1000`;
        const response = await fetch(apiUrl, {
            method: 'GET',
            headers: { 'Authorization': 'Bearer ' + key },
        });

        if (!response.ok) {
            return res.json([]);
        }

        /** @type {any} */
        const data = await response.json();
        const models = Array.isArray(data?.result)
            ? data.result
                .filter(m => Array.isArray(m.properties) && m.properties.some(p => p.property_id === 'vision' && p.value === 'true'))
                .map(m => m.name)
            : [];
        return res.json(models);
    } catch (error) {
        console.error(error);
        return res.sendStatus(500);
    }
});

router.use('/multimodal-models', multimodalModels);

router.get('/generate/resume/:id', handleGenerationResume);
router.post('/generate/stop/:id', handleGenerationStop);

router.post('/process', async function (request, response) {
    try {
        if (!Array.isArray(request.body.messages)) {
            return response.status(400).send({ error: 'Invalid messages format' });
        }

        if (!Object.values(PROMPT_PROCESSING_TYPE).includes(request.body.type)) {
            return response.status(400).send({ error: 'Unknown processing type' });
        }

        const messages = postProcessPrompt(request.body.messages, request.body.type, getPromptNames(request));
        return response.send({ messages });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
