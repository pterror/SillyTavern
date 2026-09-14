import { Readable } from 'node:stream';
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
import { pipeLlamaCppCompactStream, getLlamaCppStreamMeta } from './llamacpp-compact-stream.js';
import { resolveTextGenBackend, resolveServerUrl } from '../../textgen-backend-resolve.js';
import { resolveConnectionProfile } from '../../connection-profile-resolve.js';
import { mergeTextGenPreset } from '../../textgen-preset-merge.js';
import { createTextGenGenerationData } from '../../textgen-generation-data.js';
import { constructPrompt, getInstructStoppingSequences } from '../../instruct-template-format.js';
import { readSettingsAtPaths } from '../../settings-store.js';
import { readPresetByName } from '../presets.js';
import { resolveTokenizerType, encodeWithTokenizerType } from '../../tokenizer-resolve.js';
import { resolveTextCompletionGenerationInput } from '../../text-completion-generation-input.js';
import { assembleTextCompletionPrompt } from '../../text-completion-prompt-orchestrator.js';
import { loadBranch, getAncestorPath, appendMessages } from '../../message-tree-db.js';
import { readCardContent } from '../characters.js';
import { getGroupsByIds } from '../groups.js';

export const router = express.Router();

/**
 * Special boy's steaming routine. Wrap this abomination into proper SSE stream.
 * @param {import('node-fetch').Response} jsonStream JSON stream
 * @param {import('express').Request} request Express request
 * @param {import('express').Response} response Express response
 * @returns {Promise<any>} Nothing valuable
 */
