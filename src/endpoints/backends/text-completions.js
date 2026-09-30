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
import { createHash, randomUUID } from 'node:crypto';
import { pipeLlamaCppCompactStream, getLlamaCppStreamMeta, createBackpressureWriter, createGenerationRecord, createResumableWriter, detachFromResponse, handleGenerationResume, encodeContent, encodeIndexFrame, encodeReasoningFrame, encodeAssistantNodeIdFrame, encodeProbabilitiesFrame, encodeControlFrame } from './llamacpp-compact-stream.js';
import { resolveTextGenBackend, resolveServerUrl } from '../../textgen-backend-resolve.js';
import { resolveConnectionProfile } from '../../connection-profile-resolve.js';
import { mergeTextGenPreset } from '../../textgen-preset-merge.js';
import { createTextGenGenerationData } from '../../textgen-generation-data.js';
import { constructPrompt, getInstructStoppingSequences } from '../../instruct-template-format.js';
import { readSettingsAtPaths } from '../../settings-store.js';
import { readPresetByName } from '../presets.js';
import { resolveTokenizer, encodeWithTokenizer, resolveProfileTokenizerSetting, createTokenizerOutcome, sendTokenizerWarnings, tokenizerIdentity } from '../../tokenizer-resolve.js';
import { createLlamaCppPropsCheck } from '../../llamacpp-props.js';
import { createStoredCounter, writeBack } from '../../token-count-store.js';
import { fetchTextgenStatus, rememberRemoteTokenization } from '../../backend-status.js';
import { rememberOpenRouterModels } from '../../openrouter-models.js';
import { resolveTextCompletionGenerationInput } from '../../text-completion-generation-input.js';
import { assembleTextCompletionPrompt, buildItemizationBreakdown } from '../../text-completion-prompt-orchestrator.js';
import { getAncestorPath, appendMessages, sanitizeUserMessageExtra } from '../../message-tree-db.js';
import { readCardContent } from '../characters.js';
import { getGroupsByIds } from '../groups.js';
import { persistAssistantReply, replyTextAsPageShows } from '../../assistant-reply-persist.js';

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
 * @param {Record<string, *>} [itemization] Raw-action prompt-itemization breakdown (buildRawActionTextCompletionRequest()'s
 * own `itemization` field) - when set, written as the first frame, a control-JSON frame the client's
 * CompactStreamDecoder already decodes generically (`{control: {itemization: ...}}`).
 * @param {Array<{kind: string, key: string, message: string, entries?: string[]}>|null} [warnings] The
 * `/generate` route's per-request warnings - when non-empty, written as their own control frame
 * (`{control: {warnings: ...}}`) right after the itemization frame, before any content.
 * @returns {Promise<any>} Nothing valuable
 */
