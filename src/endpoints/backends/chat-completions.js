/* eslint-disable dot-notation */
import { createHmac, randomUUID } from 'node:crypto';
import process from 'node:process';
import util from 'node:util';
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
import { readSettingsAtPaths } from '../../settings-store.js';
import { readPresetByName } from '../presets.js';
import { resolveChatCompletionGenerationInput } from '../../chat-completion-generation-input.js';
import { prepareOpenAIMessages } from '../../chat-completion-prepare-messages.js';
import { getAncestorPath, appendMessages, editMessage, sanitizeUserMessageExtra, addAlternatives, selectDefaultChild } from '../../message-tree-db.js';
import { readCardContent } from '../characters.js';
import { getGroupsByIds } from '../groups.js';
import { persistAssistantReply } from '../../assistant-reply-persist.js';
import { getEnabledServerTools, toOpenAIToolSchema } from '../../server-tools.js';
import {
    TEXT_COMPLETION_MODELS,
    computeLogitBias,
} from '../tokenizers.js';
import { getVertexAIAuth, getProjectIdFromServiceAccount } from '../google.js';
import { getCookieSecret } from '../../users.js';
import { fetchGoogleModels, GoogleModelsHttpError } from './google-models.js';
import { encodeContent, encodeIndexFrame, encodeReasoningFrame, encodeAssistantNodeIdFrame, encodeToolCallDeltaFrame, encodeControlFrame, createGenerationRecord, createResumableWriter, detachFromResponse, handleGenerationResume } from './llamacpp-compact-stream.js';

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
const API_OPENROUTER = 'https://openrouter.ai/api/v1';
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
        const response = await fetch(`${API_OPENROUTER}/models`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(5000),
        });

        if (!response.ok) {
            console.warn(`OpenRouter models API returned ${response.status}: ${response.statusText}`);
            return false;
        }

        /** @type {any} */
        const data = await response.json();

        if (!Array.isArray(data?.data)) {
            console.warn('OpenRouter API response format unexpected');
            return false;
        }

        const model = data.data.find(m => m.id === modelId);
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
 */