async function parseOllamaStream(jsonStream, request, response) {
    try {
        if (!jsonStream.body) {
            throw new Error('No body in the response');
        }

        let partialData = '';
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
                const chunk = { choices: [{ text, thinking }] };
                response.write(`data: ${JSON.stringify(chunk)}\n\n`);
                partialData = '';
            }
        });

        request.socket.on('close', function () {
            if (jsonStream.body instanceof Readable) jsonStream.body.destroy();
            response.end();
        });

        jsonStream.body.on('end', () => {
            response.write('data: [DONE]\n\n');
            response.end();
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
        let url = baseUrl;
        let result = '';

        switch (apiType) {
            case TEXTGEN_TYPES.GENERIC:
            case TEXTGEN_TYPES.OOBA:
            case TEXTGEN_TYPES.VLLM:
            case TEXTGEN_TYPES.APHRODITE:
            case TEXTGEN_TYPES.KOBOLDCPP:
            case TEXTGEN_TYPES.LLAMACPP:
            case TEXTGEN_TYPES.INFERMATICAI:
            case TEXTGEN_TYPES.OPENROUTER:
            case TEXTGEN_TYPES.FEATHERLESS:
                url += '/v1/models';
                break;
            case TEXTGEN_TYPES.DREAMGEN:
                url += '/api/openai/v1/models';
                break;
            case TEXTGEN_TYPES.MANCER:
                url += '/oai/v1/models';
                break;
            case TEXTGEN_TYPES.TABBY:
                url += '/v1/model/list';
                break;
            case TEXTGEN_TYPES.TOGETHERAI:
                url += '/api/models?&info';
                break;
            case TEXTGEN_TYPES.OLLAMA:
                url += '/api/tags';
                break;
            case TEXTGEN_TYPES.HUGGINGFACE:
                url += '/info';
                break;
        }

        const modelsReply = await fetch(url, args);
        const isPossiblyLmStudio = modelsReply.headers.get('x-powered-by') === 'Express';

        if (!modelsReply.ok) {
            console.error('Models endpoint is offline.');
            return response.sendStatus(400);
        }

        /** @type {any} */
        let data = await modelsReply.json();

        // Rewrap to OAI-like response
        if (apiType === TEXTGEN_TYPES.TOGETHERAI && Array.isArray(data)) {
            data = { data: data.map(x => ({ id: x.name, ...x })) };
        }

        if (apiType === TEXTGEN_TYPES.OLLAMA && Array.isArray(data.models)) {
            data = { data: data.models.map(x => ({ id: x.name, ...x })) };
        }

        if (apiType === TEXTGEN_TYPES.HUGGINGFACE) {
            data = { data: [] };
        }

        if (!Array.isArray(data.data)) {
            console.error('Models response is not an array.');
            return response.sendStatus(400);
        }

        const modelIds = data.data.map(x => x.id);
        console.info('Models available:', modelIds);

        // Set result to the first model ID
        result = modelIds[0] || 'Valid';

        if (apiType === TEXTGEN_TYPES.OOBA && !isPossiblyLmStudio) {
            try {
                const modelInfoUrl = baseUrl + '/v1/internal/model/info';
                const modelInfoReply = await fetch(modelInfoUrl, args);

                if (modelInfoReply.ok) {
                    /** @type {any} */
                    const modelInfo = await modelInfoReply.json();
                    console.debug('Ooba model info:', modelInfo);

                    const modelName = modelInfo?.model_name;
                    result = modelName || result;
                    response.setHeader('x-supports-tokenization', 'true');
                }
            } catch (error) {
                console.error(`Failed to get Ooba model info: ${error}`);
            }
        } else if (apiType === TEXTGEN_TYPES.TABBY) {
            try {
                const modelInfoUrl = baseUrl + '/v1/model';
                const modelInfoReply = await fetch(modelInfoUrl, args);

                if (modelInfoReply.ok) {
                    /** @type {any} */
                    const modelInfo = await modelInfoReply.json();
                    console.debug('Tabby model info:', modelInfo);

                    const modelName = modelInfo?.id;
                    result = modelName || result;
                } else {
                    // TabbyAPI returns an error 400 if a model isn't loaded

                    result = 'None';
                }
            } catch (error) {
                console.error(`Failed to get TabbyAPI model info: ${error}`);
            }
        }

        return response.send({ result, data: data.data });
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
        // Pass the object, not a pre-stringified template - stringify() ran unconditionally even when
        // minLogLevel gates console.debug down to a no-op.
        console.debug('Model properties:', props);
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
 *    (`anchorNodeId` - the leaf of the loaded branch when `branchName` is given, or the given
 *    `nodeId` itself, verified to exist).
 * 3. Build real `countTokens`/`encodeTokens` closures via `resolveTokenizerType()`/
 *    `encodeWithTokenizerType()`, resolving the SAME tokenizer the resolved backend would actually
 *    use (`power_user.tokenizer` is the user's manual override, exactly like
 *    `getTokenizerForTokenIds()` reads client-side).
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
 * @param {import('../../users.js').UserDirectoryList} directories
 * @param {object} params
 * @param {import('express').Request} [params.request] Original request - forwarded only for the
 * remote-tokenizer header-forwarding path (`encodeViaTextgenAPI`); safe to omit in tests.
 * @param {string} [params.characterAvatar] Character avatar filename. One of this or `groupId` is required.
 * @param {string} [params.groupId] Group id. One of this or `characterAvatar` is required.
 * @param {string} params.ownerId message-tree-db.js owner id.
 * @param {string} [params.branchName] message-tree-db.js labeled chat name. One of this or `nodeId` is required.
 * @param {string} [params.nodeId] Alternative to `branchName` - generate from this existing tree node.
 * @param {string} [params.type] Generation type ('normal'/'impersonate'/'continue'/'swipe'/...).
 * @param {boolean} [params.isImpersonate]
 * @param {boolean} [params.isContinue]
 * @param {boolean} [params.isSwipe]
 * @param {string} [params.userMessageText] The literal text the user typed this turn. Omit for
 * generation types that don't add a new message (continue/swipe).
 * @returns {Promise<{ params: object, backend: {type: string, serverUrl: string, model: string|undefined}, anchorNodeId: string|null, name1: string }>}
 */
export async function buildRawActionTextCompletionRequest(directories, {
    request, characterAvatar, groupId, ownerId, branchName, nodeId,
    type = 'normal', isImpersonate = false, isContinue = false, isSwipe = false, userMessageText,
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
    if (!branchName && !nodeId) {
        throw new Error('branch_name or node_id is required');
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

    // Step 2 (anchor resolution) - real disk reads via message-tree-db.js, using the SAME
    // resolution rule text-completion-generation-input.js's own (private) resolveChatHistory()
    // uses: a labeled branch's leaf when `branchName` is given, else the given `nodeId` itself.
    // Resolved independently of the orchestrator input's own `chat` array, since that array (once
    // `userMessageText` is folded in) no longer carries a clean "last EXISTING node" marker.
    let anchorNodeId = null;
    if (branchName) {
        const branch = await loadBranch(directories, ownerId, branchName);
        if (!branch) {
            throw new Error(`Chat branch not found: ${branchName}`);
        }
        anchorNodeId = branch.branch.leaf_id;
    } else {
        const ancestorPath = await getAncestorPath(directories, nodeId);
        if (!ancestorPath) {
            throw new Error(`Chat node not found: ${nodeId}`);
        }
        anchorNodeId = nodeId;
    }

    // Step 3
    const { power_user: powerUser = {} } = readSettingsAtPaths(directories, ['power_user']);
    const tokenizerType = resolveTokenizerType({
        userTokenizerSetting: powerUser.tokenizer,
        textgenType: backend.type,
        textgenModel: backend.model,
    });
    const encodeTokens = (text) => encodeWithTokenizerType(tokenizerType, text, {
        request, textgenBaseUrl: backend.serverUrl, textgenModel: backend.model, textgenApiType: backend.type,
        ...tokenizerOptions,
    });
    const countTokens = async (text) => (await encodeTokens(text)).length;

    // Step 4
    const orchestratorInput = await resolveTextCompletionGenerationInput(directories, {
        avatar: characterAvatar, groupId, ownerId, branchName, nodeId,
        type, isImpersonate, isContinue, isSwipe, userMessageText,
        countTokens, encodeTokens,
    });

    if ((isContinue || isSwipe) && orchestratorInput.chat.length === 0) {
        throw new Error('Cannot continue/swipe an empty chat.');
    }

    // Step 5-6
    const assembled = await assembleTextCompletionPrompt(orchestratorInput);

    return { params: assembled.generate_data, backend, anchorNodeId, name1: orchestratorInput.name1, name2: orchestratorInput.name2 };
}

router.post('/generate', async function (request, response) {
    if (!request.body) return response.sendStatus(400);

    // Set only by the raw-action branch below (and only for a type/mode where the reply is actually
    // meant to be persisted - see that branch's own comment for the `is_impersonate`/`type ===
    // 'quiet'` exclusion), and read only by the NON-STREAMING response branch further down - every
    // other branch (connection-profile, default/legacy) never touches this, so it stays a no-op for
    // them. The two streaming branches (`api_type === OLLAMA && stream`, and the generic `stream`
    // branch with `pipeLlamaCppCompactStream`/`forwardFetchResponse`) also never check this variable
    // - persisting the assistant's reply for a STREAMING raw-action generation is a real, separate
    // follow-up (tee the live byte stream into full text, per api_type's own delta format, while
    // still forwarding it unchanged to the client) and is intentionally NOT attempted here. A future
    // implementer of that follow-up should read this object's shape (set below) and plug the
    // equivalent persistence in at the end of each streaming branch once the full text is known
    // there - and must apply the same `is_impersonate`/`type === 'quiet'` exclusion.
    let pendingAssistantPersist = null;

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

            const { 'textgenerationwebui_settings': baseSettings } = readSettingsAtPaths(request.user.directories, ['textgenerationwebui_settings']);
            const preset = profile.preset ? readPresetByName('textgenerationwebui', profile.preset, request.user.directories) : null;
            const settings = mergeTextGenPreset({ ...baseSettings, type: selectedApiMap.type }, preset);

            // Resolved early (normally computed after this call, at line ~327) so it can also be
            // handed to computeTextgenLogitBias()'s remote-tokenize branches (src/endpoints/
            // tokenizers.js) via logitBiasContext.remoteContext - without it, a connected textgen/
            // kobold backend's OWN tokenizer would silently be skipped for any settings.logit_bias
            // entry that needs it, even though the backend the request will hit is already known
            // here.
            const apiServerUrl = profile['api-url'] || resolveServerUrl(settings);

            const params = await createTextGenGenerationData(
                settings, profile.model, finalPrompt, maxTokens, isImpersonate, isContinue, null, type,
                {
                    stoppingStrings, macroContext: { name1, name2 },
                    logitBiasContext: {
                        remoteContext: { request, baseUrl: apiServerUrl, apiType: selectedApiMap.type, model: profile.model },
                    },
                },
            );

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
            const {
                character_avatar: characterAvatar, group_id: groupId, owner_id: ownerId,
                branch_name: branchName, node_id: nodeId, type = 'normal',
                is_impersonate: isImpersonate = false, is_continue: isContinue = false, is_swipe: isSwipe = false,
                user_message: userMessageText,
            } = request.body;

            const directories = request.user.directories;

            /** @type {Awaited<ReturnType<typeof buildRawActionTextCompletionRequest>>} */
            let built;
            try {
                built = await buildRawActionTextCompletionRequest(directories, {
                    request, characterAvatar, groupId, ownerId, branchName, nodeId,
                    type, isImpersonate, isContinue, isSwipe, userMessageText,
                });
            } catch (error) {
                console.error('Failed to build raw-action text completion request:', error);
                return response.status(400).send({ error: true, message: error?.message ?? 'Could not resolve this generation request' });
            }

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
            // once a response is known - see `pendingAssistantPersist`, set a few lines below, and
            // read in the non-streaming response branch. STREAMING raw-action generations are NOT
            // covered yet (scoped out of this task on purpose): that would require buffering a live
            // SSE/streaming backend response into full text (while ALSO forwarding it live to the
            // client below, unchanged) and mapping it back through whichever api_type's own
            // delta-parsing format was used, before appending it via appendMessages() - real,
            // separate plumbing left as a follow-up task.
            // The reply, once persisted, must chain onto whatever node is actually the new leaf
            // after this block - the just-appended user message's node when one was appended,
            // otherwise `built.anchorNodeId` unchanged (continue/swipe, which add no new message).
            const skipPersistence = isImpersonate || type === 'quiet';
            let replyAnchorNodeId = built.anchorNodeId;
            if (!skipPersistence && typeof userMessageText === 'string' && built.anchorNodeId) {
                const appendResult = await appendMessages(directories, ownerId, built.anchorNodeId, [
                    { name: built.name1, is_user: true, mes: userMessageText, extra: {}, send_date: Date.now() },
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
            if (!skipPersistence) {
                pendingAssistantPersist = { directories, ownerId, anchorNodeId: replyAnchorNodeId, name2: built.name2 };
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
            parseOllamaStream(stream, request, response);
        } else if (request.body.stream) {
            const completionsStream = await fetch(url, args);
            if (request.body.api_type === TEXTGEN_TYPES.LLAMACPP) {
                // Compact wire format for the llama.cpp raw-completions path only - see llamacpp-compact-stream.js.
                await pipeLlamaCppCompactStream(completionsStream, response);
            } else {
                // Pipe remote SSE stream to Express response
                await forwardFetchResponse(completionsStream, response);
            }
        } else {
            const completionsReply = await fetch(url, args);

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
                if (pendingAssistantPersist) {
                    // Most api_types funneled through the shared `/v1/completions`-style URL above
                    // return an OpenAI-completions-shaped `{choices: [{text, ...}]}` body (already
                    // true of `data` here, INFERMATICAI's own remap included). Ollama is the one
                    // exception reachable in this non-streaming branch: its real `/api/generate`
                    // endpoint (see the `api_type === TEXTGEN_TYPES.OLLAMA` request-body construction
                    // above, `url += '/api/generate'`) replies `{response: "...", done: true, ...}`
                    // when `stream` is false, NOT `{choices: [...]}`.
                    const generatedText = apiType === TEXTGEN_TYPES.OLLAMA
                        ? (data?.response ?? '')
                        : (data?.choices?.[0]?.text ?? '');

                    if (generatedText) {
                        const { directories, ownerId, anchorNodeId, name2 } = pendingAssistantPersist;
                        const appendResult = await appendMessages(directories, ownerId, anchorNodeId, [
                            { name: name2, is_user: false, mes: generatedText, extra: {}, send_date: Date.now() },
                        ]);
                        if (!appendResult.ok) {
                            console.error('Failed to persist assistant reply onto the tree:', appendResult.reason);
                        }
                    }
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