async function parseOllamaStream(jsonStream, request, response, persist, itemization, warnings = null) {
    try {
        if (!jsonStream.body) {
            throw new Error('No body in the response');
        }

        response.setHeader('X-ST-Stream-Format', 'compact-v1');
        const generationId = randomUUID();
        response.setHeader('X-Generation-Id', generationId);
        const generationRecord = createGenerationRecord(generationId);
        const { writer: initialWriter, stopKeepalive } = createResumableWriter(createBackpressureWriter(response), generationRecord);
        if (itemization) {
            initialWriter.write(encodeControlFrame({ itemization }));
        }
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
                        if (persisted) writer.write(encodeAssistantNodeIdFrame(persisted.node_id));
                    })
                    .catch(error => console.error('Failed to persist streamed Ollama assistant reply:', error))
                    .finally(() => writer.end());
            } else {
                writer.end();
            }
        };

        jsonStream.body.on('data', (data) => {
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
                if (persist) accumulatedText += text;
                if (thinking) writer.write(encodeReasoningFrame(thinking));
                if (text) writer.write(encodeContent(text));
                partialData = '';
            }
        });

        request.socket.on('close', function () {
            // Client dropped - keep buffering the still-in-flight upstream generation for a possible
            // resume (see llamacpp-compact-stream.js's module doc comment) instead of tearing it
            // down; `finishPersist()` still runs once jsonStream.body actually ends on its own below.
            stopKeepalive();
            writer = detachFromResponse(generationRecord);
        });

        jsonStream.body.on('end', () => {
            finishPersist();
        });
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
 * Accumulates a raw-action reply from an upstream OpenAI-completions-shaped SSE stream and persists
 * it once the stream ends, for the two call sites below (GENERIC/DREAMGEN/MANCER/VLLM's
 * `choices[0].text` shape and OPENROUTER's `choices[0].delta.content` shape). Re-encodes what it
 * forwards to the client into the compact binary wire format (llamacpp-compact-stream.js),
 * coalescing many small upstream chunks into fewer, larger writes instead of forwarding one frame
 * per upstream token/SSE-chunk - see llamacpp-compact-stream.js's own module doc comment for the
 * frame format itself.
 *
 * The FIRST piece of content is flushed immediately (so the reply visibly starts without delay);
 * everything after that is buffered and flushed on a ~40ms timer or once ~256 buffered bytes are
 * reached, whichever comes first. A reasoning or index frame always flushes any buffered content
 * first, so frames reach the client in the same relative order the events arrived in upstream.
 *
 * Once the upstream body ends, this flushes any remaining buffered content, persists the
 * accumulated text, and - if persistence produced a node - writes the assistant_node_id frame as the
 * LAST frame before `response.end()`, so the client (whose stream reader stops at the natural end of
 * the byte stream, not a sentinel line) still reads it before it stops.
 * @param {import('node-fetch').Response} fetchResponse
 * @param {import('express').Response} response
 * @param {object|null|undefined} persist `pendingAssistantPersist`, or a falsy value to skip
 * persistence only - the compact binary re-encoding itself always happens (there is no "forward the
 * upstream bytes untouched" fallback based on `persist` alone anymore: every stream reaching this
 * function, raw-action or not, is re-shaped into the same compact-v1 wire format the client always
 * decodes).
 * @param {(json: any) => string|undefined} extractText Pulls this api_type's own real per-chunk
 * generated-text field out of one parsed SSE JSON payload - see the two real, DIFFERENT on-wire
 * shapes this covers at the call sites below (`choices[0].text` for the `/v1/completions`-style
 * api_types vs. `choices[0].delta.content` for OPENROUTER's `/v1/chat/completions`-style stream).
 * @param {((json: any) => any)|null} [extractProbabilities] Pulls this api_type's own real per-chunk
 * token-probabilities payload (if any) out of one parsed SSE JSON payload - re-encoded as a `0x02`
 * probabilities frame ahead of the content frame it belongs to, same ordering
 * llamacpp-compact-stream.js's own encodeEvent() uses. `null` (the default) for an api_type with no
 * such field - NovelAI's `data.logprobs` is the only current caller.
 * @param {Record<string, *>} [itemization] Raw-action prompt-itemization breakdown (buildRawActionTextCompletionRequest()'s
 * own `itemization` field) - when set, written as the first frame, a control-JSON frame the client's
 * CompactStreamDecoder already decodes generically (`{control: {itemization: ...}}`).
 * @param {Array<{kind: string, key: string, message: string, entries?: string[]}>|null} [warnings] The
 * calling generate route's per-request warnings - when non-empty, written as their own control frame
 * (`{control: {warnings: ...}}`) right after the itemization frame, before any content.
 * @returns {Promise<void>}
 */
export async function forwardAndPersistCompactStream(fetchResponse, response, persist, extractText, extractProbabilities = null, itemization = null, warnings = null) {
    if (!fetchResponse.ok || !fetchResponse.body) {
        return forwardFetchResponse(fetchResponse, response);
    }

    let statusCode = fetchResponse.status;
    if (statusCode === 401) statusCode = 400;
    response.statusCode = statusCode;
    response.statusMessage = fetchResponse.statusText;
    response.setHeader('X-ST-Stream-Format', 'compact-v1');
    const generationId = randomUUID();
    response.setHeader('X-Generation-Id', generationId);

    let sseBuffer = '';
    let text = '';
    let lastIndex = 0;

    // Same backpressure-coalescing writer pipeLlamaCppCompactStream() uses - its own `ended` flag
    // (set by end(), checked by every subsequent flush()) is what makes end() and write() both safe
    // to call after a client disconnect without an explicit response.writableEnded check at each
    // call site here. Wrapped so every byte is also retained for a resume (see
    // llamacpp-compact-stream.js's withGenerationBuffer()/handleGenerationResume()).
    const generationRecord = createGenerationRecord(generationId);
    const { writer: initialWriter, stopKeepalive } = createResumableWriter(createBackpressureWriter(response), generationRecord);
    let writer = initialWriter;
    if (itemization) {
        writer.write(encodeControlFrame({ itemization }));
    }
    if (warnings?.length) {
        writer.write(encodeControlFrame({ warnings }));
    }
    const safeWrite = (chunk) => writer.write(chunk);

    const onSocketClose = () => {
        // Client dropped - keep buffering the still-in-flight upstream generation for a possible
        // resume instead of tearing it down; the persist-and-end logic below still runs once
        // fetchResponse.body actually ends on its own.
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
            emitContent(chunkText);
        }
    };

    const processLine = (rawLine) => {
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
        if (persisted) {
            safeWrite(encodeAssistantNodeIdFrame(persisted.node_id));
        }
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
        console.info('Aborting Kobold generation...');
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
        console.error(error);
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
            console.debug(`Querying llama-server props with model parameter: ${request.body.model}`);
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
        console.error(error);
        return response.sendStatus(500);
    }
});

