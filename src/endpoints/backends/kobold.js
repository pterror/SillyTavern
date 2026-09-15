import fs from 'node:fs';
import express from 'express';
import fetch from 'node-fetch';

import { delay } from '../../util.js';
import { getOverrideHeaders, setAdditionalHeaders, setAdditionalHeadersByType } from '../../additional-headers.js';
import { TEXTGEN_TYPES } from '../../constants.js';
import { readSettingsAtPaths } from '../../settings-store.js';
import { resolveTokenizerType, encodeWithTokenizerType } from '../../tokenizer-resolve.js';
import { resolveTextCompletionGenerationInput } from '../../text-completion-generation-input.js';
import { assembleTextCompletionPrompt } from '../../text-completion-prompt-orchestrator.js';
import { getAncestorPath, appendMessages, sanitizeUserMessageExtra } from '../../message-tree-db.js';
import { readCardContent } from '../characters.js';
import { getGroupsByIds } from '../groups.js';
import { persistAssistantReply } from '../../assistant-reply-persist.js';
import { forwardAndPersistCompactStream } from './text-completions.js';

export const router = express.Router();

/**
 * Real, tested raw-action request builder for the Kobold family (main_api === 'kobold' - NOT
 * 'koboldhorde', see src/text-completion-generation-input.js's own doc comment for why Horde is
 * excluded). Directly mirrors src/endpoints/backends/text-completions.js's own
 * `buildRawActionTextCompletionRequest()` (see `git show ac42ce8c9` for the original design this
 * follows) - same field names, same resolution pipeline
 * (resolveTextCompletionGenerationInput()+assembleTextCompletionPrompt(), now dispatching to
 * createKoboldGenerationData() for real per text-completion-prompt-orchestrator.js's own Step 16
 * update) - the two differences from the textgenerationwebui version are:
 * - No `resolveTextGenBackend()` call: Kobold's own backend URL (`kai_settings.api_server`) is
 *   already resolved BY the orchestrator itself (via `assembleTextCompletionPrompt()`'s own
 *   `apiServer` input, forwarded through resolveTextCompletionGenerationInput()) and lands directly
 *   on the returned `generate_data.api_server` field (createKoboldGenerationData()'s own
 *   `api_server` wire field) - there is no separate "backend" object to return here, unlike the
 *   textgenerationwebui/`api_type`+`api_server` pair.
 * - Tokenizer resolution passes `forApi: 'kobold'` (not the default 'textgenerationwebui') to
 *   resolveTokenizerType() and `canUseTokenization: false` - Kobold's own tokenize capability
 *   (`kai_flags.can_use_tokenization`, gating `tokenizers.API_KOBOLD`) is a LIVE version-probe
 *   result (see kai-settings.js's checkStatusKobold()), the exact same "don't trigger a live
 *   network call as a side effect of pure request-building" concern already established for
 *   koboldFlags itself (see the orchestrator's own doc comment) - so this always falls back to a
 *   local tokenizer (typically `tokenizers.LLAMA`, getTokenizerBestMatch()'s own generic
 *   kobold/textgenerationwebui fallback) rather than attempting the remote Kobold tokenize
 *   endpoint. This only affects `countTokens`'s own budget-fitting accuracy (createKoboldGenerationData()
 *   itself never calls `encodeTokens` at all - Kobold has no token-id-based ban/bias mechanism, see
 *   text-completion-generation-input.js's own doc comment) - a real, narrower approximation than a
 *   live-probed tokenizer would give, flagged here rather than silently assumed exact.
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {object} params
 * @param {import('express').Request} [params.request]
 * @param {string} [params.characterAvatar]
 * @param {string} [params.groupId]
 * @param {string} params.ownerId
 * @param {string|null} params.nodeId REQUIRED (`undefined` throws) - see
 * src/endpoints/backends/text-completions.js's `buildRawActionTextCompletionRequest()` own
 * ADDRESSING MODEL doc comment for the full rationale this mirrors verbatim: a real node id string
 * addresses that specific existing node; `null` asserts "this is a genuinely new, empty
 * conversation" and only succeeds when that is actually true (checked via
 * `resolveTextCompletionGenerationInput()`'s own `chatResolutionAmbiguous`/`resolvedNodeId`, read
 * back below). There is no `branchName`/`branch_name` field in this raw-action surface anymore.
 * @param {string} [params.type]
 * @param {boolean} [params.isImpersonate]
 * @param {boolean} [params.isContinue]
 * @param {boolean} [params.isSwipe]
 * @param {string} [params.userMessageText]
 * @param {object} [params.userMessageExtra] Already-SERVER-VALIDATED `extra` (see
 * `sanitizeUserMessageExtra()` in message-tree-db.js) for the new user message being appended -
 * identical contract to buildRawActionTextCompletionRequest()'s own equivalent param. Kobold has no
 * media/image inlining (that machinery is chat-completion-specific) - only `.files` is ever actually
 * read downstream (file-attachment-inline.js, via resolveTextCompletionGenerationInput()); `.media`
 * is harmlessly ignored if forwarded.
 * @param {object} [params.macroExtras] Forwarded verbatim to resolveTextCompletionGenerationInput()'s
 * own `macroExtras` (shallow-merged over its resolved input object, caller wins). Added so
 * src/endpoints/horde.js's own raw-action /generate-text branch can reuse this SAME builder for
 * Horde (main_api === 'koboldhorde') by passing `{ isHorde: true }` - createKoboldGenerationData()'s
 * real `isHorde` flag (src/kobold-generation-data.js) already produces the correct payload shape for
 * Horde too, it was just never threaded through here. Defaults to `{}` - existing callers/tests
 * (which never pass this) keep their exact prior behavior.
 * @returns {Promise<{ params: object, anchorNodeId: string|null, anchorContent: object|null, name1: string, name2: string }>}
 */