async function sendClaudeRequest(request, response, persist) {
    const apiUrl = new URL(request.body.reverse_proxy || API_CLAUDE).toString();
    const apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.CLAUDE, request.body.secret_id);
    const divider = '-'.repeat(process.stdout.columns);

    if (!apiKey) {
        console.warn(color.red(`Claude API key is missing.\n${divider}`));
        return response.status(400).send({ error: true });
    }

    try {
        const controller = new AbortController();
        request.socket.removeAllListeners('close');
        // A raw-action (persisted) generation deliberately keeps its upstream request running after
        // the client disconnects, instead of aborting it here - same reasoning/precedent as
        // text-completions.js's own `/generate` route (search that file for this exact comment) -
        // this is what lets GET /generate/resume/:id serve a live continuation rather than a
        // truncated partial. Every `controller.abort()` call in this file guarded by `if (persist)
        // return;`/`if (!persist)` follows this same rule.
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

        // Structured output is a forced tool
        if (request.body.json_schema) {
            const jsonTool = {
                name: request.body.json_schema.name,
                description: request.body.json_schema.description || 'Well-formed JSON object',
                input_schema: request.body.json_schema.value,
            };
            requestBody.tools = [...(requestBody.tools || []), jsonTool];
            requestBody.tool_choice = { type: 'tool', name: request.body.json_schema.name };
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
                console.info(color.blue(`Increasing response length to ${newValue}.`));
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

        console.debug('Claude request:', requestBody);

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

        if (request.body.stream) {
            // Pipe remote SSE stream to Express response, tapping the same bytes (unaltered) to
            // accumulate the real reply text for persistence when `persist` is set - the compact re-encoding itself always
            // happens; a falsy `persist` only skips persistence (see
            // `forwardAndPersistCompactStream()`'s own doc comment above for the full teeing mechanism).
            // Claude's SSE stream is a sequence of named events (`message_start`/`content_block_start`/
            // `content_block_delta`/`ping`/`message_delta`/`message_stop`, etc) whose payload JSON
            // itself carries a matching `type` field - only `content_block_delta` events whose own
            // `delta.type === 'text_delta'` are real reply text; every other event/delta type
            // (`thinking_delta` for extended-thinking output, `input_json_delta` for tool-call
            // argument streaming, `citations_delta`, and every non-`content_block_delta` event type)
            // is correctly ignored, so thinking/tool-call content is never mistaken for the reply.
            await forwardAndPersistCompactStream(generateResponse, response, persist,
                json => (json?.type === 'content_block_delta' && json?.delta?.type === 'text_delta') ? json.delta.text : undefined,
                json => json?.delta?.thinking || undefined);
        } else {
            if (!generateResponse.ok) {
                const generateResponseText = await generateResponse.text();
                console.warn(color.red(`Claude API returned error: ${generateResponse.status} ${generateResponse.statusText}\n${generateResponseText}\n${divider}`));
                return response.status(500).send({ error: true });
            }

            /** @type {any} */
            const generateResponseJson = await generateResponse.json();
            const responseText = generateResponseJson?.content?.[0]?.text || '';
            console.debug('Claude response:', generateResponseJson);

            // Wrap it back to OAI format + save the original content
            const reply = { choices: [{ 'message': { 'content': responseText } }], content: generateResponseJson.content };

            // Persist the ASSISTANT's real reply text for a raw-action request (`persist` truthy - a
            // no-op otherwise). The Messages API's `content` array can hold multiple block types
            // alongside each other (e.g. a `type: 'thinking'` block from extended thinking, or
            // `type: 'tool_use'`) - unlike `responseText` above (which only ever reads `content[0]`,
            // pre-existing client-response behavior left untouched here), persistence must extract
            // EVERY real `type: 'text'` block (there can be more than one) and none of the others, so
            // thinking/tool-call content is never persisted as if it were the reply.
            const persistedText = Array.isArray(generateResponseJson?.content)
                ? generateResponseJson.content.filter(block => block?.type === 'text').map(block => block.text).join('')
                : '';
            if (persist) {
                const persisted = await persistAssistantReply(persist, persistedText);
                if (persisted) reply.assistant_node_id = persisted.node_id;
            }

            return response.send(reply);
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
 */
async function sendMakerSuiteRequest(request, response, persist) {
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
            console.debug(`Using Vertex AI authentication type: ${authType}`);
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

        const isThinkingConfigModel = m => (/^gemini-2.5-(flash|pro)/.test(m) && !/-image(-preview)?$/.test(m)) || (/^gemini-3[.\d]*-(flash|pro)/.test(m));
        const isImageSizeModel = m => /^gemini-3/.test(m);
        // https://ai.google.dev/gemini-api/docs/latest-model#api-changes-and-parameter-updates
        const noSamplingModel = /gemini-3\.[67]-flash|gemini-3\.5-flash-lite/.test(model);

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
                console.info('Thinking budget is 0, but includeThoughts is true. Thoughts will not be included in the response.');
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
    console.debug(`${apiName} request:`, body);

    try {
        const controller = new AbortController();
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

        if (stream) {
            try {
                // Pipe remote SSE stream to Express response, tapping the same bytes (unaltered) to
                // accumulate the real reply text for persistence when `persist` is set - the compact re-encoding itself always
                // happens; a falsy `persist` only skips persistence (see
                // `forwardAndPersistCompactStream()`'s own doc comment above). Each `alt=sse` `data:` event
                // is a real, full GenerateContentResponse-shaped JSON payload (the same shape as the
                // non-streaming `generateResponseJson` parsed below), just carrying that CHUNK's own
                // incremental `candidates[0].content.parts` rather than the whole reply - so the exact
                // same `!part.thought` filter this function's own non-streaming branch already applies
                // (see `responseText` below) is reused here too, excluding Gemini's own "thought"/
                // reasoning parts from the persisted text. Parts within a single chunk are joined with
                // '' (not '\n\n', unlike the non-streaming case below): a streamed chunk's parts are
                // adjacent fragments of ONE ongoing chunk of text, not separate paragraphs.
                await forwardAndPersistCompactStream(generateResponse, response, persist, json => {
                    const parts = json?.candidates?.[0]?.content?.parts;
                    return Array.isArray(parts) ? parts.filter(part => !part.thought).map(part => part.text ?? '').join('') : undefined;
                }, json => json?.candidates?.[0]?.content?.parts?.find(part => part.thought)?.text || undefined);
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
            // Pass the object raw, not a pre-formatted util.inspect() dump - inspect() ran unconditionally
            // even when minLogLevel gates console.debug down to a no-op.
            console.debug(`${apiName} response:`, generateResponseJson);

            const responseText = typeof responseContent === 'string' ? responseContent : responseContent?.parts?.filter(part => !part.thought)?.map(part => part.text)?.join('\n\n');
            if (!responseText && !functionCall && !inlineData) {
                let message = `${apiName} Candidate text empty`;
                console.warn(message, generateResponseJson);
                return response.send({ error: { message } });
            }

            // Wrap it back to OAI format (responseContent includes thought signatures in parts array)
            const reply = { choices: [{ 'message': { 'content': responseText } }], responseContent };

            // Persist the ASSISTANT's real reply text for a raw-action request (`persist` truthy - a
            // no-op otherwise). Reuses `responseText` as-is - it's already computed above with the
            // exact same `!part.thought` filter this persistence needs (Gemini's own "thought"/
            // reasoning parts excluded), so no separate extraction is needed here.
            if (persist) {
                const persisted = await persistAssistantReply(persist, responseText ?? '');
                if (persisted) reply.assistant_node_id = persisted.node_id;
            }

            return response.send(reply);
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
 */
async function sendAI21Request(request, response, persist) {
    if (!request.body) return response.sendStatus(400);

    const apiKey = readSecret(request.user.directories, SECRET_KEYS.AI21, request.body.secret_id);
    if (!apiKey) {
        console.warn('AI21 API key is missing.');
        return response.status(400).send({ error: true });
    }

    const bodyParams = {};
    const controller = new AbortController();
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

    console.debug('AI21 request:', body);

    try {
        const generateResponse = await fetch(API_AI21 + '/chat/completions', options);
        if (request.body.stream) {
            // Pipe remote SSE stream to Express response, tapping the same bytes (unaltered) to
            // accumulate the OpenAI Chat-Completions-shaped `choices[0].delta.content` field for
            // persistence when `persist` is set - the compact re-encoding itself always happens;
            // a falsy `persist` only skips persistence (see `forwardAndPersistCompactStream()`'s
            // own doc comment above).
            await forwardAndPersistCompactStream(generateResponse, response, persist, json => json?.choices?.[0]?.delta?.content);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn(`AI21 API returned error: ${generateResponse.status} ${generateResponse.statusText} ${errorText}`);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();
            console.debug('AI21 response:', generateResponseJson);

            // Persist the ASSISTANT's real reply text for a raw-action request (`persist` truthy - a
            // no-op otherwise). Real, verified OpenAI-Chat-Completions-shaped body - see this
            // function's own doc comment above.
            if (persist) {
                const persisted = await persistAssistantReply(persist, generateResponseJson?.choices?.[0]?.message?.content ?? '');
                if (persisted) generateResponseJson.assistant_node_id = persisted.node_id;
            }

            return response.send(generateResponseJson);
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
 */
async function sendMistralAIRequest(request, response, persist) {
    const apiUrl = new URL(request.body.reverse_proxy || API_MISTRAL).toString();
    const apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.MISTRALAI, request.body.secret_id);

    if (!apiKey) {
        console.warn('MistralAI API key is missing.');
        return response.status(400).send({ error: true });
    }

    try {
        const messages = convertMistralMessages(request.body.messages, getPromptNames(request));
        const controller = new AbortController();
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

        console.debug('MisralAI request:', requestBody);

        const generateResponse = await fetch(apiUrl + '/chat/completions', config);
        if (request.body.stream) {
            // Pipe remote SSE stream to Express response, tapping the same bytes (unaltered) to
            // accumulate the OpenAI Chat-Completions-shaped `choices[0].delta.content` field for
            // persistence when `persist` is set - the compact re-encoding itself always happens;
            // a falsy `persist` only skips persistence (see `forwardAndPersistCompactStream()`'s
            // own doc comment above).
            await forwardAndPersistCompactStream(generateResponse, response, persist, json => json?.choices?.[0]?.delta?.content,
                json => json.choices?.find(choice => choice?.delta?.content?.[0]?.thinking)?.delta?.content?.[0]?.thinking?.[0]?.text || undefined);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn(`MistralAI API returned error: ${generateResponse.status} ${generateResponse.statusText} ${errorText}`);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();
            console.debug('MistralAI response:', generateResponseJson);

            // Persist the ASSISTANT's real reply text for a raw-action request (`persist` truthy - a
            // no-op otherwise). Standard, verified OpenAI-Chat-Completions-shaped body - see this
            // function's own doc comment above.
            if (persist) {
                const persisted = await persistAssistantReply(persist, generateResponseJson?.choices?.[0]?.message?.content ?? '');
                if (persisted) generateResponseJson.assistant_node_id = persisted.node_id;
            }

            return response.send(generateResponseJson);
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
 */
async function sendCohereRequest(request, response, persist) {
    const apiKey = readSecret(request.user.directories, SECRET_KEYS.COHERE, request.body.secret_id);
    const controller = new AbortController();
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

        console.debug('Cohere request:', requestBody);

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
            // Pipe remote SSE stream to Express response, tapping the same bytes (unaltered) to
            // accumulate the real reply text for persistence when `persist` is set - the compact re-encoding itself always
            // happens; a falsy `persist` only skips persistence (see
            // `forwardAndPersistCompactStream()`'s own doc comment above). Cohere v2's SSE events carry their
            // own named `type` field (`message-start`/`content-start`/`content-delta`/`tool-plan-delta`/
            // `tool-call-start`/.../`message-end`, etc) - only `content-delta`/`tool-plan-delta` events'
            // own `delta.message.content.text` are real reply-text chunks (see this function's own doc
            // comment above for exactly where this shape is verified), so every other event type is
            // correctly ignored.
            await forwardAndPersistCompactStream(stream, response, persist, json =>
                (typeof json?.delta === 'object' && typeof json?.delta?.message === 'object' && ['content-delta', 'tool-plan-delta'].includes(json?.type))
                    ? (json.delta.message.content?.text ?? '')
                    : undefined);
        } else {
            const generateResponse = await fetch(apiUrl, config);
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn(`Cohere API returned error: ${generateResponse.status} ${generateResponse.statusText} ${errorText}`);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();
            console.debug('Cohere response:', generateResponseJson);

            // Persist the ASSISTANT's real reply text for a raw-action request (`persist` truthy - a
            // no-op otherwise). See this function's own doc comment above for exactly where this shape
            // (message.content[] filtered to type: 'text', falling back to message.tool_plan for a
            // tool-call-only reply) was verified.
            if (persist) {
                const contentText = Array.isArray(generateResponseJson?.message?.content)
                    ? generateResponseJson.message.content.filter(block => block?.type === 'text').map(block => block.text ?? '').join('')
                    : '';
                const persisted = await persistAssistantReply(persist, contentText || generateResponseJson?.message?.tool_plan || '');
                if (persisted) generateResponseJson.assistant_node_id = persisted.node_id;
            }

            return response.send(generateResponseJson);
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
 */
async function sendDeepSeekRequest(request, response, persist) {
    const apiUrl = new URL(request.body.reverse_proxy || API_DEEPSEEK).toString();
    const apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.DEEPSEEK, request.body.secret_id);

    if (!apiKey && !request.body.reverse_proxy) {
        console.warn('DeepSeek API key is missing.');
        return response.status(400).send({ error: true });
    }

    const controller = new AbortController();
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

        console.debug('DeepSeek request:', requestBody);

        const generateResponse = await fetch(apiUrl + '/chat/completions', config);

        if (request.body.stream) {
            // Pipe remote SSE stream to Express response, tapping the same bytes (unaltered) to
            // accumulate the OpenAI Chat-Completions-shaped `choices[0].delta.content` field for
            // persistence when `persist` is set - the compact re-encoding itself always happens;
            // a falsy `persist` only skips persistence (see `forwardAndPersistCompactStream()`'s
            // own doc comment above).
            // Deliberately reads ONLY `delta.content`, never `delta.reasoning_content` (DeepSeek
            // reasoner models' separate reasoning-output field - see this function's own doc comment
            // above), so reasoning is never persisted as if it were the reply.
            await forwardAndPersistCompactStream(generateResponse, response, persist, json => json?.choices?.[0]?.delta?.content,
                json => json.choices?.find(choice => choice?.delta?.reasoning_content)?.delta?.reasoning_content || undefined);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn(`DeepSeek API returned error: ${generateResponse.status} ${generateResponse.statusText} ${errorText}`);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();
            console.debug('DeepSeek response:', generateResponseJson);

            // Persist the ASSISTANT's real reply text for a raw-action request (`persist` truthy - a
            // no-op otherwise). Standard, verified OpenAI-Chat-Completions-shaped body - see this
            // function's own doc comment above. Deliberately reads ONLY `message.content`, never
            // `message.reasoning_content`.
            if (persist) {
                const persisted = await persistAssistantReply(persist, generateResponseJson?.choices?.[0]?.message?.content ?? '');
                if (persisted) generateResponseJson.assistant_node_id = persisted.node_id;
            }

            return response.send(generateResponseJson);
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
 */
async function sendXaiRequest(request, response, persist) {
    const apiUrl = new URL(request.body.reverse_proxy || API_XAI).toString();
    const apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(request.user.directories, SECRET_KEYS.XAI, request.body.secret_id);

    if (!apiKey && !request.body.reverse_proxy) {
        console.warn('xAI API key is missing.');
        return response.status(400).send({ error: true });
    }

    const controller = new AbortController();
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

        console.debug('xAI request:', requestBody);

        const generateResponse = await fetch(apiUrl + '/chat/completions', config);

        if (request.body.stream) {
            // Pipe remote SSE stream to Express response, tapping the same bytes (unaltered) to
            // accumulate the OpenAI Chat-Completions-shaped `choices[0].delta.content` field for
            // persistence when `persist` is set - the compact re-encoding itself always happens;
            // a falsy `persist` only skips persistence (see `forwardAndPersistCompactStream()`'s
            // own doc comment above).
            await forwardAndPersistCompactStream(generateResponse, response, persist, json => json?.choices?.[0]?.delta?.content,
                json => json.choices?.find(choice => choice?.delta?.reasoning_content)?.delta?.reasoning_content || undefined);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn(`xAI API returned error: ${generateResponse.status} ${generateResponse.statusText} ${errorText}`);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();
            console.debug('xAI response:', generateResponseJson);

            // Persist the ASSISTANT's real reply text for a raw-action request (`persist` truthy - a
            // no-op otherwise). Standard, verified OpenAI-Chat-Completions-shaped body - see this
            // function's own doc comment above.
            if (persist) {
                const persisted = await persistAssistantReply(persist, generateResponseJson?.choices?.[0]?.message?.content ?? '');
                if (persisted) generateResponseJson.assistant_node_id = persisted.node_id;
            }

            return response.send(generateResponseJson);
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
 */
async function sendAimlapiRequest(request, response, persist) {
    const apiUrl = API_AIMLAPI;
    const apiKey = readSecret(request.user.directories, SECRET_KEYS.AIMLAPI, request.body.secret_id);

    if (!apiKey) {
        console.warn('AI/ML API key is missing.');
        return response.status(400).send({ error: true });
    }

    const controller = new AbortController();
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

        console.debug('AI/ML API request:', requestBody);

        const generateResponse = await fetch(apiUrl + '/chat/completions', config);

        if (request.body.stream) {
            // Pipe remote SSE stream to Express response, tapping the same bytes (unaltered) to
            // accumulate the OpenAI Chat-Completions-shaped `choices[0].delta.content` field for
            // persistence when `persist` is set - the compact re-encoding itself always happens;
            // a falsy `persist` only skips persistence (see `forwardAndPersistCompactStream()`'s
            // own doc comment above).
            await forwardAndPersistCompactStream(generateResponse, response, persist, json => json?.choices?.[0]?.delta?.content, extractGenericReasoning);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn(`AI/ML API returned error: ${generateResponse.status} ${generateResponse.statusText} ${errorText}`);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();
            console.debug('AI/ML API response:', generateResponseJson);

            // Persist the ASSISTANT's real reply text for a raw-action request (`persist` truthy - a
            // no-op otherwise). Standard, verified OpenAI-Chat-Completions-shaped body - see this
            // function's own doc comment above.
            if (persist) {
                const persisted = await persistAssistantReply(persist, generateResponseJson?.choices?.[0]?.message?.content ?? '');
                if (persisted) generateResponseJson.assistant_node_id = persisted.node_id;
            }

            return response.send(generateResponseJson);
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
 */
async function sendElectronHubRequest(request, response, persist) {
    const apiUrl = API_ELECTRONHUB;
    const apiKey = readSecret(request.user.directories, SECRET_KEYS.ELECTRONHUB, request.body.secret_id);

    if (!apiKey) {
        console.warn('Electron Hub key is missing.');
        return response.status(400).send({ error: true });
    }

    const controller = new AbortController();
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

        console.debug('Electron Hub request:', requestBody);

        const generateResponse = await fetch(apiUrl + '/chat/completions', config);

        if (request.body.stream) {
            // Pipe remote SSE stream to Express response, tapping the same bytes (unaltered) to
            // accumulate the OpenAI Chat-Completions-shaped `choices[0].delta.content` field for
            // persistence when `persist` is set - the compact re-encoding itself always happens;
            // a falsy `persist` only skips persistence (see `forwardAndPersistCompactStream()`'s
            // own doc comment above).
            await forwardAndPersistCompactStream(generateResponse, response, persist, json => json?.choices?.[0]?.delta?.content, extractGenericReasoning);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn('Electron Hub returned error: ', errorText);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();
            console.debug('Electron Hub response:', generateResponseJson);

            // Persist the ASSISTANT's real reply text for a raw-action request (`persist` truthy - a
            // no-op otherwise). Standard, verified OpenAI-Chat-Completions-shaped body - see this
            // function's own doc comment above.
            if (persist) {
                const persisted = await persistAssistantReply(persist, generateResponseJson?.choices?.[0]?.message?.content ?? '');
                if (persisted) generateResponseJson.assistant_node_id = persisted.node_id;
            }

            return response.send(generateResponseJson);
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
 */
async function sendChutesRequest(request, response, persist) {
    const apiUrl = API_CHUTES;
    const apiKey = readSecret(request.user.directories, SECRET_KEYS.CHUTES, request.body.secret_id);

    if (!apiKey) {
        console.warn('Chutes key is missing.');
        return response.status(400).send({ error: true });
    }

    const controller = new AbortController();
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

        console.debug('Chutes request:', requestBody);

        const generateResponse = await fetch(apiUrl + '/chat/completions', config);

        if (request.body.stream) {
            // Pipe remote SSE stream to Express response, tapping the same bytes (unaltered) to
            // accumulate the OpenAI Chat-Completions-shaped `choices[0].delta.content` field for
            // persistence when `persist` is set - the compact re-encoding itself always happens;
            // a falsy `persist` only skips persistence (see `forwardAndPersistCompactStream()`'s
            // own doc comment above).
            await forwardAndPersistCompactStream(generateResponse, response, persist, json => json?.choices?.[0]?.delta?.content, extractGenericReasoning);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn('Chutes returned error: ', errorText);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();
            console.debug('Chutes response:', generateResponseJson);

            // Persist the ASSISTANT's real reply text for a raw-action request (`persist` truthy - a
            // no-op otherwise). Standard, verified OpenAI-Chat-Completions-shaped body - see this
            // function's own doc comment above.
            if (persist) {
                const persisted = await persistAssistantReply(persist, generateResponseJson?.choices?.[0]?.message?.content ?? '');
                if (persisted) generateResponseJson.assistant_node_id = persisted.node_id;
            }

            return response.send(generateResponseJson);
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
 */
async function sendMinimaxRequest(request, response, persist) {
    const apiUrl = request.body.minimax_endpoint === MINIMAX_ENDPOINT.CN
        ? API_MINIMAX_CN : API_MINIMAX;
    const apiKey = readSecret(request.user.directories, SECRET_KEYS.MINIMAX, request.body.secret_id);

    if (!apiKey) {
        console.warn('MiniMax key is missing.');
        return response.status(400).send({ error: true });
    }

    const controller = new AbortController();
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

        console.debug('MiniMax request:', requestBody);

        const generateResponse = await fetch(apiUrl + '/chat/completions', config);

        if (request.body.stream) {
            // Pipe remote SSE stream to Express response, tapping the same bytes (unaltered) to
            // accumulate the OpenAI Chat-Completions-shaped `choices[0].delta.content` field for
            // persistence when `persist` is set - the compact re-encoding itself always happens;
            // a falsy `persist` only skips persistence (see `forwardAndPersistCompactStream()`'s
            // own doc comment above).
            await forwardAndPersistCompactStream(generateResponse, response, persist, json => json?.choices?.[0]?.delta?.content);
        } else {
            if (!generateResponse.ok) {
                const errorText = await generateResponse.text();
                console.warn('MiniMax returned error: ', errorText);
                const errorJson = tryParse(errorText) ?? { error: true };
                return response.status(500).send(errorJson);
            }
            const generateResponseJson = await generateResponse.json();
            console.debug('MiniMax response:', generateResponseJson);

            // Persist the ASSISTANT's real reply text for a raw-action request (`persist` truthy - a
            // no-op otherwise). Standard, verified OpenAI-Chat-Completions-shaped body - see this
            // function's own doc comment above.
            if (persist) {
                const persisted = await persistAssistantReply(persist, generateResponseJson?.choices?.[0]?.message?.content ?? '');
                if (persisted) generateResponseJson.assistant_node_id = persisted.node_id;
            }

            return response.send(generateResponseJson);
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
 */
async function sendAzureOpenAIRequest(request, response, persist) {
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

    const controller = new AbortController();
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

    console.debug('Azure OpenAI Request Body:', apiRequestBody);
    try {
        const fetchResponse = await fetch(endpointUrl, config);

        if (request.body.stream) {
            // Pipe remote SSE stream to Express response, tapping the same bytes (unaltered) to
            // accumulate the OpenAI Chat-Completions-shaped `choices[0].delta.content` field for
            // persistence when `persist` is set - the compact re-encoding itself always happens;
            // a falsy `persist` only skips persistence (see `forwardAndPersistCompactStream()`'s
            // own doc comment above).
            return await forwardAndPersistCompactStream(fetchResponse, response, persist, json => json?.choices?.[0]?.delta?.content);
        }

        if (fetchResponse.ok) {
            /** @type {any} */
            const json = await fetchResponse.json();
            console.debug('Azure OpenAI response:', json);

            // Persist the ASSISTANT's real reply text for a raw-action request (`persist` truthy - a
            // no-op otherwise). Standard, verified OpenAI-Chat-Completions-shaped body - see this
            // function's own doc comment above.
            if (persist) {
                const persisted = await persistAssistantReply(persist, json?.choices?.[0]?.message?.content ?? '');
                if (persisted) json.assistant_node_id = persisted.node_id;
            }

            return response.send(json);
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

router.post('/bias', async function (request, response) {
    if (!request.body || !Array.isArray(request.body))
        return response.sendStatus(400);

    try {
        const result = await computeLogitBias(request.body, String(request.query.model || ''));
        return response.send(result);
    } catch (error) {
        console.error(error);
        return response.send({});
    }
});

/**
 * Bound on how many "backend calls a server-native tool -> execute it -> call the backend again"
 * rounds a single raw-action `/generate` request may go through before giving up and returning a
 * real error, instead of looping forever against a backend/tool combination that never settles on a
 * plain-text reply. Matches the client-side precedent's own recursion bound
 * (`ToolManager.RECURSE_LIMIT`, public/scripts/tool-calling.js) - kept as the same numeric value (5)
 * for consistency, even though the two limits guard genuinely different loops (this one is
 * server-round-trips-to-the-backend; the client's is its own recursive
 * `invokeFunctionTools()`-then-generate-again chain).
 */
const SERVER_TOOL_ROUND_LIMIT = 5;

/**
 * Builds the real backend-request-shaped payload for the raw-action `/generate` branch below - the
 * direct chat-completion analog of `buildRawActionTextCompletionRequest()`
 * (src/endpoints/backends/text-completions.js, commit ac42ce8c9). Mirrors that function's shape/
 * naming/scoping discipline as closely as the real differences between the two pipelines allow - see
 * this session's task write-up for the full read-first list.
 *
 * In order:
 * 1. Real existence checks for the named character/group (identical pattern to
 *    `buildRawActionTextCompletionRequest()` - `readCardContent`/`getGroupsByIds`, tolerating a
 *    missing/unreadable card as "not found" rather than letting an ENOENT bubble up as an unrelated 500).
 * 2. Real anchor-node resolution (a given `nodeId` verified via `getAncestorPath()`, or - only when
 *    `nodeId` is explicitly `null` AND this owner's conversation is genuinely empty - the owner's
 *    own anchor) - identical logic to the text-completion helper; see this function's own ADDRESSING
 *    MODEL doc comment below.
 * 3. Read real `oai_settings`/`power_user` via `readSettingsAtPaths()` - JUDGMENT CALL: unlike
 *    text-completion (which needs a separate `resolveTextGenBackend()` step - see
 *    src/textgen-backend-resolve.js), chat completion has no separate "resolve the active backend
 *    connection" concept: `oai_settings.chat_completion_source`/model selection IS the settings, and
 *    `resolveChatCompletionGenerationInput()` already reads `oai_settings` internally to resolve
 *    `model`. Confirmed by reading the `connection_profile_id` branch above (which resolves its own
 *    `settings`/`selectedApiMap.source` from a connection profile + preset, a genuinely different,
 *    profile-driven case) and the default/legacy inline dispatch further below (which reads
 *    `request.body.chat_completion_source`/`request.body.secret_id` as given by the client - the
 *    client is expected to have already put its own active `oai_settings`-derived values there). This
 *    raw-action branch is the one case that resolves the user's OWN currently active `oai_settings`
 *    server-side, for real, instead of trusting a client-supplied value.
 * 4. Resolve the orchestrator's full input from real on-disk settings/character/chat state via
 *    `resolveChatCompletionGenerationInput()`.
 * 5. Assemble the real message array via `prepareOpenAIMessages(orchestratorInput, false)` (a real
 *    generation, never a dry run here).
 * 6. Build the real backend-request payload via `createGenerationParameters()`. Context fields are
 *    resolved the SAME honest way `resolveChatCompletionGenerationInput()`'s own doc comment already
 *    established for each of them (see that module's FIELD-MAPPING NOTES and
 *    src/chat-completion-generation-data.js's own doc comment for the full per-field rationale):
 *      - `biasPresetEntries`: real, resolved via `oai_settings.bias_preset_selected`/`.bias_presets`,
 *        the exact same one-line derivation the `connection_profile_id` branch above already performs.
 *      - `useLogprobs`: real, `Boolean(power_user.request_token_probabilities)` - verified against
 *        public/scripts/chat-completion-settings.js's own `const useLogprobs =
 *        !!power_user.request_token_probabilities` (~line 2851), a plain, simple settings-path
 *        mapping this module's own doc comment explicitly says a caller may resolve directly.
 *      - `chatId`: real, the resolved `anchorNodeId` - chat-completion-generation-data.js's own doc
 *        comment says this is only ever `getCurrentChatId()` because "the caller already knows which
 *        chat this generation belongs to"; the real, resolved node id (whether caller-given or
 *        anchor-resolved for a brand-new conversation - see this function's own ADDRESSING MODEL doc
 *        comment) IS that knowledge, so it's forwarded for real rather than left `undefined`.
 *      - `macroContext`: real, `orchestratorInput.macroContext` (already built by the resolver).
 *      - `toolsPayload`: resolved here from TWO sources merged into one `tools` array -
 *        (1) the server-native tool registry (`../../server-tools.js`, chunk (a)): `ctx =
 *        {directories, ownerId, characterAvatar, groupId}` (the exact tuple already resolved above
 *        for everything else in this function) is passed to `getEnabledServerTools(ctx)`; and
 *        (2) chunk (c)'s `clientToolSchemas` param (the browser-extension `ToolManager`'s own
 *        advertised tools, merged in with server tools taking priority on a name collision - see
 *        this function's own `clientToolSchemas` doc comment above for the full policy). When the
 *        combined list is non-empty, `toolsPayload = {tools: [...], tool_choice: 'auto'}` is
 *        forwarded into `createGenerationParameters()` - otherwise `toolsPayload` stays `undefined`,
 *        so a request with no server tool registered AND no `client_tools` sent advertises no
 *        `tools` at all, byte-for-byte identical to this route's pre-chunk-(b) behavior. The route
 *        handler's tool-execution loop (`runServerToolRounds()`) uses `enabledClientToolNames`
 *        (this function's own return value) to tell a legitimate client-only tool call apart from a
 *        genuinely unrecognized/hallucinated one - see that function's own doc comment.
 *      - `jsonSchema`: real, forwarded verbatim from this function's own `jsonSchema` param straight
 *        into `createGenerationParameters()` (which already turns it into `generate_data.json_schema` -
 *        see that function's own doc comment/implementation, src/chat-completion-generation-data.js).
 *        NOT a new capability: every provider branch below (`sendClaudeRequest`/the default dispatch's
 *        own `request.body.json_schema` handling/etc.) already reads `request.body.json_schema` and
 *        turns it into that provider's own `response_format`/`json_schema` shape - this was purely a
 *        raw-action-specific gap (this function never accepted the param at all) fixed by this task, not
 *        a fresh subsystem.
 *      - `getStoppingStrings`/`groupNames`/`electronHubReasoningEfforts`/
 *        `reverseProxyValidated`/`logitBias` override: still NOT resolved here - explicit,
 *        documented MVP scope boundaries per chat-completion-generation-data.js's own doc comment
 *        (each needs a genuinely separate subsystem - live model lists, a reverse-proxy confirmation
 *        UI, etc. - not guessed at here). Left at `createGenerationParameters()`'s own defaults.
 *
 * Does NOT persist anything (the caller's job - see the route handler below) and does NOT set
 * `stream`/`chat_completion_source`/`secret_id` on the returned `params` (also the caller's job,
 * mirroring the `connection_profile_id` branch's own final-assignment shape).
 *
 * ADDRESSING MODEL (this task's correction) - identical rule to
 * `buildRawActionTextCompletionRequest()` (src/endpoints/backends/text-completions.js) - see that
 * function's own doc comment for the full rationale (label vs. node-address are different concepts;
 * a real client always already has the concrete `node_id` it's looking at by the time it's about to
 * generate). There is no `branchName`/`branch_name` field in this raw-action surface. `nodeId` is
 * the ONLY addressing input and is REQUIRED, but `null` is a valid, meaningful value:
 * - A real `nodeId` string: address that specific existing node - unchanged prior behavior.
 * - `nodeId === null`: valid ONLY when this owner's conversation is genuinely empty - resolved via
 *   the owner's anchor. If the owner already has real history, this is a real 400, not a silent guess.
 * - `nodeId === undefined` (the key was absent from the request body entirely): throws - a caller
 *   that doesn't know whether it has real history yet must say so explicitly (`null`), not omit the
 *   field and have the server guess.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {object} params
 * @param {string} [params.characterAvatar] Character avatar filename. One of this or `groupId` is required.
 * @param {string} [params.groupId] Group id. One of this or `characterAvatar` is required.
 * @param {string} params.ownerId message-tree-db.js owner id.
 * @param {string|null} params.nodeId REQUIRED (`undefined` throws) - see ADDRESSING MODEL above. A
 * real node id string addresses that node; `null` asserts "this is a genuinely new, empty
 * conversation" and only succeeds when that is actually true.
 * @param {string} [params.type] Generation type ('normal'/'impersonate'/'continue'/'swipe'/...).
 * @param {boolean} [params.isImpersonate]
 * @param {boolean} [params.isContinue]
 * @param {boolean} [params.isSwipe]
 * @param {string} [params.userMessageText] The literal text the user typed this turn. Omit for
 * generation types that don't add a new message (continue/swipe).
 * @param {object} [params.userMessageExtra] Already-SERVER-VALIDATED `extra` (see
 * `sanitizeUserMessageExtra()` in message-tree-db.js) for the new user message being appended -
 * forwarded verbatim to `resolveChatCompletionGenerationInput()`; the caller (route handler below) is
 * responsible for having already sanitized whatever the client sent. Ignored when `userMessageText`
 * is omitted.
 * @param {any[]} [params.clientToolSchemas] Chunk (c): the client's own `client_tools` array, exactly
 * as sent on the wire (`ToolManager.registerFunctionToolsOpenAI()`'s computed
 * `[{type:'function', function:{name, description, parameters}}, ...]` shape) - tools registered via
 * the browser-extension `ToolManager` API (`public/scripts/tool-calling.js`) that genuinely cannot
 * execute server-side. Untrusted, attacker-controlled input: only entries shaped
 * `{type:'function', function:{name: non-empty string, ...}}` are kept, everything else is silently
 * dropped (same "a bad/foreign field doesn't fail the whole request" convention as
 * `sanitizeUserMessageExtra()`); duplicate `function.name`s within this same array keep only the
 * first occurrence. NAME-COLLISION POLICY (this task's judgment call): a client tool whose name
 * collides with an already-`enabledServerTools` name is DROPPED (with a logged warning), and the
 * server-native tool wins - server tools are operator-configured (registered by a trusted server
 * plugin via `registerServerTool()`, chunk (a)), while `clientToolSchemas` is arbitrary,
 * unauthenticated-as-to-intent client input; letting an unprivileged client silently shadow an
 * operator-configured tool by re-declaring its name would be a real privilege inversion. This
 * mirrors `server-tools.js`'s own registry, which already throws on a same-name collision between
 * two *trusted* registrations - dropping (not throwing) here because this collision involves
 * untrusted input and must degrade gracefully, not fail the whole generation request.
 * @param {object} [params.jsonSchema] JSON schema for a structured/JSON-schema-constrained generation -
 * same shape `generateQuietPrompt()`/the legacy client-assembled chat-completion path already use and
 * every provider branch in this file already reads off `request.body.json_schema`: `{name: string,
 * description?: string, value: object, strict?: boolean, returnInvalid?: boolean}` (`value` is the
 * actual JSON schema object; `returnInvalid` is client-side-only, read by `extractJsonFromData()` in
 * public/script.js, never by this server). Forwarded verbatim into `createGenerationParameters()` - see
 * this function's own doc comment, item 6, `jsonSchema` bullet.
 * @param {string[]} [params.stealthClientToolNames] THIS TASK (stealth-tool parity): the wire's new
 * `stealth_tool_names` field - the subset of the client's OWN `clientToolSchemas` names that
 * `ToolManager.isStealthTool()` says are stealth (public/scripts/tool-calling.js - a per-TOOL
 * registration flag, "a tool call result will not be shown in the chat, no follow-up generation is
 * performed"). Untrusted, attacker-controlled input like `clientToolSchemas` itself: only string
 * entries are kept, and only those that also survived into `enabledClientToolNames` matter (see the
 * `enabledStealthClientToolNames` return value below) - a name that isn't even an advertised
 * `client_tools` entry (typo, or a name that lost the name-collision policy to a server tool) is
 * simply inert, never treated as "this round should abort" for a name that was never really
 * client-only to begin with.
 * @returns {Promise<{ params: object, settings: object, anchorNodeId: string|null, anchorContent: object|null, name1: string, name2: string, enabledServerTools: import('../../server-tools.js').ServerToolRegistration[], enabledClientToolNames: Set<string>, enabledStealthClientToolNames: Set<string> }>}
 * `enabledServerTools` is the same list used to build `params.tools` (empty when no server tool is
 * currently enabled for this request) - returned so the route handler's tool-execution loop doesn't
 * need to re-query the registry (and re-run every tool's own `shouldEnable(ctx)`) a second time.
 * `enabledClientToolNames` (chunk (c)) is the set of `clientToolSchemas` names actually advertised to
 * the backend after the collision policy above (i.e. excluding any dropped for colliding with a
 * server tool name) - the route handler's tool-execution loop uses this to tell "hand off to the
 * client" (name is here) apart from "hallucinated/unknown tool name" (name is in neither this set nor
 * `enabledServerTools`). `enabledStealthClientToolNames` (this task) is the subset of
 * `enabledClientToolNames` that `stealthClientToolNames` marked stealth - see
 * `runServerToolRounds()`'s own doc comment for how this is used to abort a round instead of handing
 * it off.
 */
export async function buildRawActionChatCompletionRequest(directories, {
    characterAvatar, groupId, ownerId, nodeId,
    type = 'normal', isImpersonate = false, isContinue = false, isSwipe = false, userMessageText, userMessageExtra,
    clientToolSchemas, stealthClientToolNames, jsonSchema = null,
} = {}) {
    if (!ownerId) {
        throw new Error('owner_id is required');
    }
    if (!characterAvatar && !groupId) {
        throw new Error('character_avatar or group_id is required');
    }
    // See ADDRESSING MODEL above - `undefined` means the request body never had the `node_id` key at
    // all (real JSON has no `undefined` literal, so this is distinguishable from an explicit `null`).
    if (nodeId === undefined) {
        throw new Error('node_id is required (pass null explicitly for a brand-new, empty conversation)');
    }

    // Step 1 (existence checks) - identical convention to buildRawActionTextCompletionRequest().
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
        const group = getGroupsByIds(directories, [groupId])[groupId];
        if (!group) {
            throw new Error(`Group not found: ${groupId}`);
        }
    }

    // Step 2 (anchor resolution) - identical logic to buildRawActionTextCompletionRequest(): a real
    // given `nodeId` is verified directly; `nodeId === null` is left unresolved here and read back
    // off `orchestratorInput.resolvedNodeId`/`chatResolutionAmbiguous` once Step 4 has computed it,
    // rather than re-deriving "does this owner have real history" a second, independent way.
    let anchorNodeId = null;
    if (nodeId !== null) {
        const ancestorPath = await getAncestorPath(directories, nodeId);
        if (!ancestorPath) {
            throw new Error(`Chat node not found: ${nodeId}`);
        }
        anchorNodeId = nodeId;
    }

    // Step 3
    const { oai_settings: settings = {}, power_user: powerUser = {} } = readSettingsAtPaths(directories, ['oai_settings', 'power_user']);

    // Step 4
    // `imageInlining`/`videoInlining`/`audioInlining` OVERRIDE via `macroExtras` (resolveChatCompletionGenerationInput()'s
    // own doc comment: these three otherwise resolve to `false` - a documented, PRE-EXISTING MVP scope
    // boundary from before this task, since the client's own real capability predicates
    // (`isImageInliningSupported()`/etc., public/scripts/chat-completion-settings.js) are not ported
    // server-side). Without this override, a `userMessageExtra.media` entry forwarded by this task's
    // own new attachment-plumbing would be silently inert (present in `extra.media`, never inlined) -
    // NOT a fabricated capability check, but a REAL, narrower one than the client's: just the user's own
    // `oai_settings.media_inlining` on/off toggle (the single settings field that gates all three
    // inlining kinds together - see that setting's own migration history merging former
    // `image_inlining`/`video_inlining`/`audio_inlining` into one flag), WITHOUT also re-checking the
    // client's per-model vision-capability allowlist (a large, hardcoded model-name list with no
    // server-side port - porting THAT is out of this task's scope, left as its own real, addressable
    // follow-up). Practical effect of the narrowing: a raw-action request MAY attempt to inline media
    // even when the currently-selected model doesn't actually support vision, if the user has
    // `media_inlining` enabled - `Message.addImage()`'s own real backend call would then fail/be
    // ignored by that backend, not this server silently mis-behaving.
    const mediaInliningEnabled = Boolean(settings.media_inlining);
    const orchestratorInput = await resolveChatCompletionGenerationInput(directories, {
        avatar: characterAvatar, groupId, ownerId, nodeId,
        type, isImpersonate, isContinue, isSwipe, userMessageText, userMessageExtra,
        macroExtras: {
            imageInlining: mediaInliningEnabled, videoInlining: mediaInliningEnabled, audioInlining: mediaInliningEnabled,
        },
    });

    // `nodeId === null` is only valid when this owner's conversation is really empty - see this
    // function's own ADDRESSING MODEL doc comment and buildRawActionTextCompletionRequest()'s
    // identical handling.
    if (nodeId === null) {
        if (orchestratorInput.chatResolutionAmbiguous) {
            throw new Error('node_id is required: this character/group already has an existing conversation - resolve which node the client was looking at and pass its node_id (null is only valid for a genuinely new, empty conversation)');
        }
        anchorNodeId = orchestratorInput.resolvedNodeId;
    }

    // Checked against the RAW (pre-drop) history length, not `orchestratorInput.macroContext.chat`
    // (which, for a swipe/regenerate, has already had the message being replaced dropped - see
    // resolveChatCompletionGenerationInput()'s own `promptChat`/`rawChatLength` doc comments). A chat
    // with exactly one message (e.g. a fresh chat's opening greeting) being swiped legitimately ends
    // up with zero remaining context - that's not the same as "there was nothing to swipe at all".
    if ((isContinue || isSwipe) && orchestratorInput.rawChatLength === 0) {
        throw new Error('Cannot continue/swipe an empty chat.');
    }

    // Step 5
    const { chat: messages } = await prepareOpenAIMessages(orchestratorInput, false);

    // Step 6
    const biasPresetEntries = settings.bias_preset_selected ? settings.bias_presets?.[settings.bias_preset_selected] : undefined;
    const useLogprobs = Boolean(powerUser.request_token_probabilities);
    // Server-native tool registry (../../server-tools.js, chunk (a)) - see this function's own doc
    // comment, item 6, for the full rationale. `ctx` is exactly the tuple this route already has
    // resolved for everything else here; nothing new is computed to build it.
    const serverToolCtx = { directories, ownerId, characterAvatar, groupId };
    const enabledServerTools = await getEnabledServerTools(serverToolCtx);
    const serverToolNames = new Set(enabledServerTools.map(tool => tool.name));

    // Chunk (c): merge in the client's own `client_tools` (see this function's own doc comment,
    // `clientToolSchemas` param, for the full validation/collision rationale). Kept as a Map (not a
    // plain array-dedupe) so a duplicate `function.name` WITHIN `clientToolSchemas` itself keeps only
    // its first occurrence, matching the collision-drop convention below.
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

    // THIS TASK (stealth-tool parity): only names that are BOTH advertised (`enabledClientToolNames`)
    // AND flagged stealth by the client survive - see this function's own `stealthClientToolNames`
    // param doc comment for why a name outside `enabledClientToolNames` must not count.
    const enabledStealthClientToolNames = new Set(
        Array.isArray(stealthClientToolNames)
            ? stealthClientToolNames.filter(name => typeof name === 'string' && enabledClientToolNames.has(name))
            : [],
    );

    const combinedToolSchemas = [...enabledServerTools.map(toOpenAIToolSchema), ...clientToolsByName.values()];
    const toolsPayload = combinedToolSchemas.length > 0
        ? { tools: combinedToolSchemas, tool_choice: 'auto' }
        : undefined;
    const { generate_data } = await createGenerationParameters(settings, orchestratorInput.model, type, messages, {
        macroContext: orchestratorInput.macroContext,
        biasPresetEntries,
        useLogprobs,
        chatId: anchorNodeId,
        toolsPayload,
        jsonSchema,
    });

    // JUDGMENT CALL: unlike buildRawActionTextCompletionRequest() (which gets `name1` back directly
    // on resolveTextCompletionGenerationInput()'s own return object), this resolver only exposes
    // `name1` inside `macroContext` (see that module's doc comment decision 2/FIELD-MAPPING NOTES -
    // `name1` itself is never a top-level field on its returned object) - read from there instead.
    //
    // `anchorContent` (used only for `is_continue` persistence - see the route handler below): the
    // CURRENT, on-disk content of the anchor node, read from `orchestratorInput.macroContext.chat`'s
    // own last entry rather than a second DB read. Verified (not assumed) safe to reuse here:
    // resolveChatCompletionGenerationInput()'s own `promptChat` (which becomes `macroContext.chat`)
    // only drops the last entry when `isSwipe` (see that function's own `promptChat` doc comment) -
    // never for `isContinue`, so for a continue call `macroContext.chat` is exactly `orchestratorInput`
    // 's raw, undropped `chat` and its last entry is the anchor's real, current content. Only
    // meaningful when that array is non-empty, which the `rawChatLength === 0` guard above already
    // guarantees for `isContinue` - `null` otherwise.
    const anchorChat = orchestratorInput.macroContext.chat;
    const anchorContent = anchorChat.length > 0 ? anchorChat[anchorChat.length - 1] : null;

    return { params: generate_data, settings, anchorNodeId, anchorContent, name1: orchestratorInput.macroContext.name1, name2: orchestratorInput.name2, enabledServerTools, enabledClientToolNames, enabledStealthClientToolNames };
}

/**
 * Coalesces binary-frame writes for one response, guarding every `response.write()` against firing
 * after `response.writableEnded` (a real client-disconnect race - the upstream body can still emit a
 * final `data` event after the client's socket closed) and against backpressure (buffers while
 * waiting for `drain`, as under a slow/lossy connection).
 *
 * JUDGMENT CALL: a local, file-scoped copy rather than exporting/importing
 * `createBackpressureWriter` from `./llamacpp-compact-stream.js` - that file is owned by a
 * concurrently-running change in this same effort (extending the compact protocol for the
 * text-completion path) and is out of scope to edit here; same "separate local copy" precedent this
 * file already follows for its own `forwardAndPersistCompactStream` history.
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

/** Generic OpenAI-Chat-Completions-shaped `choices[0].delta.reasoning_content`/`.reasoning` fallback,
 * matching `getStreamingReply()`'s own identical fallback in chat-completion-settings.js for every
 * source that has no more specific reasoning field of its own. */
function extractGenericReasoning(json) {
    return json?.choices?.find(choice => choice?.delta?.reasoning_content)?.delta?.reasoning_content
        ?? json?.choices?.find(choice => choice?.delta?.reasoning)?.delta?.reasoning
        ?? undefined;
}

/**
 * Forwards a fetch() response's live SSE stream as the compact binary protocol (see
 * `./llamacpp-compact-stream.js` for the wire format) instead of the upstream SSE-JSON bytes
 * verbatim - direct instruction from the user, server side forwards nothing raw to the client.
 *
 * Called for every streaming request reaching one of the provider-specific `sendXRequest()`
 * functions, raw-action or not - `persist` (`pendingAssistantPersist`) only gates whether the
 * accumulated text is persisted once the stream ends; a falsy `persist` (quiet generations,
 * connection-profile testing, group-member impersonation preview) still gets the same compact-v1
 * re-encoding, just with the persistence step skipped.
 *
 * Each `data:` line's JSON is parsed exactly like the previous SSE-line-forwarding implementation
 * (line-buffered across TCP chunk boundaries) and passed to `extractText(json)`/`extractReasoning(json)`
 * to pull out that provider's real per-chunk text/reasoning fields - the exact same per-provider shapes
 * `getStreamingReply()` already uses client-side. Content is coalesced (first chunk flushed immediately
 * for perceived responsiveness, then buffered up to ~256 bytes or ~40ms since the last flush, whichever
 * comes first) into `encodeContent()` frames; a reasoning or swipe-index frame flushes any pending
 * content first so frame order matches arrival order. Once the upstream stream ends, the accumulated
 * text (if any) is persisted (when `persist` is set) and its node id is sent as the final
 * `encodeAssistantNodeIdFrame()` frame before `response.end()`.
 * @param {import('node-fetch').Response} fetchResponse
 * @param {import('express').Response} response
 * @param {object|null|undefined} persist `pendingAssistantPersist`, or a falsy value to skip
 * persistence only - the compact binary re-encoding itself always happens.
 * @param {(json: any) => string|undefined} extractText Pulls the real per-chunk generated-text
 * field out of one parsed SSE JSON payload.
 * @param {((json: any) => string|undefined)|null} [extractReasoning] Pulls that provider's real
 * per-chunk reasoning/thinking text out of one parsed SSE JSON payload, or `null` for a provider with
 * no reasoning field of its own (Claude/Gemini/DeepSeek/xAI/Mistral pass their own; everything else
 * OpenAI-Chat-Completions-shaped passes `extractGenericReasoning`; AI21/MiniMax/Azure pass `null`,
 * matching `getStreamingReply()` never surfacing reasoning for those sources either).
 * @returns {Promise<void>}
 */
async function forwardAndPersistCompactStream(fetchResponse, response, persist, extractText, extractReasoning = null) {
    if (!fetchResponse.ok || !fetchResponse.body) {
        return forwardFetchResponse(fetchResponse, response);
    }

    let statusCode = fetchResponse.status;
    if (statusCode === 401) statusCode = 400;
    response.statusCode = statusCode;
    response.statusMessage = fetchResponse.statusText;
    // Same header value/wire format as the llama.cpp/text-completion path's own compact stream
    // (text-completions.js's forwardAndPersistCompactStream()) - originally given a distinct
    // 'compact-v1-chat' value to avoid ambiguity between two independent conversions happening
    // concurrently in the same session, but the bytes are byte-for-byte identical (both use the same
    // encoder functions from llamacpp-compact-stream.js), so there is exactly one wire format and one
    // header value across every raw-action streaming path.
    response.setHeader('X-ST-Stream-Format', 'compact-v1');
    const generationId = randomUUID();
    response.setHeader('X-Generation-Id', generationId);

    const generationRecord = createGenerationRecord(generationId);
    const { writer: initialWriter, stopKeepalive } = createResumableWriter(createChatCompactStreamWriter(response), generationRecord);
    let writer = initialWriter;
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
            flushContentBuffer();
            writer.write(encodeReasoningFrame(reasoningText));
        }

        addContent(extractText(json));
    }

    const onSocketClose = () => {
        // Client dropped - keep buffering the still-in-flight upstream generation for a possible
        // resume (see llamacpp-compact-stream.js's module doc comment) instead of tearing it down;
        // the persist-and-end logic below still runs once fetchResponse.body ends on its own.
        stopKeepalive();
        writer = detachFromResponse(generationRecord);
    };
    response.socket?.once('close', onSocketClose);

    await new Promise((resolve) => {
        fetchResponse.body.on('data', (chunk) => {
            sseBuffer += chunk.toString('utf-8');
            let idx;
            while ((idx = sseBuffer.indexOf('\n')) !== -1) {
                const rawLine = sseBuffer.slice(0, idx);
                sseBuffer = sseBuffer.slice(idx + 1);

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
        if (persisted) {
            writer.write(encodeAssistantNodeIdFrame(persisted.node_id));
        }
    }

    response.socket?.off('close', onSocketClose);
    writer.end();
}

/**
 * Faithful, server-side port of `ToolManager.#applyToolCallDelta()` (public/scripts/tool-calling.js) -
 * the exact algorithm the CLIENT already uses to accumulate one OpenAI-Chat-Completions-shaped
 * `choices[0].delta.tool_calls[N]` fragment across many SSE chunks into a complete tool call. Ported
 * (not reinvented) so the server reproduces the real, verified-against-real-backends behavior:
 * `id`/`name`/`type` are sent whole on (typically) the FIRST chunk for a given tool call and must
 * never be re-concatenated on subsequent chunks (some backends resend them unchanged on every chunk -
 * blindly concatenating would duplicate the value); `function.arguments` is the one field that
 * genuinely arrives as successive partial-JSON string fragments and must be concatenated in order,
 * including mid-token splits. Recurses into nested plain-object deltas (`function: {...}`) exactly like
 * the original.
 * @param {object} target The accumulator object for one tool call (mutated in place).
 * @param {object} delta One chunk's own delta fragment for this same tool call index.
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
 * Streaming counterpart of `runServerToolRounds()`'s non-streaming entry point, for the raw-action
 * `/generate` route's shared default/legacy OpenAI-Chat-Completions-shaped dispatch block ONLY - the
 * one place chunk (b)/(c) wired tool execution into (see that function's own doc comment for the full
 * scope note: the ~12 provider-`switch` functions above are unaffected, unchanged, and still use the
 * plain `forwardAndPersistCompactStream()`).
 *
 * ONLY ever called when `pendingServerToolLoop` is set (this request advertised at least one
 * server-native or client-advertised tool - identical gate to the non-streaming call site, which also
 * guarantees `persist`/`pendingAssistantPersist` is set - see its own declaration comment). A request
 * with no tools registered never reaches this function at all - it keeps using the untouched
 * `forwardAndPersistCompactStream()`, so its behavior is 100% unaffected by this function's existence.
 *
 * Emits the same compact binary wire format (`./llamacpp-compact-stream.js`, `X-ST-Stream-Format:
 * compact-v1`) as every other raw-action streaming path, instead of the old hand-reconstructed
 * SSE-JSON this function used to write directly (see `git log -- <this file>` for that version):
 * 1. Tees the first round's SSE stream, accumulating BOTH the real `choices[0].delta.content` text
 *    AND `choices[0].delta.tool_calls[]` (via `applyServerToolCallDelta()` above, index-keyed exactly
 *    like the client's own accumulator) - needed either way, to know whether a tool was called and to
 *    reconstruct the round for `runServerToolRounds()` below.
 * 2. Real content deltas are forwarded to the client LIVE, chunk-by-chunk, as `encodeContent()` frames
 *    - no buffering, no added latency - preserving real-time streaming UX for the overwhelmingly
 *    common case (a normal reply, tool-enabled or not, that doesn't end up calling a tool this turn).
 * 3. Tool-call deltas ARE forwarded, as `encodeToolCallDeltaFrame()` (`0x05`) frames, one per delta -
 *    unlike the old SSE-JSON version, which had to suppress them entirely to avoid double-processing
 *    by the client's generic SSE-JSON `ToolManager.parseToolCalls()`/legacy tool-calling path. Neither
 *    of those runs against a compact-v1 stream (chat-completion-settings.js branches on the response
 *    header before choosing a consumer at all), so there is no such hazard here - a dedicated compact-
 *    stream consumer accumulates `0x05` deltas the same way, and is solely responsible for them.
 * 4. Once the first round's stream ends, if no tool calls were accumulated: behaves exactly like
 *    `forwardAndPersistCompactStream()` (persist the accumulated text, if any, write the
 *    `assistant_node_id` frame, and close the stream) - this is the common case for any tool-enabled
 *    conversation where the model didn't call a tool THIS turn.
 * 5. If tool calls WERE accumulated, reconstructs the exact `{choices: [{message: {content,
 *    tool_calls}}]}` shape `runServerToolRounds()` already consumes for a non-streaming round, and runs
 *    that SAME function - reused entirely unchanged, not duplicated - which executes server-native
 *    tools, persists the round, and (per the existing, already-shipped precedent that every round AFTER
 *    the first always re-calls the backend non-streamingly regardless of the original request's own
 *    `stream` flag - see `runServerToolRounds()`'s own `refetch` calls) re-resolves and re-calls the
 *    backend for as many further rounds as needed, bounded by the same `SERVER_TOOL_ROUND_LIMIT`.
 * 6. Once `runServerToolRounds()` settles, the stream is completed by writing ONE final control
 *    (`0x08`) frame, then ending the response (there is no `[DONE]` sentinel to hold back in the
 *    compact protocol - the natural end of the byte stream IS the end signal):
 *    - `ok: 'pending'` (chunk (c) client-only hand-off): `{tool_call_handoff: {node_id,
 *      pending_tool_calls}}` - the client's streaming generator (`sendOpenAIRequest()` in
 *      chat-completion-settings.js) stashes it on `state.toolCallHandoff`, and the end-of-stream
 *      handler (public/script.js, `isStreamFinished` block) recognizes it and hands off to the SAME
 *      `resolveClientToolHandoffLoop()` chunk (c) already shipped for the non-streaming case,
 *      completely unchanged - the tree node addressed by `node_id` was ALREADY persisted server-side
 *      by `runServerToolRounds()` before this frame is even written, so there is nothing left for the
 *      client to persist, only to resolve.
 *    - `ok: false` (a real error mid-loop, e.g. round limit exceeded or an unrecognized tool name):
 *      `{error: {message}}` - the best available error-surfacing mechanism once the stream is already
 *      committed (the HTTP status code itself can no longer change).
 *    - `ok === 'aborted'` (an all-stealth round - matching legacy's `shouldStopGeneration` branch,
 *      "generation stops, nothing new appears"): `{tool_call_aborted: true}` - the client's streaming
 *      generator stashes it on `state.toolCallAborted` the same way, and `finishGenerating()`
 *      recognizes it to unblock generation cleanly with no persisted reply. Any real narrative text
 *      generated in the SAME round as the stealth call is also not forwarded/persisted (see
 *      `runServerToolRounds()`'s own step 2b doc comment for why this narrower behavior was chosen).
 *    - `ok: true` (a final plain-text reply was reached, possibly after several further non-streaming
 *      rounds): the final text is sent as an ordinary `encodeContent()` frame (no client-side
 *      special-casing needed for this branch at all), persisted via the shared
 *      `persistAssistantReply()` anchored at `roundResult.leafNodeId` (mirroring the non-streaming call
 *      site's own `pendingAssistantPersist.anchorNodeId = roundResult.leafNodeId` reassignment), and
 *      its node id sent as the final `encodeAssistantNodeIdFrame()` frame before `response.end()`.
 * @param {import('node-fetch').Response} fetchResponse The first round's upstream fetch response.
 * @param {import('express').Response} response The client-facing Express response.
 * @param {object} persist `pendingAssistantPersist` - always truthy whenever this function is called
 * (same gate as `pendingServerToolLoop`, see the route handler).
 * @param {object} pendingServerToolLoop The route handler's own `pendingServerToolLoop` object
 * (`{directories, ownerId, characterAvatar, groupId, enabledTools, clientToolNames, clientToolSchemas}`).
 * @param {(messages: object[]) => Promise<import('node-fetch').Response>} refetch Re-issues the backend
 * request with a freshly-resolved `messages` array - forwarded straight through to `runServerToolRounds()`.
 * @returns {Promise<void>}
 */
async function forwardAndPersistCompactStreamWithServerTools(fetchResponse, response, persist, pendingServerToolLoop, refetch) {
    if (!fetchResponse.ok || !fetchResponse.body) {
        return forwardFetchResponse(fetchResponse, response);
    }

    response.statusCode = fetchResponse.status;
    response.statusMessage = fetchResponse.statusText;
    response.setHeader('X-ST-Stream-Format', 'compact-v1');
    const generationId = randomUUID();
    response.setHeader('X-Generation-Id', generationId);

    const { writer } = createResumableWriter(createChatCompactStreamWriter(response), createGenerationRecord(generationId));

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
            // Unlike the old SSE-JSON version, there is no "forward the raw line" fallback for a
            // non-`data:` line (an SSE comment, a keep-alive, a blank separator) or a parse failure -
            // the compact protocol has no concept of forwarding opaque upstream bytes, only real
            // content/frame events, matching forwardAndPersistCompactStream()'s own established
            // "drop and warn" precedent for the exact same situation.
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
    if (toolCalls.length === 0) {
        // No tool calls this round - see this function's own doc comment, step 4.
        if (text) {
            const persisted = await persistAssistantReply(persist, text);
            if (persisted) writer.write(encodeAssistantNodeIdFrame(persisted.node_id));
        }
        writer.end();
        return;
    }

    // See this function's own doc comment, step 5 - reuse runServerToolRounds() wholesale.
    const initialJson = { choices: [{ message: { role: 'assistant', content: text || null, tool_calls: toolCalls } }] };
    const roundResult = await runServerToolRounds({
        ...pendingServerToolLoop,
        leafNodeId: persist.anchorNodeId,
        isSwipe: persist.isSwipe,
        initialJson,
        refetch,
    });

    // See this function's own doc comment, step 6.
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

    // See runServerToolRounds()'s own doc comment and the non-streaming call site's identical
    // comment above: once any round has run (guaranteed here - this function is only reached when
    // the first round's own accumulated deltas included tool_calls), isSwipe/isContinue are
    // downgraded to a plain append onto roundResult.leafNodeId - the sibling-alternative slot (swipe)
    // was already claimed at round 0, and continue's edit-in-place has no meaningful target once a
    // real tool-call node exists on the tree.
    persist.anchorNodeId = roundResult.leafNodeId;
    persist.isSwipe = false;
    persist.isContinue = false;
    if (finalText) {
        const persisted = await persistAssistantReply(persist, finalText);
        if (persisted) writer.write(encodeAssistantNodeIdFrame(persisted.node_id));
    }
    writer.end();
}

/**
 * Parses one tool call's `function.arguments` string into a plain object, the same "usually JSON,
 * but an empty string is not valid JSON" tolerance `ToolManager.#parseParameters()`
 * (public/scripts/tool-calling.js) already applies client-side. Any other JSON-parse failure (a
 * genuinely malformed arguments string from a misbehaving backend) also falls back to `{}` rather
 * than throwing - this is untrusted backend output, not a programming error, so a tool invoked with
 * an empty-object fallback (and possibly failing on its own missing-argument validation, which then
 * flows back to the model as a normal tool-error result - see `runServerToolRounds()` below) is the
 * right degradation, not a crashed request.
 * @param {unknown} rawArguments `toolCall.function.arguments`, as sent by the backend.
 * @returns {object} The parsed arguments, or `{}` on any failure/empty input.
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
 * Runs the server-native tool-calling loop for the raw-action `/generate` route's non-streaming
 * default/legacy chat-completion dispatch path (the ONLY response-handling code path this chunk
 * wires tool execution into - see the `/generate` route handler's own comment on
 * `pendingAssistantPersist`/`SERVER_TOOL_ROUND_LIMIT` for the full list of what's explicitly NOT
 * covered: streaming, and every one of the 12 provider-`switch` functions above).
 *
 * Only ever invoked when the initial backend response already carries `tool_calls` AND at least one
 * server-native OR client-advertised tool was in play for this raw-action request - the caller is
 * expected to skip calling this entirely otherwise, so a request with neither ever reaches this
 * function (byte-for-byte the same behavior as before chunk (b) landed).
 *
 * Each round:
 * 1. Reads `json.choices[0].message.tool_calls`. Empty/undefined -> done, return the final
 *    plain-text `json` as-is (the caller persists it via the existing `persistAssistantReply()` path,
 *    completely unchanged).
 * 2. Otherwise, partitions the calls into three buckets by `function.name`: SERVER (in `enabledTools`,
 *    case-sensitive exact match against the SAME list this request already advertised - a tool that
 *    was enabled when the request was built but raced to disabled mid-request is not re-checked here,
 *    matching this route's general "resolve settings once per request" convention elsewhere),
 *    CLIENT-ONLY (in `clientToolNames`, chunk (c) - a name the client itself advertised via
 *    `client_tools` but that has no server-native registration), and UNKNOWN (neither). If ANY call is
 *    UNKNOWN, the WHOLE round fails immediately with a real, sane 422 - explicitly NOT executing the
 *    recognized calls from that same round first. This is unchanged from chunk (b)'s own judgment call
 *    (a response mixing a real tool with an unrecognized name is far more likely to be a
 *    hallucinated/mistargeted call than a legitimate multi-tool turn, and partially
 *    executing+persisting only some of a model-issued "batch" would leave a confusing,
 *    semantically-broken turn on the tree) - chunk (c) only widens what counts as "recognized" to
 *    include the client's own advertised names, it does not relax this all-or-nothing rule.
 * 2b. STEALTH-TOOL PARITY (this task). Legacy semantics, precisely verified by reading
 *     `ToolManager.invokeFunctionTools()`/`finishGenerating()`'s `onSuccess()` in full
 *     (public/script.js, public/scripts/tool-calling.js) rather than assumed from the older doc
 *     comment this fixes (`resolveClientToolHandoffLoop()`'s "KNOWN LIMITATION" note, which describes
 *     only the ALL-stealth case): `shouldStopGeneration = (!invocationResult.invocations.length &&
 *     shouldDeleteMessage) || invocationResult.stealthCalls.length` - the `||` means ANY stealth call
 *     present in a round stops generation entirely, UNCONDITIONALLY, even when the SAME round also has
 *     real non-stealth calls that were already invoked and succeeded - `saveFunctionToolInvocations()`
 *     is never reached for that round, so even a successful non-stealth invocation's result is
 *     silently discarded, not partially handed off. This is NOT "abort only if every call is stealth" -
 *     it is "abort if at least one call is stealth", full stop. That is the precise rule this function
 *     replicates below: if ANY call in this round's tool_calls has a `function.name` in
 *     `stealthToolNames` (a client-only tool name the client itself marked stealth - stealth is a
 *     per-TOOL registration property, `ToolManager.registerFunctionTool()`'s own `stealth` param -
 *     never per-call), the WHOLE round returns `{ok: 'aborted'}` - see this function's own return-type
 *     doc below - and nothing in this function's steps 3/4/5 below ever runs for that round: no tool
 *     (server-native OR client-only) is invoked, no tree node is persisted, no hand-off is returned.
 *     JUDGMENT CALL, explicitly narrower than legacy where legacy has no equivalent at all: legacy's
 *     literal mechanics execute every non-stealth call first (real side effects happen) and only THEN
 *     discard the round: this function instead never invokes anything once a stealth name is detected,
 *     rather than running a real server-native tool's `invoke()` (a genuine side-effecting operation,
 *     unlike a discarded chat-UI toast) purely to throw its result away - the user-visible outcome is
 *     identical ("nothing new appears, generation stops"), which is the property that actually matters
 *     for parity; only the "does a side-effecting call still fire" question is a deliberate, documented
 *     divergence for the one case (stealth mixed with a server-native call) legacy has no precedent for
 *     at all (legacy never had server-native tools). A stealth call mixed only with OTHER client-only
 *     calls (stealth or not) is exact, verified parity, not a narrowing.
 * 3. For every SERVER call, parses `function.arguments` (`parseServerToolArguments()` above) and calls
 *    `tool.invoke(args, ctx)`. A thrown/rejected `invoke()` does NOT abort the round or the request -
 *    it is caught and turned into a normal (if `error`-flagged) invocation result, so the model sees
 *    the failure text and can retry/apologize/call something else, exactly matching
 *    `ToolManager.invokeFunctionTools()`'s own "still create an invocation so the model sees the
 *    failure, keep looping" behavior (public/scripts/tool-calling.js). Every CLIENT-ONLY call instead
 *    becomes an IN-FLIGHT invocation - `{id, name, parameters, result: null, error: null}` - `result`
 *    stays `null` until the client's own `type: 'tool_result'` follow-up request resolves it (see
 *    `resolvePendingToolResults()` below); no server tool's own `invoke()` result is ever `null` (it is
 *    always coerced to a string), so `result === null` unambiguously means "still pending" wherever
 *    this shape is read back (`resolvePendingToolResults()`, `populateChatHistory()`'s
 *    `invocation.result || '[No content]'` fallback for the rare case a still-pending node is ever
 *    read as history mid-flight).
 * 4. Persists the WHOLE round (server results and client-pending calls together) as ONE new tree node
 *    via `appendMessages()`, shaped `{is_system: true, is_user: false, extra: {tool_invocations:
 *    [...]}}` - the exact shape `populateChatHistory()` (src/chat-completion-history.js) and
 *    `buildChatCompletionMessages()` (src/chat-completion-messages.js) already expect for replay,
 *    mirroring the client's own `ToolManager.saveFunctionToolInvocations()`. SINGLE-NODE JUDGMENT CALL
 *    (this task): a mixed round (some server, some client-only calls) is persisted as ONE node with a
 *    mixed `tool_invocations` array (some entries resolved, some `result: null`) rather than two
 *    separate nodes. Reasoning: one backend response is one real, atomic model turn ("the model made
 *    these N tool calls together, in one message") - splitting it into two tree nodes would fragment
 *    that single turn into two history entries with no natural ordering between them (both would need
 *    to attach at the same parent, becoming siblings/an ambiguous fork, not a sequence), and every
 *    existing reader of this shape (`populateChatHistory()`, `runServerToolRounds()` itself on its next
 *    round, `resolvePendingToolResults()`) already expects "one round = one node" - a single node with
 *    some entries still pending is a strictly smaller extension of that existing contract (just widen
 *    every reader to tolerate `result === null`) versus teaching every reader a new
 *    two-nodes-per-round shape and a new ordering rule.
 * 5. If any CLIENT-ONLY calls were in this round, STOPS here (does not advance/refetch) and returns
 *    `{ok: 'pending', pendingToolCalls: [...], leafNodeId}` - one entry per client-only call, each
 *    `{node_id: currentLeafId, tool_call_id, name, arguments}` (arguments as a parsed object, not a
 *    JSON string, matching the wire example in this task's design doc) - so the caller (the route
 *    handler) can hand this off to the client instead of trying to resolve it itself. Otherwise
 *    (SERVER-only round), advances the "current leaf" to the just-appended node, re-resolves the FULL
 *    prompt fresh via `buildRawActionChatCompletionRequest()` (so the newly-persisted tool turn is
 *    included exactly the way any other real tree node would be - no manual message-array patching
 *    here, and `clientToolNames`/`clientToolSchemas` are forwarded again so a LATER round can still
 *    hand off to the client), and calls the backend again via the caller-supplied `refetch(messages)`.
 *
 * Bounded by `SERVER_TOOL_ROUND_LIMIT` rounds (a `pending` return does not consume this bound further -
 * it ends this function's own loop immediately; the CLIENT's own resumption is bounded separately, by
 * its own recursion limit on the `tool_result` follow-up chain - see public/script.js's
 * `resolveClientToolHandoffLoop()`). Exhausting the limit without ever reaching a plain-text reply (or
 * a pending hand-off) returns a real error too - the tool-call/result turns already persisted along the
 * way stay on the tree (they're real facts that happened), only the client-facing response reports
 * failure.
 *
 * FORMERLY-DOCUMENTED LIMITATION, NOW FIXED: `isSwipe`/`isContinue` interleaved with a server tool-call
 * round used to be unreconciled - `leafNodeId` always attached the first round's tool-call turn as a
 * plain CHILD of the pre-loop anchor (via `appendMessages()`), and the caller then reassigned
 * `persistAssistantReply()`'s own `anchorNodeId` to `roundResult.leafNodeId` (the tool turn's node) -
 * correct for the plain-append case, but wrong for `isSwipe`/`isContinue`, whose persistence modes treat
 * `anchorNodeId` as the node being REPLACED-BY-A-SIBLING/EDITED-IN-PLACE, not "appended after". Feeding
 * the tool-call node in as that anchor turned a swipe into "add a new child two levels under the ORIGINAL
 * anchor's parent" (nested one level too deep - a sibling of the tool turn, not of the original message)
 * and turned a continue into "overwrite the tool-call turn's own `tool_invocations` with concatenated
 * text at the wrong node" (destroying the tool-call record).
 *
 * Fix, verified against `addAlternatives()`/`appendMessages()`'s real tree-mutation semantics
 * (message-tree-db.js): `isSwipe` now attaches ONLY the very first round's tool-call turn as a REAL
 * SIBLING of the pre-loop anchor (`addAlternatives()` + `selectDefaultChild()` instead of
 * `appendMessages()`) - the sibling-alternative slot a swipe is supposed to occupy is claimed by the
 * FIRST real thing that happened during this swipe attempt (a tool call), preserving true event order;
 * everything after round 0 (further rounds, and the caller's own final-reply append) chains onward from
 * there via ordinary `appendMessages()`, exactly like the plain-append case, since by round 1 the sibling
 * slot is already spoken for. The caller (the route handler, both streaming and non-streaming) then
 * downgrades its own `isSwipe`/`isContinue` flags to `false` before calling `persistAssistantReply()` for
 * the FINAL reply, once any round has actually run - `roundResult.leafNodeId` at that point already sits
 * exactly where a plain append belongs (a descendant of the just-claimed sibling for swipe; a descendant
 * of the unmoved, unedited original anchor for continue, which never needed the sibling-claim step since
 * continue has no sibling concept - editing text in place across a genuine tool-call boundary isn't
 * meaningful once a real intervening tree node exists, so continue-with-a-tool-call degrades to "the
 * continuation text lands as its own new node after the tool call", not a merged edit).
 * @param {object} params
 * @param {import('../../users.js').UserDirectoryList} params.directories
 * @param {string} params.ownerId
 * @param {string} [params.characterAvatar]
 * @param {string} [params.groupId]
 * @param {import('../../server-tools.js').ServerToolRegistration[]} params.enabledTools The exact
 *   list this request already advertised to the backend (`buildRawActionChatCompletionRequest()`'s
 *   own `enabledServerTools` return value).
 * @param {Set<string>} params.clientToolNames Chunk (c): the exact set this request already advertised
 *   to the backend as client-only tools (`buildRawActionChatCompletionRequest()`'s own
 *   `enabledClientToolNames` return value).
 * @param {any[]} [params.clientToolSchemas] The SAME raw `client_tools` array the request carried -
 *   forwarded to each re-resolution's own `buildRawActionChatCompletionRequest()` call so a later
 *   round can still detect/hand-off a further client-only call, exactly mirroring how `enabledTools`
 *   is re-derived fresh from the registry every round rather than assumed static.
 * @param {Set<string>} [params.stealthToolNames] THIS TASK (stealth-tool parity) - see this function's
 *   own doc comment, step 2b. `buildRawActionChatCompletionRequest()`'s own
 *   `enabledStealthClientToolNames` return value: the subset of `clientToolNames` the client itself
 *   marked stealth. Defaults to an empty set (no stealth tools in play) so every pre-existing caller
 *   that doesn't pass this is completely unaffected.
 * @param {string} params.leafNodeId The tree node the first tool-call round (if any) should attach
 *   after - the assistant-reply anchor already resolved for this request.
 * @param {boolean} [params.isSwipe] See this function's own doc comment above - when true, round 0's
 *   tool-call turn claims the sibling-alternative slot (`addAlternatives()`+`selectDefaultChild()`)
 *   instead of being appended as a child of `leafNodeId`. Every later round appends normally.
 * @param {any} params.initialJson The backend's first response body (already parsed JSON).
 * @param {(messages: object[]) => Promise<import('node-fetch').Response>} params.refetch Re-issues
 *   the backend request with a freshly-resolved `messages` array, everything else unchanged.
 * @returns {Promise<
 *   {ok: true, json: any, leafNodeId: string} |
 *   {ok: false, status: number, message: string} |
 *   {ok: 'pending', pendingToolCalls: {node_id: string, tool_call_id: string, name: string, arguments: object}[], leafNodeId: string} |
 *   {ok: 'aborted', leafNodeId: string}
 * >} `ok: 'aborted'` (this task) - see step 2b above: a stealth client-only call was present in this
 * round. Nothing was invoked or persisted for the round that triggered this - `leafNodeId` is simply
 * whatever it already was BEFORE this round (unchanged), returned only so a caller that logs/asserts
 * on it has something real, never a node this round itself created.
 */
async function runServerToolRounds({ directories, ownerId, characterAvatar, groupId, enabledTools, clientToolNames, clientToolSchemas, stealthToolNames = new Set(), leafNodeId, isSwipe = false, initialJson, refetch }) {
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

        // THIS TASK (stealth-tool parity) - see this function's own doc comment, step 2b, for the full
        // legacy-verification and the deliberate "abort before invoking anything" narrowing versus
        // legacy's own "invoke everything, then discard" mechanics. Checked AFTER the unknown-name 422
        // above (a hallucinated name alongside a stealth call is still treated as the hallucination
        // error, not silently swallowed by an abort) and BEFORE any invocation below.
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
                // Client-only (chunk (c)) - see this function's own doc comment, steps 3/5. Left
                // unresolved (`result: null`) until the client's `type: 'tool_result'` follow-up.
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

        // Round 0 of an `isSwipe` request claims the sibling-alternative slot itself (see this
        // function's own doc comment above) - the tool call is the first real thing that happened
        // during this swipe attempt, so IT becomes the new alternative alongside the message being
        // swiped, not a child buried one level under it. Every later round (round > 0) has no sibling
        // slot left to claim - the slot was already taken by round 0's own tool turn - so it just
        // chains on as an ordinary child, identical to the plain-append case.
        const claimsSiblingSlot = round === 0 && isSwipe;
        const appendResult = claimsSiblingSlot
            ? await addAlternatives(directories, ownerId, currentLeafId, [toolTurnContent])
            : await appendMessages(directories, ownerId, currentLeafId, [toolTurnContent]);
        if (!appendResult.ok || !appendResult.node_ids?.length) {
            console.error('Failed to persist tool invocation turn onto the tree:', appendResult.reason);
            return { ok: false, status: 500, message: 'Failed to persist the tool invocation results onto the chat.' };
        }
        currentLeafId = appendResult.node_ids[appendResult.node_ids.length - 1];
        if (claimsSiblingSlot) {
            const selected = await selectDefaultChild(directories, currentLeafId);
            if (!selected) {
                console.error('Failed to select the new tool-call sibling alternative as current (swipe interleaved with a server tool call).');
            }
        }

        if (pendingToolCalls.length > 0) {
            // See this function's own doc comment, step 5 - stop here, hand off to the client. The
            // `node_id` on each pending entry is the freshly-resolved `currentLeafId` (fixed up below
            // since it was computed above using the PRE-append `currentLeafId`).
            return {
                ok: 'pending',
                pendingToolCalls: pendingToolCalls.map(call => ({ ...call, node_id: currentLeafId })),
                leafNodeId: currentLeafId,
            };
        }

        // Re-resolve the FULL prompt fresh from the tree (never hand-patch the previous messages
        // array) - see this function's own doc comment, step 5. `type: 'normal'`/no new user
        // message/no continue-or-swipe: a follow-up round never introduces a new user turn and
        // continue/swipe only ever apply to the FIRST round's own final reply (see the route
        // handler's own comment on `pendingAssistantPersist.anchorNodeId` for that interaction).
        // `clientToolSchemas` is forwarded again so a LATER round can still detect/hand off a further
        // client-only call (see this function's own `clientToolSchemas` param doc comment).
        const rebuilt = await buildRawActionChatCompletionRequest(directories, {
            characterAvatar, groupId, ownerId, nodeId: currentLeafId, type: 'normal', clientToolSchemas,
        });

        const fetchResponse = await refetch(rebuilt.params.messages);
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
 * Chunk (c), wire step 3: resolves a client's `type: 'tool_result'` follow-up request - the client
 * submitting the result(s) of the tool call(s) `runServerToolRounds()` (above) had to hand off to it
 * via `pending_tool_calls`, addressing the exact tree node that hand-off already persisted.
 *
 * Reuses the SAME `node_id`-required addressing model as every other raw-action request on this route
 * (`buildRawActionChatCompletionRequest()`'s own ADDRESSING MODEL doc comment) - `nodeId` here is
 * resolved via `getAncestorPath()`, the identical helper this file already uses to verify a given
 * `node_id` (see that function's Step 2) - NOT `loadAtNode()` (which descends to the branch's current
 * LEAF, the wrong node whenever a later message already exists under this one; `getAncestorPath()`
 * resolves the exact node addressed, no more, no less, matching the read this route already performs
 * for every non-`tool_result` raw-action request).
 *
 * Persistence is an IN-PLACE EDIT via `editMessage()` (src/message-tree-db.js), NOT a new appended
 * node - identical pattern to `persistAssistantReply()`'s own `isContinue` branch
 * (../../assistant-reply-persist.js): `editMessage()` replaces the WHOLE stored content object, so the
 * full, current node content (read back via `getAncestorPath()`'s own last entry - the same technique
 * `buildRawActionChatCompletionRequest()` already uses to read `anchorContent`) is spread and only
 * `extra.tool_invocations` is touched, exactly mirroring `{...anchorContent, mes: oldText +
 * generatedText}` there.
 *
 * Only the invocations still `result === null` (chunk (b)/(c)'s "in-flight" marker - see
 * `runServerToolRounds()`'s own doc comment, step 3) are eligible to be filled in; an already-resolved
 * invocation's `id` appearing again in `toolResults` is left untouched (a resubmission is not treated
 * as a correction). ALL still-pending invocations on the node must be resolved by this one call - a
 * partial submission (leaving some `result === null`) is refused with a 400 rather than silently
 * resuming the tool-calling loop with a node that still has an unresolved invocation on it (which
 * would either crash or silently mis-serialize once replayed into the backend's own tool-result
 * message format, see `chat-completion-history.js`'s own `invocation.result || '[No content]'`
 * fallback - a real but confusing degradation this function chooses to refuse up front instead).
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {string} ownerId
 * @param {string} nodeId The pending tool-call node's own id (the `node_id` the client received on
 *   each `pending_tool_calls` entry for this round).
 * @param {any[]} toolResults Client-supplied `[{id, result, error}, ...]` - `id` is the tool call id
 *   (`pending_tool_calls[].tool_call_id`), `result` is coerced to a string, `error` to a boolean.
 * @returns {Promise<{ok: true}|{ok: false, status: number, message: string}>}
 */
async function resolvePendingToolResults(directories, ownerId, nodeId, toolResults) {
    const ancestorPath = await getAncestorPath(directories, nodeId);
    if (!ancestorPath || ancestorPath.length === 0) {
        return { ok: false, status: 400, message: `Chat node not found: ${nodeId}` };
    }
    const nodeContent = ancestorPath[ancestorPath.length - 1];
    if (!nodeContent || nodeContent.node_id !== nodeId) {
        return { ok: false, status: 400, message: `Chat node not found: ${nodeId}` };
    }

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
            // Unknown id, or an already-resolved invocation being resubmitted - see this function's
            // own doc comment for why a resubmission is silently ignored rather than re-applied.
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

    const editResult = await editMessage(directories, ownerId, nodeId, { ...nodeContent, extra: { ...nodeContent.extra, tool_invocations: invocations } });
    if (!editResult.ok) {
        console.error('Failed to persist tool_result onto the tree:', editResult.reason);
        return { ok: false, status: 500, message: 'Failed to persist the submitted tool result onto the chat.' };
    }
    return { ok: true };
}

router.post('/generate', async function (request, response) {
    // Set only by the raw-action branch below (and only for a type/mode where the reply is actually
    // meant to be persisted - see that branch's own comment for the `is_impersonate`/`type ===
    // 'quiet'` exclusion). Read by BOTH the streaming and non-streaming response points inside the
    // single shared default/legacy inline OpenAI/custom/other-source dispatch block further down
    // (the ONLY response-handling code in this file with one shared point across every source it
    // covers). Every other branch (connection-profile, default/legacy without a raw action) never
    // sets this, so it stays a no-op for them - the byte stream those requests receive is completely
    // unaffected by any of this.
    //
    // Streaming persistence status, precisely:
    // - The shared default/legacy inline dispatch block (search `forwardAndPersistCompactStream` below):
    //   PERSISTS FOR REAL, for both streaming and non-streaming. This block always builds a real
    //   OpenAI-Chat-Completions-shaped request (`/chat/completions`, `messages: [...]`) for every
    //   raw-action call (re-verified: the raw-action branch below always produces real chat
    //   messages, never a plain string prompt, so `isTextCompletion` - see that block's own
    //   derivation - is never true for a raw-action request) - its streamed SSE chunks are therefore
    //   genuinely OpenAI-chat-completions-delta-shaped (`data: {"choices":[{"delta":{"content":
    //   "..."}}]}`), and `forwardAndPersistCompactStream()` tees the untouched byte pipe to accumulate
    //   `choices[0].delta.content` per chunk, persisting the full text via the shared
    //   `persistAssistantReply()` (../../assistant-reply-persist.js) once the stream ends.
    // - ALL 12 provider-`switch` functions dispatched below (sendClaudeRequest/sendMakerSuiteRequest
    //   (also used for VERTEXAI)/sendAI21Request/sendMistralAIRequest/sendCohereRequest/
    //   sendDeepSeekRequest/sendAimlapiRequest/sendXaiRequest/sendChutesRequest/sendMinimaxRequest/
    //   sendElectronHubRequest/sendAzureOpenAIRequest - each taking `pendingAssistantPersist` as an
    //   explicit third parameter, passed at their call sites below): PERSIST FOR REAL, for both
    //   streaming and non-streaming, each per its OWN verified response/stream shape:
    //   - sendClaudeRequest: non-streaming extracts every real `type: 'text'` block from the Messages
    //     API's `content` array (never a `type: 'thinking'`/`type: 'tool_use'` block); streaming tees
    //     via `forwardAndPersistCompactStream()`, accumulating only `content_block_delta` events whose own
    //     `delta.type === 'text_delta'` (ignoring `thinking_delta`/`input_json_delta`/other event
    //     types).
    //   - sendMakerSuiteRequest: both modes reuse the exact same `!part.thought` filter over
    //     `candidates[0].content.parts` this function already applied for its own non-streaming
    //     client response, excluding Gemini's own "thought"/reasoning parts.
    //   - sendAI21Request/sendMistralAIRequest/sendDeepSeekRequest/sendAimlapiRequest/sendXaiRequest/
    //     sendChutesRequest/sendMinimaxRequest/sendElectronHubRequest/sendAzureOpenAIRequest: standard,
    //     verified OpenAI-Chat-Completions-shaped bodies (`choices[0].message.content` non-streaming,
    //     `choices[0].delta.content` per SSE chunk while streaming; sendAzureOpenAIRequest's
    //     deployment-based URL/auth scheme only affects where/how the request is sent, never this
    //     shape) - sendDeepSeekRequest additionally never reads DeepSeek reasoner models' separate
    //     `reasoning_content` field (only `content`/`delta.content`), so reasoning output is never
    //     mistaken for the reply; sendChutesRequest/sendMinimaxRequest/sendElectronHubRequest/
    //     sendAzureOpenAIRequest were each individually checked for any comparable
    //     reasoning/thinking-adjacent response field and found to read/expose none, so plain
    //     `content`/`delta.content` is the whole reply for all four.
    //   - sendCohereRequest: Cohere's real (non-OpenAI-shaped) v2 chat API - non-streaming extracts
    //     every real `type: 'text'` block from `message.content` (falling back to `message.tool_plan`
    //     only for a tool-call-only reply with no real text content, mirroring the existing client-side
    //     `extractMessageFromData()` in public/script.js); streaming tees via
    //     `forwardAndPersistCompactStream()`, accumulating `content-delta`/`tool-plan-delta` events' own
    //     `delta.message.content.text` field, the same event types/field public/scripts/sse-stream.js's
    //     own `parseStreamData()` already treats as real reply-text chunks.
    //
    // This completes the raw-action persistence cutover for this file: every response-handling code
    // path in this route - the shared default/legacy dispatch block AND all 12 provider-`switch`
    // functions, for both streaming and non-streaming - now persists the assistant's real reply text
    // when `pendingAssistantPersist` is set, with no remaining exclusions.
    let pendingAssistantPersist = null;

    // Set only by the raw-action branch below, and only when it advertised at least one
    // server-native tool (`built.enabledServerTools` non-empty - see `server-tools.js`'s chunk (a)
    // registry and `buildRawActionChatCompletionRequest()`'s own `toolsPayload` doc comment). Read
    // ONLY by the shared default/legacy non-streaming dispatch block below (search
    // `runServerToolRounds` further down) - streaming and all 12 provider-`switch` functions are
    // explicitly OUT OF SCOPE for server-native tool execution in this chunk, so this stays `null`
    // (a no-op) for every other path, identical to today's behavior. `characterAvatar`/`groupId` are
    // carried alongside `directories`/`ownerId` (already on `pendingAssistantPersist`) because
    // `runServerToolRounds()` needs the full `ctx` tuple `getEnabledServerTools()`/`tool.invoke()`
    // expect, and because each round re-resolves the prompt via a fresh
    // `buildRawActionChatCompletionRequest()` call, which requires them too.
    let pendingServerToolLoop = null;

    try {
        if (!request.body) return response.status(400).send({ error: true });

        // "Generate using connection profile X" - the raw action is the profile id plus the raw
        // messages/generation-type facts; the server resolves the profile's source, preset, secret,
        // and proxy itself instead of the client pre-resolving and asserting them.
        if (request.body.connection_profile_id) {
            const { profile, selectedApiMap } = resolveConnectionProfile(request.user.directories, request.body.connection_profile_id);
            if (selectedApiMap.selected !== 'openai') {
                return response.status(400).send({ error: true, message: `Profile does not target a chat completion backend (targets: ${selectedApiMap.selected})` });
            }

            const { messages, max_tokens: maxTokens, type = 'quiet', name1 = '', name2 = '', stream: requestedStream } = request.body;
            if (!Array.isArray(messages)) {
                return response.status(400).send({ error: true, message: 'messages must be an array' });
            }

            const { 'oai_settings': baseSettings, proxies } = readSettingsAtPaths(request.user.directories, ['oai_settings', 'proxies']);
            const preset = profile.preset ? readPresetByName('openai', profile.preset, request.user.directories) : null;
            const settings = mergeChatCompletionPreset({ ...baseSettings, chat_completion_source: selectedApiMap.source }, preset);

            // Connection profile takes precedence over the preset/settings value for every
            // URL-style override field, matching the client's own "profile => preset => settings" order.
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
            const { generate_data } = await createGenerationParameters(settings, profile.model, type, messages, { macroContext: { name1, name2 }, biasPresetEntries });

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
        // "Generate for this character/group's chat" - the raw action is WHICH character/group,
        // WHICH branch/node in that conversation tree to generate from, and the LITERAL text the
        // user typed this turn (or nothing, for a continue/swipe) - the server resolves the user's
        // OWN currently active oai_settings, character, chat history, and full prompt assembly
        // entirely itself. See buildRawActionChatCompletionRequest() above for the full resolution
        // pipeline - the direct chat-completion analog of buildRawActionTextCompletionRequest() in
        // src/endpoints/backends/text-completions.js (commit ac42ce8c9). Field names deliberately
        // match that precedent's raw-action field names verbatim (character_avatar/group_id/
        // owner_id/node_id/type/is_impersonate/is_continue/is_swipe/user_message) - there is no
        // `branch_name` field (see buildRawActionChatCompletionRequest()'s own ADDRESSING MODEL doc
        // comment). `node_id` is destructured straight off the parsed body, not defaulted, so the
        // "key absent" (`undefined`) vs. "explicit null" distinction survives intact - see that same
        // doc comment for why the two must stay distinguishable.
        } else if (request.body.owner_id && (request.body.character_avatar || request.body.group_id)) {
            const {
                character_avatar: characterAvatar, group_id: groupId, owner_id: ownerId,
                node_id: nodeId, type = 'normal',
                user_message: userMessageText,
                // Chunk (c): `client_tools` (the client's own advertised `ToolManager` tools, see
                // `buildRawActionChatCompletionRequest()`'s own `clientToolSchemas` doc comment) and
                // `tool_results` (only meaningful for `type === 'tool_result'`, see the `isToolResult`
                // branch below).
                client_tools: clientToolSchemas,
                // THIS TASK (stealth-tool parity): the subset of `client_tools` names the client
                // itself marked stealth (`ToolManager.isStealthTool()`) - see
                // `buildRawActionChatCompletionRequest()`'s own `stealthClientToolNames` doc comment.
                stealth_tool_names: stealthClientToolNames,
                tool_results: toolResults,
                // Structured/JSON-schema-constrained generation - see
                // `buildRawActionChatCompletionRequest()`'s own `jsonSchema` param doc comment for the
                // exact shape (identical to the legacy path's `request.body.json_schema` every provider
                // branch below already reads).
                json_schema: jsonSchema,
            } = request.body;
            // Server-validated (NOT trusted verbatim) - identical rationale/allowlist to
            // text-completions.js's own raw-action branch (see `sanitizeUserMessageExtra()`'s own doc
            // comment, message-tree-db.js). The client only ever forwards a REFERENCE to a file/media
            // attachment it already uploaded (public/scripts/chats.js's `populateFileAttachment()`),
            // never bytes.
            const userMessageExtra = sanitizeUserMessageExtra(request.body.user_message_extra);

            const directories = request.user.directories;

            // Chunk (c), wire step 3: `type: 'tool_result'` is NOT one of the "generation types" this
            // route otherwise dispatches on (normal/impersonate/continue/swipe/regenerate/quiet) - it
            // never adds a new user message, is never an impersonate/continue/swipe of anything, and
            // its OWN node_id already exists (it's the pending tool-call node the previous response
            // handed off - see `resolvePendingToolResults()` above). Resolve+persist the submitted
            // results FIRST (an in-place edit of that exact node, per `resolvePendingToolResults()`'s
            // own doc comment), THEN fall through into the exact same "resolve the full request fresh
            // from the tree and dispatch to the backend" code below, treated as a plain `type:
            // 'normal'` continuation from that now-fully-resolved node - reusing
            // `buildRawActionChatCompletionRequest()`/the dispatch/`runServerToolRounds()` machinery
            // wholesale instead of duplicating any of it.
            const isToolResult = type === 'tool_result';
            if (isToolResult) {
                if (typeof nodeId !== 'string' || !nodeId) {
                    return response.status(400).send({ error: true, message: 'node_id is required for type: "tool_result" (the pending tool-call node being resolved).' });
                }
                if (!Array.isArray(toolResults) || toolResults.length === 0) {
                    return response.status(400).send({ error: true, message: 'tool_results must be a non-empty array for type: "tool_result".' });
                }
                const resolved = await resolvePendingToolResults(directories, ownerId, nodeId, toolResults);
                if (!resolved.ok) {
                    return response.status(resolved.status).send({ error: true, message: resolved.message });
                }
            }

            // is_impersonate/is_continue/is_swipe are NOT read from the wire - see the identical
            // derivation and rationale in text-completions.js's own raw-action branch. Each is 100%
            // derivable from `type` alone; sending them as separate fields was a redundant classification
            // duplicating a fact already sent once. `type: 'tool_result'` is none of these (see above).
            const isImpersonate = type === 'impersonate';
            const isContinue = type === 'continue';
            const isSwipe = type === 'swipe' || type === 'regenerate';

            /** @type {Awaited<ReturnType<typeof buildRawActionChatCompletionRequest>>} */
            let built;
            try {
                built = await buildRawActionChatCompletionRequest(directories, {
                    characterAvatar, groupId, ownerId, nodeId,
                    // `type: 'normal'`/no new user message for the `tool_result` case - see the
                    // `isToolResult` comment above.
                    type: isToolResult ? 'normal' : type, isImpersonate, isContinue, isSwipe,
                    userMessageText: isToolResult ? undefined : userMessageText,
                    userMessageExtra: isToolResult ? undefined : userMessageExtra,
                    clientToolSchemas,
                    stealthClientToolNames,
                    jsonSchema,
                });
            } catch (error) {
                console.error('Failed to build raw-action chat completion request:', error);
                return response.status(400).send({ error: true, message: error?.message ?? 'Could not resolve this generation request' });
            }

            // Persist the NEW USER MESSAGE - "the user sent this" - BEFORE dispatching to the
            // backend. This is a real fact that should be committed regardless of whether generation
            // itself succeeds afterward, so it's done for real here, not deferred (identical
            // rationale to buildRawActionTextCompletionRequest()'s own route wiring).
            //
            // NEITHER side of this turn is persisted for `is_impersonate`/`type === 'quiet'`
            // (identical rationale/exclusion to text-completions.js's own route wiring):
            // - impersonate generates what the user MIGHT say - it is never a real submitted user
            //   message, and its output is written back into the client's send textarea, never the
            //   chat, so it must never appear as a bogus assistant message either.
            // - quiet generations are meta/background - they must never touch the visible tree on
            //   either side.
            // The user-message skip below is defensive: a real caller has no user text to send for
            // either of these types in practice, but even if `user_message` were passed alongside
            // `is_impersonate`/`type: 'quiet'`, it is not committed.
            //
            // The ASSISTANT's reply (for every other, non-skipped type) is persisted further down, at
            // the single shared streaming AND non-streaming response points in the default/legacy
            // inline dispatch block - see `pendingAssistantPersist`, set a few lines below, and that
            // variable's own declaration comment above for exactly which paths persist for real
            // (the shared block, both modes) versus which remain a documented, separately-scoped
            // exclusion (the ~12 provider-`switch` functions above, for EITHER mode).
            // The reply, once persisted, must chain onto whatever node is actually the new leaf after
            // this block - the just-appended user message's node when one was appended, otherwise
            // `built.anchorNodeId` unchanged (continue/swipe/regenerate, which add no new message - a
            // swipe/regenerate REPLACES the anchor with a sibling instead, see below).
            // `isToolResult` never has a new user message to append (see the `isToolResult` comment
            // above) - `built.anchorNodeId` for that case is just `nodeId` itself (the pending
            // tool-call node, already resolved+edited above), which is exactly the node the eventual
            // reply should attach after.
            const skipPersistence = isImpersonate || type === 'quiet';
            let replyAnchorNodeId = built.anchorNodeId;
            if (!isToolResult && !skipPersistence && typeof userMessageText === 'string' && built.anchorNodeId) {
                const appendResult = await appendMessages(directories, ownerId, built.anchorNodeId, [
                    { name: built.name1, is_user: true, mes: userMessageText, extra: userMessageExtra, send_date: Date.now() },
                ]);
                if (!appendResult.ok) {
                    console.error('Failed to persist user message onto the tree:', appendResult.reason);
                } else if (appendResult.node_ids?.length) {
                    replyAnchorNodeId = appendResult.node_ids[appendResult.node_ids.length - 1];
                }
            }

            // Stash what's needed to persist the ASSISTANT's reply once a (streaming or
            // non-streaming) response is known - read both by the default/legacy-dispatch-block below
            // (guarded by `if (pendingAssistantPersist)`/the `forwardAndPersistCompactStream()` call) AND,
            // passed explicitly as each function's own third parameter, by ALL 12 provider-`switch`
            // cases (sendClaudeRequest/sendMakerSuiteRequest/sendAI21Request/sendMistralAIRequest/
            // sendCohereRequest/sendDeepSeekRequest/sendAimlapiRequest/sendXaiRequest/
            // sendChutesRequest/sendMinimaxRequest/sendElectronHubRequest/sendAzureOpenAIRequest) -
            // every provider-`switch` case now persists for real (see the comment on this variable's
            // declaration above for exactly which paths persist for real, per-provider). Left `null`
            // (its declared default) for `is_impersonate`/`type === 'quiet'`, so the reply is never
            // appended to the tree for either - it still reaches the client unchanged via the normal
            // response, it just never gets persisted.
            //
            // `isSwipe` is carried through identically to text-completions.js's own route wiring - see
            // that file's own comment on this same field for the full rationale (sibling-alternative
            // persistence via `addAlternatives()`, shared by BOTH `type === 'swipe'` and `type ===
            // 'regenerate'` via the client's single `is_swipe` flag).
            //
            // `isContinue`/`anchorContent` are carried through identically to text-completions.js's own
            // route wiring too - see that file's own comment on these same fields for the full
            // rationale (in-place `editMessage()` persistence for a continue, and why `anchorContent`'s
            // full object - not just the anchor node id - is needed to build it), INCLUDING the same
            // `continueUserTextConflict` guard against the real (not hypothetical) "leftover
            // send-textarea text alongside a continue" edge case - see that file's own comment on this
            // same computation for the full explanation of why it's needed, and why the fix is to skip
            // the assistant reply's persistence ENTIRELY for that one combination (not fall back to a
            // plain appendMessages(), which would misrepresent a continuation fragment as a complete
            // new reply).
            const continueUserTextConflict = isContinue && replyAnchorNodeId !== built.anchorNodeId;
            if (!skipPersistence && !continueUserTextConflict) {
                pendingAssistantPersist = {
                    directories, ownerId, anchorNodeId: replyAnchorNodeId, name2: built.name2,
                    isSwipe, isContinue, anchorContent: built.anchorContent,
                };
                // Only wired up when this request actually advertised at least one server-native
                // tool OR at least one client-advertised tool (chunk (c) - see `built.enabledServerTools`/
                // `built.enabledClientToolNames`/`buildRawActionChatCompletionRequest()`'s own
                // `toolsPayload` doc comment) - gated on the exact same conditions as
                // `pendingAssistantPersist` above, since the tool-call loop only ever runs as a
                // precursor to persisting a real final reply (never for impersonate/quiet, and never
                // for the continue/user-text-conflict edge case, which skips assistant persistence
                // entirely). A pure client-tools-only request (no server tool registered at all) still
                // needs this wired up - otherwise a backend response calling one of those client tools
                // would fall through to the "no pending tool loop" path below and be mishandled as a
                // plain reply.
                if (built.enabledServerTools.length > 0 || built.enabledClientToolNames.size > 0) {
                    pendingServerToolLoop = {
                        directories, ownerId, characterAvatar, groupId,
                        enabledTools: built.enabledServerTools,
                        clientToolNames: built.enabledClientToolNames,
                        // THIS TASK (stealth-tool parity) - forwarded into runServerToolRounds()'s own
                        // `stealthToolNames` param, see that function's doc comment step 2b.
                        stealthToolNames: built.enabledStealthClientToolNames,
                        clientToolSchemas,
                    };
                }
            }

            // Replace the body entirely - mirrors the connection-profile branch's own final
            // assignment shape exactly, so the existing downstream dispatch code below is completely
            // unaware of which branch produced request.body. No secret_id override: unlike the
            // connection-profile branch (which resolves a PROFILE's own stored secret), this raw
            // action uses the user's OWN currently active setup, so `secret_id` is left `undefined` -
            // exactly like an ordinary client-driven request that doesn't name a specific stored
            // secret - and every downstream `readSecret(..., request.body.secret_id)` call already
            // treats `undefined` as "use the default secret for this key" (readSecret()'s own `id =
            // null` default).
            const stream = !!request.body.stream;
            request.body = { ...built.params, stream, chat_completion_source: built.settings.chat_completion_source };
        }

        const postProcessingType = request.body.custom_prompt_post_processing;
        if (Array.isArray(request.body.messages) && postProcessingType) {
            console.info('Applying custom prompt post-processing of type', postProcessingType);
            request.body.messages = postProcessPrompt(
                request.body.messages,
                postProcessingType,
                getPromptNames(request));
        }

        if (request.body.json_schema?.value) {
            request.body.json_schema.value = flattenSchema(request.body.json_schema.value, request.body.chat_completion_source);
        }

        switch (request.body.chat_completion_source) {
            case CHAT_COMPLETION_SOURCES.CLAUDE: return await sendClaudeRequest(request, response, pendingAssistantPersist);
            case CHAT_COMPLETION_SOURCES.AI21: return await sendAI21Request(request, response, pendingAssistantPersist);
            case CHAT_COMPLETION_SOURCES.MAKERSUITE: return await sendMakerSuiteRequest(request, response, pendingAssistantPersist);
            case CHAT_COMPLETION_SOURCES.VERTEXAI: return await sendMakerSuiteRequest(request, response, pendingAssistantPersist);
            case CHAT_COMPLETION_SOURCES.MISTRALAI: return await sendMistralAIRequest(request, response, pendingAssistantPersist);
            case CHAT_COMPLETION_SOURCES.COHERE: return await sendCohereRequest(request, response, pendingAssistantPersist);
            case CHAT_COMPLETION_SOURCES.DEEPSEEK: return await sendDeepSeekRequest(request, response, pendingAssistantPersist);
            case CHAT_COMPLETION_SOURCES.AIMLAPI: return await sendAimlapiRequest(request, response, pendingAssistantPersist);
            case CHAT_COMPLETION_SOURCES.XAI: return await sendXaiRequest(request, response, pendingAssistantPersist);
            case CHAT_COMPLETION_SOURCES.CHUTES: return await sendChutesRequest(request, response, pendingAssistantPersist);
            case CHAT_COMPLETION_SOURCES.MINIMAX: return await sendMinimaxRequest(request, response, pendingAssistantPersist);
            case CHAT_COMPLETION_SOURCES.ELECTRONHUB: return await sendElectronHubRequest(request, response, pendingAssistantPersist);
            case CHAT_COMPLETION_SOURCES.AZURE_OPENAI: return await sendAzureOpenAIRequest(request, response, pendingAssistantPersist);
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
        const endpointUrl = isTextCompletion && request.body.chat_completion_source !== CHAT_COMPLETION_SOURCES.OPENROUTER ?
            `${apiUrl}/completions` :
            `${apiUrl}/chat/completions`;

        const controller = new AbortController();
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

        console.debug('Chat Completion request:', requestBody);

        const fetchResponse = await fetch(endpointUrl, config);

        if (request.body.stream) {
            // Server-native (chunk (b)) AND client-proxy (chunk (c)) tool-calling loop, STREAMING
            // counterpart of the non-streaming branch below - ONLY when this raw-action request
            // actually advertised at least one server tool OR client-advertised tool
            // (`pendingServerToolLoop` set, identical gate to the non-streaming call site below). See
            // `forwardAndPersistCompactStreamWithServerTools()`'s own doc comment for the full design
            // (tee + accumulate tool_calls, forward them as 0x05 frames, reuse `runServerToolRounds()`
            // once the round ends, and the `tool_call_handoff` control-frame mechanism for a
            // client-only hand-off).
            if (pendingServerToolLoop) {
                // `stream: false` is forced for every round AFTER the first - matching the EXISTING,
                // already-shipped non-streaming call site's own precedent a few lines below (every
                // round after the first uses a plain non-streaming `refetch()` regardless of the
                // ORIGINAL request's own `stream` flag) - the original request's `requestBody.stream`
                // here is `true` (this is the streaming branch), so it must be explicitly overridden,
                // or a real backend would honor it and return another SSE stream that
                // `runServerToolRounds()`'s own `fetchResponse.json()` call cannot parse.
                return await forwardAndPersistCompactStreamWithServerTools(
                    fetchResponse, response, pendingAssistantPersist, pendingServerToolLoop,
                    (messages) => fetch(endpointUrl, { ...config, body: JSON.stringify({ ...requestBody, stream: false, messages }) }),
                );
            }

            // Pipe remote SSE stream to Express response, tapping the same bytes (unaltered) to
            // accumulate the OpenAI Chat-Completions-shaped `choices[0].delta.content` field for
            // persistence - see `forwardAndPersistCompactStream()`'s own doc comment above for
            // the full teeing mechanism and the `choices[0].delta.content` shape verification. The
            // compact re-encoding itself always happens; `pendingAssistantPersist` being `null`
            // (connection_profile_id and legacy/default calls) only skips persistence.
            return await forwardAndPersistCompactStream(fetchResponse, response, pendingAssistantPersist, json => json?.choices?.[0]?.delta?.content, extractGenericReasoning);
        }

        if (fetchResponse.ok) {
            /** @type {any} */
            let json = await fetchResponse.json();
            console.debug('Chat Completion response:', json);

            // Server-native (chunk (b)) AND client-proxy (chunk (c)) tool-calling loop - ONLY when
            // this raw-action request actually advertised at least one server tool OR client-advertised
            // tool (`pendingServerToolLoop` set - see its own declaration comment near the top of this
            // route) AND the backend's first response already came back with real `tool_calls`. A
            // request with neither never set `pendingServerToolLoop`, so `json`/the response-handling
            // below is completely unaffected - byte-for-byte the same as before chunk (b) landed. See
            // `runServerToolRounds()`'s own doc comment for the full per-round behavior (execute ->
            // persist -> re-resolve -> re-fetch, bounded by `SERVER_TOOL_ROUND_LIMIT`) and its
            // documented "unrecognized tool name" failure mode (still a 422 - now only for a name that
            // matches NEITHER the server registry NOR this request's own `client_tools`).
            if (pendingServerToolLoop && Array.isArray(json?.choices?.[0]?.message?.tool_calls) && json.choices[0].message.tool_calls.length > 0) {
                const roundResult = await runServerToolRounds({
                    ...pendingServerToolLoop,
                    leafNodeId: pendingAssistantPersist.anchorNodeId,
                    isSwipe: pendingAssistantPersist.isSwipe,
                    initialJson: json,
                    refetch: (messages) => fetch(endpointUrl, { ...config, body: JSON.stringify({ ...requestBody, messages }) }),
                });
                // Chunk (c): a client-only tool call was hit - hand off to the client instead of
                // trying to resolve it here. This response shape is DISTINCT from a normal generation
                // result (see `runServerToolRounds()`'s own doc comment, step 5) - nothing below this
                // (persistence of a "final reply") applies, since there isn't one yet.
                // THIS TASK (stealth-tool parity, runServerToolRounds()'s own doc comment step 2b) -
                // nothing was invoked/persisted for this round; matching legacy's `shouldStopGeneration`
                // branch, respond with a distinct, non-`choices`-shaped outcome the client recognizes
                // (see public/script.js's raw-action gate) instead of a normal generation result or the
                // `pending_tool_calls` hand-off shape - there is no pending tool call for the client to
                // resolve, only "this generation produced nothing".
                if (roundResult.ok === 'aborted') {
                    return response.send({ aborted: true });
                }
                if (roundResult.ok === 'pending') {
                    return response.send({ pending_tool_calls: roundResult.pendingToolCalls });
                }
                if (!roundResult.ok) {
                    return response.status(roundResult.status).send({ error: true, message: roundResult.message });
                }
                json = roundResult.json;
                // Advance the persistence anchor to whatever the tool-call loop's last-appended node
                // was, so the FINAL plain-text reply (persisted just below) chains after the real
                // tool-call/result turns instead of the stale pre-loop anchor. Once ANY round has run
                // (guaranteed here - this block is only reached when the backend's first response
                // already carried tool_calls, so round 0 always executes), `isSwipe`/`isContinue` are
                // downgraded to a plain append: `runServerToolRounds()` already claimed the
                // sibling-alternative slot for `isSwipe` at round 0 (see its own doc comment), and
                // `isContinue`'s "edit in place" has no meaningful target anymore once a real
                // intervening tool-call node exists on the tree - see `runServerToolRounds()`'s own doc
                // comment for the full rationale (was previously a documented, out-of-scope limitation).
                pendingAssistantPersist.anchorNodeId = roundResult.leafNodeId;
                pendingAssistantPersist.isSwipe = false;
                pendingAssistantPersist.isContinue = false;
            }

            // Persist the ASSISTANT's reply for the raw-action branch (see
            // `pendingAssistantPersist`'s declaration near the top of this route) - only reached for
            // a real, successful (fetchResponse.ok) NON-STREAMING generation dispatched through THIS
            // shared inline OpenAI/custom/other-source block, so nothing speculative ever gets
            // committed. A no-op when the raw-action branch didn't run, and never reached at all for
            // the provider-`switch` cases above (each `return`s from its own function before this
            // point) - see that variable's own declaration comment for the full list of what's NOT
            // covered here (those ~12 functions, for either streaming or non-streaming).
            //
            // The actual plain/continue/swipe persistence branching lives in `persistAssistantReply()`
            // (../../assistant-reply-persist.js), shared with the streaming branch above - see that
            // module's own doc comment for the full continue/`editMessage()` and
            // swipe/`addAlternatives()`+`selectDefaultChild()` rationale (unchanged from this route's
            // own original design; also shared, verbatim, with text-completions.js's own identical
            // persistence for its backend).
            if (pendingAssistantPersist) {
                // This shared block only ever builds an OpenAI-Chat-Completions-shaped request
                // (`/chat/completions`, `messages: [...]`) UNLESS `isTextCompletion` is true (a
                // `/completions`-style legacy text-completion model routed through this same chat-
                // completion source) - re-verified above (`isTextCompletion` derivation, `endpointUrl`
                // branch, `textPrompt`/`convertTextCompletionPrompt` construction). The raw-action
                // branch above always builds real chat messages (never a plain string prompt), so
                // `isTextCompletion` is never true for it - only the real chat-shaped
                // `{choices: [{message: {content}}]}` response is ever extracted here.
                const generatedText = json?.choices?.[0]?.message?.content ?? '';
                const persisted = await persistAssistantReply(pendingAssistantPersist, generatedText);
                if (persisted) json.assistant_node_id = persisted.node_id;
            }

            return response.send(json);
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
});

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

// See text-completions.js's identical route for the shared implementation/rationale - both routers
// mount it since a generation id doesn't identify which backend produced it.
router.get('/generate/resume/:id', handleGenerationResume);

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