/**
 * Builds the real backend-request-shaped payload for the raw-action `/generate` branch below,
 * entirely server-side - the request-building steps (1-6 in this session's task write-up), pulled
 * out into a standalone, Express-independent function so it can be unit-tested directly (this
 * codebase has no existing route-level Express-integration-test convention to follow instead - see
 * this file's own test file for the full explanation of that call).
 *
 * In order:
 * 1. Resolve the real, currently-active text-completion backend (NOT a connection profile) via
 *    `resolveTextGenBackend()`.
 * 2. Verify the named character/group actually exists (a real 400-worthy failure, not a garbage
 *    generation) and resolve which existing tree node any new user message must be appended after
 *    (`anchorNodeId` - the given `nodeId` itself, verified to exist, or - only when `nodeId` is
 *    explicitly `null` AND this owner's conversation is genuinely empty - the owner's own anchor).
 * 3. Resolve the tokenizer with `resolveTokenizer()` (the backend's type, URL and model setting, and
 *    `power_user.tokenizer`), and build `countTokens`/`encodeTokens` from it: an estimate
 *    resolution, or a tokenizer that fails with no local copy to answer for it, counts by the
 *    estimate and has no ids, so entries needing ids are left out. The returned `warnings` report
 *    those entries, a local copy answering for a failed remote tokenizer, and an estimate trim
 *    after a failure.
 * 4. Resolve the orchestrator's full input from real on-disk settings/character/chat state via
 *    `resolveTextCompletionGenerationInput()`.
 * 5. Assemble the real prompt via `assembleTextCompletionPrompt()`.
 * 6. JUDGMENT CALL: `assembleTextCompletionPrompt()` already calls `createTextGenGenerationData()`
 *    internally (its own "Step 16") and returns the result as `generate_data` - calling
 *    `createTextGenGenerationData()` a SECOND time here would just duplicate that exact call with
 *    hand-reconstructed `stoppingStrings`/`bannedTokens`/`bannedStrings`/`logitBias`/`cfgValues`
 *    the orchestrator already computed internally (and risk the two calls silently drifting apart).
 *    So this uses the orchestrator's own returned `generate_data` directly as the backend-request
 *    payload instead of re-deriving it.
 *
 * Does NOT persist anything (that's the caller's job - see the route handler below) and does NOT
 * set `stream`/`api_type`/`api_server` on the returned `params` (also the caller's job, mirroring
 * the existing `connection_profile_id` branch's own final-assignment shape).
 *
 * ADDRESSING MODEL (this task's correction): there is no `branchName`/`branch_name` field in this
 * raw-action surface at all - a label is a human-facing bookmark on a tree node (bookmarks.js, out
 * of scope here), a DIFFERENT concept from "which node this generate call continues from". By the
 * time a real client is about to send a raw-action generate request for ANY chat - including one
 * resumed via a label in a "past chats" picker - it has ALREADY LOADED that chat to display it, so
 * it already has the real, concrete `node_id` of the leaf it's showing; a label never carries
 * addressing information `node_id` doesn't already carry, and only `node_id` is exact (no name
 * lookup, no staleness/collision risk). So `nodeId` is now the ONLY addressing input, and it is a
 * REQUIRED param - but `null` is a valid, meaningful value for it (see below), so "required" means
 * "the caller must pass the key with a value that is a real node id string OR the literal `null`",
 * NOT "must be a non-empty string". Passing `undefined` (the route handler's stand-in for the JSON
 * key being absent entirely) throws - see the route handler's own real-JSON-semantics comment on
 * exactly why "absent" and "explicit null" must stay distinguishable rather than both collapsing to
 * "resolve however you like": a caller that silently failed to attach the node id it was actually
 * looking at must get a loud 400, not a quiet wrong-guess.
 * - A real `nodeId` string: address that specific existing node - unchanged prior behavior.
 * - `nodeId === null`: valid ONLY when this owner's conversation is genuinely empty (the anchor has
 *   no real default-child chain yet, i.e. no real message has ever been committed for this owner) -
 *   resolves via the owner's own anchor (`getOrCreateAnchor()`/the shared `resolveChatHistory()`
 *   inside `resolveTextCompletionGenerationInput()` - see that function's own doc comment). If the
 *   owner ALREADY has real history, `null` here is a real, reportable error (400) - the caller
 *   should have sent the node id it was actually looking at; the server does not silently guess
 *   which point was meant once a real point could disagree with a concurrently-changed tree.
 *
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {object} params
 * @param {import('express').Request} [params.request] Original request - forwarded only for the
 * remote-tokenizer header-forwarding path (`encodeViaTextgenAPI`); safe to omit in tests.
 * @param {string} [params.characterAvatar] Character avatar filename. One of this or `groupId` is required.
 *   For a GROUP turn, pass BOTH `characterAvatar` (the specific responding member's card, for
 *   name2/world-info/depth-prompt resolution) AND `groupId` (the group's own addressing/roster) -
 *   this is a real, intentional combination, not a fallback: the existence checks below run
 *   independently for each, `resolveTextCompletionGenerationInput()`'s own
 *   `resolveName2AndGroupMemberNames()` already resolves `name2` from `avatar` while still
 *   populating `groupMemberNames` from every group member, and `getGroupCharacterDepthPrompts()`
 *   (src/text-completion-prompt-orchestrator.js) already takes both `groupId` AND `avatar` together
 *   for exactly this reason. `characterAvatar` alone (no `groupId`) still means a plain
 *   single-character turn.
 * @param {string} [params.groupId] Group id. One of this or `characterAvatar` is required. See
 *   `characterAvatar`'s own doc comment above for the "both together, for a group turn" case.
 * @param {string} params.ownerId message-tree-db.js owner id.
 * @param {string|null} params.nodeId REQUIRED (`undefined` throws) - see this function's own doc
 * comment ADDRESSING MODEL section. A real node id string addresses that node; `null` asserts "this
 * is a genuinely brand-new, empty conversation" and only succeeds when that is actually true.
 * @param {string} [params.type] Generation type ('normal'/'impersonate'/'continue'/'swipe'/...).
 * @param {boolean} [params.isImpersonate]
 * @param {boolean} [params.isContinue]
 * @param {boolean} [params.isSwipe]
 * @param {string} [params.userMessageText] The literal text the user typed this turn. Omit for
 * generation types that don't add a new message (continue/swipe).
 * @param {object} [params.userMessageExtra] Already-SERVER-VALIDATED `extra` (see
 * `sanitizeUserMessageExtra()` in message-tree-db.js) for the new user message being appended -
 * forwarded verbatim to `resolveTextCompletionGenerationInput()` and reused as-is for the real
 * persisted append below (the route handler is responsible for having already sanitized whatever the
 * client sent; this function does not re-validate it). Ignored when `userMessageText` is omitted.
 * @returns {Promise<{ params: object, backend: {type: string, serverUrl: string, model: string|undefined}, anchorNodeId: string|null, anchorContent: object|null, tokenizerIdentity: string|null, tokenCountRows: import('../../token-count-store.js').PendingTokenRows, name1: string, name2: string, warnings: object[] }>}
 * `tokenizerIdentity` is the resolved tokenizer's tokenizerIdentity(), for llama.cpp from this
 * generation's own `/props` answer. `tokenCountRows` are the counts and ids this build read from or
 * added to the token tables, for writeBack() once the request is sent.
 */