export async function buildRawActionKoboldRequest(directories, {
    request, characterAvatar, groupId, ownerId, nodeId,
    type = 'normal', isImpersonate = false, isContinue = false, isSwipe = false, userMessageText, userMessageExtra,
    tokenizerOptions = {}, macroExtras = {},
} = {}) {
    if (!ownerId) {
        throw new Error('owner_id is required');
    }
    if (!characterAvatar && !groupId) {
        throw new Error('character_avatar or group_id is required');
    }
    // See src/endpoints/backends/text-completions.js's `buildRawActionTextCompletionRequest()` own
    // ADDRESSING MODEL doc comment - `undefined` means the request body never had the `node_id` key
    // at all (JSON has no `undefined` literal, so this is distinguishable from an explicit `null`).
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

    const { power_user: powerUser = {} } = readSettingsAtPaths(directories, ['power_user']);
    const tokenizerType = resolveTokenizerType({
        userTokenizerSetting: powerUser.tokenizer, forApi: 'kobold', canUseTokenization: false,
    });
    const encodeTokens = (text) => encodeWithTokenizerType(tokenizerType, text, { request, ...tokenizerOptions });
    const countTokens = async (text) => (await encodeTokens(text)).length;

    const orchestratorInput = await resolveTextCompletionGenerationInput(directories, {
        avatar: characterAvatar, groupId, mainApi: 'kobold', ownerId, nodeId,
        type, isImpersonate, isContinue, isSwipe, userMessageText, userMessageExtra,
        countTokens, encodeTokens, macroExtras,
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

router.post('/generate', async function (request, response_generate) {
    if (!request.body) return response_generate.sendStatus(400);

    // Real raw-action cutover - "generate for this character/group's chat" - see
    // buildRawActionKoboldRequest() above and src/endpoints/backends/text-completions.js's own
    // identically-shaped branch for the full design precedent this mirrors. Same trigger condition,
    // same field names (character_avatar/group_id/owner_id/node_id/type/is_impersonate/
    // is_continue/is_swipe/user_message) - there is no `branch_name` field (see
    // buildRawActionKoboldRequest()'s own ADDRESSING MODEL doc comment). `node_id` is destructured
    // straight off the parsed body, not defaulted, so the "key absent" (`undefined`) vs. "explicit
    // null" distinction survives intact.
    let pendingAssistantPersist = null;
    if (request.body.owner_id && (request.body.character_avatar || request.body.group_id)) {
        const {
            character_avatar: characterAvatar, group_id: groupId, owner_id: ownerId,
            node_id: nodeId, type = 'normal',
            user_message: userMessageText, streaming: streamingRequested = false,
            can_abort: canAbortRequested = false,
        } = request.body;
        // Server-validated (NOT trusted verbatim) - see `sanitizeUserMessageExtra()`'s own doc
        // comment (message-tree-db.js) and text-completions.js's identical raw-action branch. Only
        // `.files` is meaningfully consumed downstream for Kobold (no media/image inlining here - see
        // buildRawActionKoboldRequest()'s own doc comment on this param).
        const userMessageExtra = sanitizeUserMessageExtra(request.body.user_message_extra);
        // is_impersonate/is_continue/is_swipe are NOT read from the wire - each is 100% derivable
        // from `type` alone - matching text-completions.js's/chat-completions.js's own identical
        // derivation (commit 4a79e197e), extended here to Kobold since the client-side cleanup
        // (job 2 of this task) removes these three redundant booleans for every raw-action backend,
        // not just those two.
        const isImpersonate = type === 'impersonate';
        const isContinue = type === 'continue';
        const isSwipe = type === 'swipe' || type === 'regenerate';

        const directories = request.user.directories;

        let built;
        try {
            built = await buildRawActionKoboldRequest(directories, {
                request, characterAvatar, groupId, ownerId, nodeId,
                type, isImpersonate, isContinue, isSwipe, userMessageText, userMessageExtra,
            });
        } catch (error) {
            console.error('Failed to build raw-action Kobold request:', error);
            return response_generate.status(400).send({ error: true, message: error?.message ?? 'Could not resolve this generation request' });
        }

        // Same three-mode persistence contract as text-completions.js's own raw-action branch - see
        // that file's own extensive comment on impersonate/quiet skipping, the swipe/regenerate
        // sibling-vs-child distinction, and the continue/userMessageText tree-shape edge case. Not
        // re-derived here; identical reasoning applies verbatim since both routes share the exact
        // same resolveTextCompletionGenerationInput()/message-tree-db.js persistence primitives.
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

        // Replace the body entirely - `built.params` already carries `api_server`
        // (createKoboldGenerationData()'s own wire field, sourced from the orchestrator's real
        // `kai_settings.api_server` resolution) - the existing dispatch code below is completely
        // unaware of which branch produced request.body, same as text-completions.js's own pattern.
        //
        // `streaming` is overridden here from the CLIENT's own originally-requested value
        // (`streamingRequested`, captured above BEFORE this reassignment discards the rest of the
        // original request.body) - same "trust the client's own streaming preference" pattern
        // text-completions.js's own raw-action branch already uses for `stream: !!request.body.stream`
        // (see `const stream = !!request.body.stream; request.body = { ...built.params, stream, ... }`
        // there). This is REQUIRED, not just belt-and-suspenders: `built.params.streaming` (from
        // createKoboldGenerationData(), src/kobold-generation-data.js) computes
        // `koboldSettings.streaming_kobold && koboldFlags.can_use_streaming && type !== 'quiet'`, but
        // buildRawActionKoboldRequest() above never passes a `koboldFlags` argument through to
        // resolveTextCompletionGenerationInput()/assembleTextCompletionPrompt() at all, so it defaults
        // to `{}` - meaning `built.params.streaming` is ALWAYS `false` server-side, regardless of the
        // client's real setting (there is no live "can this Kobold backend stream" probe result
        // available server-side to compute this correctly - it only exists client-side, as
        // `kai_flags.can_use_streaming`, from the client's own connection-time version probe). Without
        // this override, the dispatch check a few lines below (`request.body.streaming ? '.../stream'
        // : '.../v1/generate'`) would ALWAYS pick the non-streaming endpoint for every raw-action
        // request, even one whose client-computed `streaming` field (see public/script.js's
        // `rawActionGenerateData` construction) correctly said `true`.
        //
        // `can_abort` is overridden here for the identical reason and via the identical pattern -
        // captured from the client's real requested value (`canAbortRequested`, destructured above
        // alongside `streamingRequested`) BEFORE this same reassignment would otherwise discard it.
        // built.params.can_abort (from createKoboldGenerationData()) is computed as JUST
        // `koboldFlags.can_use_streaming` (verified by reading that file - a SIMPLER real condition
        // than `streaming`'s three terms, with no `koboldSettings.streaming_kobold` or `type !==
        // 'quiet'` term), but since buildRawActionKoboldRequest() never passes a real `koboldFlags`
        // value through (same as for `streaming`), it defaults to `{}` and built.params.can_abort is
        // unconditionally `false`. Without this override, the socket-close handler a few lines below
        // (`if (request.body.can_abort && !response_generate.writableEnded) { ... }`) would never fire
        // its abort-on-disconnect call to the real Kobold backend for ANY raw-action request, even one
        // whose client-computed `can_abort` (see public/script.js's `rawActionGenerateData`
        // construction) correctly said `true` - leaving the backend generating uselessly after the
        // client has already gone away.
        request.body = { ...built.params, streaming: !!streamingRequested, can_abort: !!canAbortRequested };
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
                console.info('Aborting Kobold generation...');
                // send abort signal to koboldcpp
                const abortResponse = await fetch(`${request.body.api_server}/extra/abort`, {
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
            const response = await fetch(url, { method: 'POST', ...args });

            if (request.body.streaming) {
                // Re-encode Kobold's own SSE data payload shape (`{"token": "..."}`, verified against
                // generateKoboldWithStreaming() in public/scripts/kai-settings.js) into the same
                // compact binary wire format every streaming path uses, raw-action or not (see
                // text-completions.js's forwardAndPersistCompactStream() doc comment) -
                // `pendingAssistantPersist` only gates whether the final text also gets persisted.
                await forwardAndPersistCompactStream(response, response_generate, pendingAssistantPersist, json => json?.token);
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

                // Persist the ASSISTANT's reply for the raw-action branch (see
                // `pendingAssistantPersist`'s declaration above) - only reached for a real,
                // successful (response.ok) NON-STREAMING generation. `/v1/generate`'s real
                // response shape is `{results: [{text: "..."}]}` (verified against
                // public/script.js's own `data.results[0].text` read of this exact endpoint).
                if (pendingAssistantPersist) {
                    const generatedText = data?.results?.[0]?.text ?? '';
                    const persisted = await persistAssistantReply(pendingAssistantPersist, generatedText);
                    if (persisted) data.assistant_node_id = persisted.node_id;
                }

                return response_generate.send(data);
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

    const result = {};

    /** @type {any} */
    const [koboldUnitedResponse, koboldExtraResponse, koboldModelResponse] = await Promise.all([
        // We catch errors both from the response not having a successful HTTP status and from JSON parsing failing

        // Kobold United API version
        fetch(`${api_server}/v1/info/version`).then(response => {
            if (!response.ok) throw new Error(`Kobold API error: ${response.status, response.statusText}`);
            return response.json();
        }).catch(() => ({ result: '0.0.0' })),

        // KoboldCpp version
        fetch(`${api_server}/extra/version`).then(response => {
            if (!response.ok) throw new Error(`Kobold API error: ${response.status, response.statusText}`);
            return response.json();
        }).catch(() => ({ version: '0.0' })),

        // Current model
        fetch(`${api_server}/v1/model`).then(response => {
            if (!response.ok) throw new Error(`Kobold API error: ${response.status, response.statusText}`);
            return response.json();
        }).catch(() => null),
    ]);

    result.koboldUnitedVersion = koboldUnitedResponse.result;
    result.koboldCppVersion = koboldExtraResponse.result;
    result.model = !koboldModelResponse || koboldModelResponse.result === 'ReadOnly' ?
        'no_connection' :
        koboldModelResponse.result;

    response.send(result);
});

router.post('/transcribe-audio', async function (request, response) {
    try {
        const server = request.body.server;

        if (!server) {
            console.error('Server is not set');
            return response.sendStatus(400);
        }

        if (!request.file) {
            console.error('No audio file found');
            return response.sendStatus(400);
        }

        console.debug('Transcribing audio with KoboldCpp', server);

        const fileBase64 = fs.readFileSync(request.file.path).toString('base64');
        fs.unlinkSync(request.file.path);

        const headers = {};
        setAdditionalHeadersByType(headers, TEXTGEN_TYPES.KOBOLDCPP, server, request.user.directories);

        const url = new URL(server);
        url.pathname = '/api/extra/transcribe';

        const result = await fetch(url, {
            method: 'POST',
            headers: {
                ...headers,
            },
            body: JSON.stringify({
                prompt: '',
                audio_data: fileBase64,
            }),
        });

        if (!result.ok) {
            const text = await result.text();
            console.error('KoboldCpp request failed', result.statusText, text);
            return response.status(500).send(text);
        }

        const data = await result.json();
        console.debug('KoboldCpp transcription response', data);
        return response.json(data);
    } catch (error) {
        console.error('KoboldCpp transcription failed', error);
        response.status(500).send('Internal server error');
    }
});

router.post('/embed', async function (request, response) {
    try {
        const { server, items } = request.body;

        if (!server) {
            console.warn('KoboldCpp URL is not set');
            return response.sendStatus(400);
        }

        const headers = {};
        setAdditionalHeadersByType(headers, TEXTGEN_TYPES.KOBOLDCPP, server, request.user.directories);

        const embeddingsUrl = new URL(server);
        embeddingsUrl.pathname = '/api/extra/embeddings';

        const embeddingsResult = await fetch(embeddingsUrl, {
            method: 'POST',
            headers: {
                ...headers,
            },
            body: JSON.stringify({
                input: items,
            }),
        });

        /** @type {any} */
        const data = await embeddingsResult.json();

        if (!Array.isArray(data?.data)) {
            console.warn('KoboldCpp API response was not an array');
            return response.sendStatus(500);
        }

        const model = data.model || 'unknown';
        const embeddings = data.data.map(x => Array.isArray(x) ? x[0] : x).sort((a, b) => a.index - b.index).map(x => x.embedding);
        return response.json({ model, embeddings });
    } catch (error) {
        console.error('KoboldCpp embedding failed', error);
        response.status(500).send('Internal server error');
    }
});