export async function buildRawActionTextCompletionRequest(directories, {
    request, characterAvatar, groupId, ownerId, nodeId,
    type = 'normal', isImpersonate = false, isContinue = false, isSwipe = false, userMessageText, userMessageExtra,
    // Test-only injection point, forwarded straight through to encodeWithTokenizerType()'s own
    // `encodeLocal`/`encodeTextgenRemote`/`fetchImpl` options (see that function's JSDoc) - lets a
    // test exercise this function end-to-end without real tokenizer model files or a live backend
    // to tokenize against. Never set by the /generate route itself.
    tokenizerOptions = {},
} = {}) {
    if (!ownerId) {
        throw new Error('owner_id is required');
    }
    if (!characterAvatar && !groupId) {
        throw new Error('character_avatar or group_id is required');
    }
    // `nodeId` must be an explicitly-present field: a real node id string, or the literal `null` to
    // assert "genuinely new, empty conversation". `undefined` means the caller's request body never
    // had the key at all (JSON has no `undefined` literal, so after JSON.parse a present `node_id:
    // null` and an absent key are the only two ways to reach here without a string, and they land on
    // `null` vs `undefined` respectively - see this function's own ADDRESSING MODEL doc comment).
    if (nodeId === undefined) {
        throw new Error('node_id is required (pass null explicitly for a brand-new, empty conversation)');
    }

    // Step 1
    const backend = resolveTextGenBackend(directories);

    // Step 2 (existence checks) - readCardContent() throws (rather than returning undefined) for a
    // missing file (ENOENT); resolveName2AndGroupMemberNames() in text-completion-generation-
    // input.js already treats any read failure as "no character" via its own try/catch, so this
    // mirrors that same convention rather than letting the ENOENT bubble up as an unrelated 500.
    if (characterAvatar) {
        let raw;
        try {
            raw = await readCardContent(directories, characterAvatar);
        } catch { /* treated as not-found below, matching resolveName2AndGroupMemberNames()'s convention */ }
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

    // Step 2 (anchor resolution) - a real given `nodeId` is verified directly, exactly as before.
    // `nodeId === null` (the "genuinely new, empty conversation" assertion) can't be verified yet
    // independently of the chat-history resolution below - it's the SAME "does this owner already
    // have real history" question `resolveTextCompletionGenerationInput()`'s own (private)
    // `resolveChatHistory()` already has to answer, and re-deriving it a second, separate way here
    // would risk the two disagreeing (see this function's own doc comment). So for `nodeId === null`
    // this is left unresolved here and instead read back off `orchestratorInput.resolvedNodeId` /
    // `orchestratorInput.chatResolutionAmbiguous` once Step 4 has already computed it for real.
    let anchorNodeId = null;
    if (nodeId !== null) {
        const ancestorPath = await getAncestorPath(directories, nodeId);
        if (!ancestorPath) {
            throw new Error(`Chat node not found: ${nodeId}`);
        }
        anchorNodeId = nodeId;
    }

    // Step 3
    const { power_user: powerUser = {} } = readSettingsAtPaths(directories, ['power_user']);
    const tokenizerState = {
        api: 'textgenerationwebui', type: backend.type, url: backend.serverUrl, model: backend.model ?? '',
        tokenizerSetting: powerUser.tokenizer,
    };
    // llama.cpp says nothing when its model changes, so a generation asks its /props afresh.
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

    // Step 4
    const orchestratorInput = await resolveTextCompletionGenerationInput(directories, {
        // `nodeId` passed as-is: `resolveChatHistory()`'s own checks are truthy-based, so `null`
        // already falls through to its anchor-resolution branch exactly like `undefined` would.
        avatar: characterAvatar, groupId, ownerId, nodeId,
        type, isImpersonate, isContinue, isSwipe, userMessageText, userMessageExtra,
        countTokens, encodeTokens, countPromptTokens,
    });

    // `nodeId === null` ("genuinely new, empty conversation") is only valid when this owner's
    // conversation really is empty - `resolveChatHistory()` (inside the resolver just called) already
    // determined this for real, via the SAME anchor resolution, and reports it back here rather than
    // this function re-deriving it independently (see Step 2's own comment above for why that would
    // risk disagreement). `chatResolutionAmbiguous` means real prior history exists but neither a
    // node id nor (now-removed) branch name was given to say which point was meant - a real error,
    // not a silent guess at "the current leaf".
    if (nodeId === null) {
        if (orchestratorInput.chatResolutionAmbiguous) {
            throw new Error('node_id is required: this character/group already has an existing conversation - resolve which node the client was looking at and pass its node_id (null is only valid for a genuinely new, empty conversation)');
        }
        anchorNodeId = orchestratorInput.resolvedNodeId;
    }

    if ((isContinue || isSwipe) && orchestratorInput.chat.length === 0) {
        throw new Error('Cannot continue/swipe an empty chat.');
    }

    // Step 5-6
    const assembled = await assembleTextCompletionPrompt(orchestratorInput);

    // `anchorContent` (used only for `is_continue` persistence - see the route handler below): the
    // CURRENT, on-disk content of the anchor node itself, so the caller can build `oldText + newText`
    // without a second DB read. Reused directly from `orchestratorInput.chat`'s own last entry rather
    // than re-fetched - verified (not assumed) that this resolver never drops or alters that entry for
    // `isContinue` the way it does for `isSwipe` (see resolveTextCompletionGenerationInput()'s own
    // `chat` construction above: it's exactly `loadedChat` - straight from `loadBranch()`/
    // `getAncestorPath()` - whenever `userMessageText` is omitted, which is always true for continue).
    // Only meaningful when `orchestratorInput.chat.length > 0`, which the guard above already
    // guarantees for `isContinue` (an empty-chat continue throws before reaching here) - `null` for
    // every other, non-continue caller shape where `chat` could legitimately be empty.
    const anchorContent = orchestratorInput.chat.length > 0 ? orchestratorInput.chat[orchestratorInput.chat.length - 1] : null;

    return {
        params: assembled.generate_data, backend, anchorNodeId, anchorContent, tokenizerIdentity: identity,
        tokenCountRows: storedCounter.pending,
        name1: orchestratorInput.name1, name2: orchestratorInput.name2,
        warnings: sendTokenizerWarnings(tokenizerState, resolvedTokenizer, tokenizerOutcome, assembled.droppedEntries),
        // Prompt-itemization breakdown for the client's itemizedPrompts entry - see
        // buildItemizationBreakdown()'s own doc comment (text-completion-prompt-orchestrator.js).
        itemization: buildItemizationBreakdown(assembled),
    };
}

router.post('/generate', async function (request, response) {
    if (!request.body) return response.sendStatus(400);

    // Set only by the raw-action branch below (and only for a type/mode where the reply is actually
    // meant to be persisted - see that branch's own comment for the `is_impersonate`/`type ===
    // 'quiet'` exclusion). Read by the non-streaming response branch AND by the streaming branches
    // further down - every other branch (connection-profile, default/legacy) never sets this, so it
    // stays `null` and every persistence call below stays a no-op for them. The wire format itself
    // (compact-v1, every streaming branch below) is unaffected either way - `null` only means
    // nothing gets written to the message tree once the stream ends.
    //
    // Streaming persistence status, precisely, per api_type (see `persistAssistantReply()` in
    // ../../assistant-reply-persist.js for the shared plain/continue/swipe persistence logic all of
    // these funnel into once they have the final text):
    // - GENERIC/VLLM/FEATHERLESS/APHRODITE/OOBA/TABBY/KOBOLDCPP/TOGETHERAI/INFERMATICAI/HUGGINGFACE/
    //   DREAMGEN/MANCER (the `/v1/completions`-style, `forwardAndPersistCompactStream()`-routed
    //   api_types below): PERSISTS FOR REAL. Their upstream stream is an OpenAI TEXT-completions-
    //   shaped SSE (`data: {"choices":[{"text": "..."}]}`) - `forwardAndPersistCompactStream()`
    //   accumulates `choices[0].text` per chunk, re-encodes it into the compact binary wire format
    //   (coalesced into fewer, larger writes) for the client, and persists the full text once the
    //   stream ends.
    // - OPENROUTER: PERSISTS FOR REAL, via the same `forwardAndPersistCompactStream()` re-encoding,
    //   but with its own extractor - it is dispatched through `/v1/chat/completions` (see the URL-construction
    //   switch below), a materially different, OpenAI CHAT-completions-shaped delta stream
    //   (`data: {"choices":[{"delta":{"content": "..."}}]}`), not the TEXT-completions shape every
    //   other api_type above uses. This is a real, pre-existing oddity of this "text completions"
    //   file (OPENROUTER's streamed reply is chat-shaped despite going through here) - noted, not
    //   fixed, since fixing THAT is out of this task's scope; only its OWN correct shape is parsed.
    // - OLLAMA: PERSISTS FOR REAL. `parseOllamaStream()` already parses each JSON-lines chunk for its
    //   own SSE re-shaping (`json.response`) - that same real per-chunk text is now also accumulated
    //   and persisted once the stream ends (or the client disconnects early, in which case whatever
    //   was generated so far is persisted as a partial reply).
    // - LLAMACPP: PERSISTS FOR REAL. `pipeLlamaCppCompactStream()` (llamacpp-compact-stream.js)
    //   already fully JSON-parses every upstream SSE event into a structured `data` object (to
    //   re-encode it into its own compact wire format) - `data.content` is the exact same real
    //   per-chunk text llama.cpp itself sends, so it's accumulated there too, with zero change to
    //   the compact format it emits to the client.
    // Every wire format reachable by this route is covered - there is no remaining streaming
    // api_type left un-persisted for the raw-action case.
    let pendingAssistantPersist = null;

    // Set only by the raw-action branch below (buildRawActionTextCompletionRequest()'s own
    // `itemization` field - see that function's doc comment) - `null` for every other branch
    // (connection-profile, default/legacy), same scoping reason as `pendingAssistantPersist` above:
    // read by both the non-streaming response branch and the streaming branches further down.
    let rawActionItemization = null;

    // Per-request warnings for the screen (dropped entries, estimate trims, tokenizer fallbacks),
    // covering every branch below and not gated on persistence like `rawActionItemization` is.
    // Sent as its own `{control: {warnings}}` frame on a stream and as `data.warnings` on a
    // non-streaming reply, only when non-empty - so a reply with no warnings is byte-identical.
    /** @type {Array<{kind: string, key: string, message: string, entries?: string[]}>} */
    const warnings = [];

    // The raw-action build's counts and ids, stored once the backend has the request.
    /** @type {import('../../token-count-store.js').PendingTokenRows | null} */
    let tokenCountRows = null;
    const storeTokenCountRows = () => {
        if (!tokenCountRows) return;
        writeBack(request.user.directories, tokenCountRows)
            .catch(error => console.error('Failed to store token counts:', error));
    };

    try {
        // "Generate using connection profile X" - the raw action is the profile id plus the raw
        // messages/generation-type facts; the server resolves the profile's backend, preset, and
        // instruct template itself instead of the client pre-resolving and asserting them.
        if (request.body.connection_profile_id) {
            const { profile, selectedApiMap } = resolveConnectionProfile(request.user.directories, request.body.connection_profile_id);
            if (selectedApiMap.selected !== 'textgenerationwebui') {
                return response.status(400).send({ error: true, message: `Profile does not target a text completion backend (targets: ${selectedApiMap.selected})` });
            }

            const { name1 = '', name2 = '', isGroup = false, messages, max_tokens: maxTokens, isImpersonate = false, isContinue = false, type = 'quiet' } = request.body;
            if (!Array.isArray(messages)) {
                return response.status(400).send({ error: true, message: 'messages must be an array' });
            }

            const instructPreset = profile.instruct ? readPresetByName('instruct', profile.instruct, request.user.directories) : null;
            const contextPreset = profile.context ? readPresetByName('context', profile.context, request.user.directories) : null;
            const finalPrompt = instructPreset
                ? constructPrompt(messages, instructPreset, { name1, name2, isGroup })
                : messages.map(m => m.content).join('\n\n');
            const stoppingStrings = instructPreset
                ? getInstructStoppingSequences(instructPreset, contextPreset ?? {}, { name1, name2 })
                : [];

            const { 'textgenerationwebui_settings': baseSettings, power_user: powerUser = {} } = readSettingsAtPaths(request.user.directories, ['textgenerationwebui_settings', 'power_user']);
            const preset = profile.preset ? readPresetByName('textgenerationwebui', profile.preset, request.user.directories) : null;
            const settings = mergeTextGenPreset({ ...baseSettings, type: selectedApiMap.type }, preset);

            const apiServerUrl = profile['api-url'] || resolveServerUrl(settings);

            // The profile's own backend and tokenizer, not the main connection's.
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

            // Optional sampler-field overrides for this one call (e.g. a caller that wants a
            // specific temperature without a whole separate profile/preset). Deliberately excludes
            // routing (api_type/api_server/model) and the just-built prompt/stop-strings - those
            // stay server-resolved, never client-asserted.
            if (request.body.overrides && typeof request.body.overrides === 'object' && !Array.isArray(request.body.overrides)) {
                Object.assign(params, _.omit(request.body.overrides, ['api_type', 'api_server', 'model', 'prompt', 'stop', 'stopping_strings']));
            }

            // Replace the body entirely - none of the raw action fields (messages, name1/name2,
            // connection_profile_id, etc.) are part of the actual backend request shape.
            const stream = !!request.body.stream;
            request.body = { ...params, stream, api_type: selectedApiMap.type, api_server: apiServerUrl };
        // "Generate for this character/group's chat" - the raw action is WHICH character/group,
        // WHICH branch/node in that conversation tree to generate from, and the LITERAL text the
        // user typed this turn (or nothing, for a continue/swipe) - the server resolves the active
        // backend, tokenizer, prompt assembly, and final backend-request shape entirely itself. See
        // buildRawActionTextCompletionRequest() above for the full resolution pipeline. Field names
        // are deliberately NOT modeled on the connection-profile branch above (no profile/messages/
        // name1/name2 here) - this is the first real instance of this effort's target shape, so
        // names match what these fields literally are.
        } else if (request.body.owner_id && (request.body.character_avatar || request.body.group_id)) {
            // `node_id` is destructured straight off the parsed JSON body (not defaulted) so its
            // "absent key" vs "explicit null" distinction survives intact: real JSON has no
            // `undefined` literal, so a request that never included `node_id` at all yields
            // `undefined` here, while `"node_id": null` yields `null` - these two are NOT the same
            // thing (see buildRawActionTextCompletionRequest()'s own ADDRESSING MODEL doc comment) and
            // that function itself validates/rejects `undefined`, rather than this route handler
            // pre-filtering it, so a caller that invokes it directly (e.g. tests) gets the same
            // validation. There is no `branch_name` field anymore - see that same doc comment for why.
            const {
                character_avatar: characterAvatar, group_id: groupId, owner_id: ownerId,
                node_id: nodeId, type = 'normal',
                user_message: userMessageText,
            } = request.body;
            // Server-validated (NOT trusted verbatim) - see `sanitizeUserMessageExtra()`'s own doc
            // comment (message-tree-db.js) for the exact allowlisted shape. The client only ever sends
            // a REFERENCE to a file/media attachment it already uploaded via the existing
            // `/api/files/upload`/`saveBase64AsFile()` flow (public/scripts/chats.js's
            // `populateFileAttachment()`) - never file bytes - but that reference is still
            // client-controlled input from here on, so it goes through the same allowlist regardless
            // of what the client actually sent.
            const userMessageExtra = sanitizeUserMessageExtra(request.body.user_message_extra);
            // is_impersonate/is_continue/is_swipe are NOT read from the wire - each is 100% derivable
            // from `type` alone (they used to be sent as separate, redundant boolean fields alongside
            // it - the exact same "the client sends a derived classification instead of letting the
            // server infer it from the one raw fact it already sent" anti-pattern this whole effort
            // exists to eliminate). Derived here instead, matching the client's own real derivation
            // (public/script.js): `isImpersonate = type == 'impersonate'`, `isContinue = type ==
            // 'continue'`, `isSwipe = type == 'swipe' || type == 'regenerate'`.
            const isImpersonate = type === 'impersonate';
            const isContinue = type === 'continue';
            const isSwipe = type === 'swipe' || type === 'regenerate';

            const directories = request.user.directories;

            /** @type {Awaited<ReturnType<typeof buildRawActionTextCompletionRequest>>} */
            let built;
            try {
                built = await buildRawActionTextCompletionRequest(directories, {
                    request, characterAvatar, groupId, ownerId, nodeId,
                    type, isImpersonate, isContinue, isSwipe, userMessageText, userMessageExtra,
                });
            } catch (error) {
                console.error('Failed to build raw-action text completion request:', error);
                return response.status(400).send({ error: true, message: error?.message ?? 'Could not resolve this generation request' });
            }
            warnings.push(...built.warnings);
            tokenCountRows = built.tokenCountRows;

            // Persist the NEW USER MESSAGE - "the user sent this" - BEFORE dispatching to the
            // backend. This is a real fact that should be committed regardless of whether
            // generation itself succeeds afterward, so it's done for real here, not deferred.
            //
            // NEITHER side of this turn is persisted for `is_impersonate`/`type === 'quiet'`:
            // - impersonate generates what the user MIGHT say - it is never a real submitted user
            //   message, and its output is written back into the client's send textarea, never the
            //   chat, so it must never appear as a bogus assistant message either.
            // - quiet generations are meta/background - they must never touch the visible tree on
            //   either side.
            // In practice a caller has no real user text to send for either of these types anyway
            // (`user_message` is only ever populated by the client for a genuine new chat turn), but
            // the user-message skip below is defensive: even if a caller passed `user_message`
            // alongside `is_impersonate`/`type: 'quiet'`, it is not committed.
            //
            // The ASSISTANT's reply (for every other, non-skipped type) is persisted further down,
            // once the full generated text is known - see `pendingAssistantPersist`, set a few
            // lines below, and read by BOTH the non-streaming response branch and the streaming
            // branches (see that variable's own declaration comment above for exactly which
            // streaming api_types persist for real).
            // The reply, once persisted, must chain onto whatever node is actually the new leaf
            // after this block - the just-appended user message's node when one was appended,
            // otherwise `built.anchorNodeId` unchanged (continue/swipe/regenerate, which add no new
            // message - a swipe/regenerate REPLACES the anchor with a sibling instead, see below).
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

            // Stash what's needed to persist the ASSISTANT's reply once the (non-streaming)
            // response is known - read only by the non-streaming response branch below, guarded by
            // `if (pendingAssistantPersist)`, so this has no effect on the streaming branches (see
            // the comment on this variable's declaration above). Left `null` (its declared default)
            // for `is_impersonate`/`type === 'quiet'`, so the non-streaming branch never appends the
            // generated reply to the tree for either - the generated text still reaches the client
            // unchanged via the normal response below, it just never gets persisted.
            //
            // `isSwipe` is carried through so the non-streaming branch below knows to persist the
            // reply as a SIBLING alternative under the anchor's PARENT (via `addAlternatives()`) -
            // matching real swipe/regenerate tree semantics - instead of a CHILD after the anchor
            // (via `appendMessages()`, correct only for a genuinely new turn). `is_swipe` is the
            // client's own single flag for BOTH `type === 'swipe'` and `type === 'regenerate'` (see
            // public/script.js's `isSwipe` local and this session's task write-up) - both need the
            // identical tree operation here, so this route does not re-derive it from `type` itself.
            //
            // `isContinue`/`anchorContent` are carried through so the non-streaming branch below knows
            // to persist the reply as an IN-PLACE EDIT of the anchor node's own text (via
            // `editMessage()`) instead of appending/adding a sibling or child - a continue never
            // introduces a new node, it lengthens the existing leaf's `mes`. `anchorContent` is the
            // anchor's CURRENT full content (see `buildRawActionTextCompletionRequest()`'s own doc
            // comment on this field) - needed here because `editMessage()` replaces the WHOLE stored
            // content, not just `.mes` (see message-tree-db.js's `editMessageSync()`/
            // `sanitizeForStorage()`), so the reply text must be spliced into a full copy of the
            // existing message object, not sent alone.
            //
            // REAL EDGE CASE found and guarded against (not hypothetical): public/script.js's own
            // `Generate()` does NOT exclude `type === 'continue'` from its "read+clear the send
            // textarea as this turn's `user_message`" condition (only 'regenerate'/'swipe'/'quiet'/
            // impersonate/dryRun/depth>0 are excluded there) - so a user who leaves text in the box and
            // clicks Continue DOES send it as a genuine new user message, same as any other type. If
            // that happened, `replyAnchorNodeId` above was just advanced to that BRAND NEW user node -
            // editing it with the OLD assistant's content (`anchorContent`, resolved before that append
            // ran) would corrupt the wrong node. This is bounded to CONTINUE-ONLY (swipe/regenerate/
            // impersonate/quiet already can't reach here with a real `userMessageText`), so the guard
            // needs to special-case it: skip persisting the ASSISTANT'S REPLY ENTIRELY (not just fall
            // back to a plain appendMessages(), which would be its own new bug - the generated text for
            // a continue is only a CONTINUATION FRAGMENT of the old leaf, not a complete reply, so
            // appending it as a brand-new child after the just-added user message would read as
            // incoherent, fragment-shaped nonsense) whenever a user message was actually appended
            // alongside a continue - detected by `built.anchorNodeId` (the anchor BEFORE any append) no
            // longer equaling `replyAnchorNodeId` in that case. Nothing NEW is lost by skipping: this
            // combination was already a pre-existing, independent client-side oddity before this task
            // (public/script.js's own `saveReply({type: 'appendFinal'})` reads `chat[chat.length - 1]`
            // too, which by then is that SAME just-appended user message, not the real assistant leaf -
            // so the legacy path was already not doing anything coherent for this combination either).
            // The user message itself is still committed either way (matching every other type's real
            // `user_message` handling) - only the reply's persistence is skipped; the raw generated text
            // still reaches the client unchanged via the normal response, exactly like every other
            // skipped-persistence case above.
            const continueUserTextConflict = isContinue && replyAnchorNodeId !== built.anchorNodeId;
            if (!skipPersistence && !continueUserTextConflict) {
                pendingAssistantPersist = {
                    directories, ownerId, anchorNodeId: replyAnchorNodeId, name2: built.name2,
                    isSwipe, isContinue, anchorContent: built.anchorContent,
                };
                // Same gating as `pendingAssistantPersist` above, not unconditional on `built.itemization`
                // existing - impersonate/quiet/the continue-text-conflict case must still reach the
                // client completely unmodified (see this block's own comment above), matching how
                // `data.assistant_node_id` below is likewise only ever set when persistence itself ran.
                rawActionItemization = built.itemization;
            }

            // Replace the body entirely - mirrors the connection-profile branch's own final
            // assignment shape exactly, so the existing downstream dispatch code below is
            // completely unaware of which branch produced request.body.
            const stream = !!request.body.stream;
            request.body = { ...built.params, stream, api_type: built.backend.type, api_server: built.backend.serverUrl };
        }

        // No api_type means this is the main chat flow, which no longer sends one - resolve the
        // active backend from the server's own settings.json instead. A request that DOES specify
        // one is a legitimate per-request override (e.g. a Connection Manager profile targeting a
        // different backend than the user's main one) and is left exactly as it arrives.
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

        const controller = new AbortController();
        request.socket.removeAllListeners('close');
        request.socket.on('close', async function () {
            // A raw-action (persisted) generation deliberately keeps running/buffering after the
            // client disconnects instead of being aborted here - see llamacpp-compact-stream.js's
            // module doc comment and forwardAndPersistCompactStream()'s own onSocketClose above for
            // why: it's what makes GET /generate/resume/:id able to serve a live continuation rather
            // than just a truncated partial. Only a non-raw-action stream (pendingAssistantPersist
            // unset - quiet generations, connection-profile tests, etc., none of which are
            // resumable) still aborts the upstream request immediately on disconnect.
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
            parseOllamaStream(stream, request, response, pendingAssistantPersist, rawActionItemization, warnings);
        } else if (request.body.stream) {
            const completionsStream = await fetch(url, args);
            storeTokenCountRows();
            if (request.body.api_type === TEXTGEN_TYPES.LLAMACPP) {
                // Compact wire format for the llama.cpp raw-completions path only - see llamacpp-compact-stream.js.
                await pipeLlamaCppCompactStream(completionsStream, response, pendingAssistantPersist, rawActionItemization, warnings);
            } else if (request.body.api_type === TEXTGEN_TYPES.OPENROUTER) {
                // OPENROUTER is dispatched through /v1/chat/completions (see the URL-construction
                // switch above), even though this file is nominally the TEXT-completions backend -
                // its streamed chunks are therefore OpenAI CHAT-completions-shaped deltas
                // (`choices[0].delta.content`), a materially different shape from every other
                // api_type reaching this branch (`choices[0].text`). Given its own extractor rather
                // than folded into the generic branch below.
                await forwardAndPersistCompactStream(completionsStream, response, pendingAssistantPersist, json => json?.choices?.[0]?.delta?.content, null, rawActionItemization, warnings);
            } else {
                // Pipe remote SSE stream to Express response as the compact binary wire format,
                // tapping the OpenAI TEXT-completions-shaped `choices[0].text` field for raw-action
                // persistence - see forwardAndPersistCompactStream()'s own doc comment above.
                // `pendingAssistantPersist` being null (connection_profile_id and legacy/default
                // calls) only skips persistence; the client still gets the same compact-v1 stream.
                await forwardAndPersistCompactStream(completionsStream, response, pendingAssistantPersist, json => json?.choices?.[0]?.text, null, rawActionItemization, warnings);
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

                // Persist the ASSISTANT's reply for the raw-action branch (see
                // `pendingAssistantPersist`'s declaration above) - only reached for a real,
                // successful (completionsReply.ok) NON-STREAMING generation, so nothing speculative
                // ever gets committed. Only set when the raw-action branch ran; a no-op otherwise.
                // The actual plain/continue/swipe persistence branching lives in
                // `persistAssistantReply()` (../../assistant-reply-persist.js), shared with the
                // streaming branches above - see that module's own doc comment for the full
                // continue/`continue_mag`/`editMessage()` and swipe/`addAlternatives()`+
                // `selectDefaultChild()` rationale (unchanged from this route's own original design).
                if (pendingAssistantPersist) {
                    const generatedText = replyTextAsPageShows(data, 'textgenerationwebui');
                    const persisted = await persistAssistantReply(pendingAssistantPersist, generatedText);
                    if (persisted) {
                        data.assistant_node_id = persisted.node_id;
                    }
                }

                // Raw-action prompt-itemization breakdown - see buildRawActionTextCompletionRequest()'s
                // own `itemization` field. Attached regardless of `pendingAssistantPersist` (impersonate/
                // quiet raw-action calls skip persistence but are harmless to include this on; the
                // client only ever reads it for a real, itemized assistant message).
                if (rawActionItemization) {
                    data.itemization = rawActionItemization;
                }
                if (warnings.length) {
                    data.warnings = warnings;
                }

                return response.send(data);
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
        console.error('Endpoint error:', error);

        return !response.headersSent
            ? response.send(value)
            : response.end();
    }
});

/** Final-event metadata (prompt, generation_settings, timings, etc.) for a compact llama.cpp stream, keyed by its `X-Generation-Id`. */
router.get('/generate/meta/:id', function (request, response) {
    const meta = getLlamaCppStreamMeta(request.params.id);

    if (!meta) {
        return response.sendStatus(404);
    }

    return response.json(meta);
});

/**
 * Resumes a dropped raw-action compact stream from a client-supplied byte offset (`?from=`) - see
 * llamacpp-compact-stream.js's handleGenerationResume() for the full behavior/response shapes.
 * Mounted here AND on chat-completions.js's router (both delegate to the same shared generation
 * buffer, keyed by `X-Generation-Id`, regardless of which backend produced it), so the client
 * doesn't need to know which backend originated a given generation id to resume it.
 */
router.get('/generate/resume/:id', handleGenerationResume);

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
