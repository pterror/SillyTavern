import express from 'express';
import { generationEntryOf, handleGenerationStop } from '../generation-stop.js';
import { retryPersistReply } from '../assistant-reply-persist.js';
import { readSettingsFor, settingsContextOf } from '../settings-reads.js';
import { buildRawActionChatCompletionRequest, generateChatCompletion } from './backends/chat-completions.js';
import { buildRawActionTextCompletionRequest, generateTextCompletion } from './backends/text-completions.js';
import { buildRawActionKoboldRequest, generateKobold } from './backends/kobold.js';
import { handleGenerationResume } from './backends/llamacpp-compact-stream.js';
import { buildRawActionNovelRequest, generateNovel } from './novelai.js';
import { generateHorde, hordeJobOf } from './horde.js';
import { previewContext } from './macros.js';
import { rawPrompt } from '../raw-prompt.js';
import { chatContext } from '../chat-request.js';
import { readPageMacroFacts } from '../macro-facts.js';
import { readPageInjections } from '../page-injections.js';
import { writeBack } from '../token-count-store.js';

/** What makes the prompt on each kind of connection. */
const PROMPT_BUILDERS = Object.freeze({
    openai: buildRawActionChatCompletionRequest,
    textgenerationwebui: buildRawActionTextCompletionRequest,
    kobold: buildRawActionKoboldRequest,
    novel: buildRawActionNovelRequest,
    koboldhorde: (/** @type {any} */ directories, /** @type {any} */ params) => buildRawActionKoboldRequest(directories, { ...params, macroExtras: { isHorde: true } }),
});

/** What makes a reply on each kind of connection. */
const GENERATORS = Object.freeze({
    openai: generateChatCompletion,
    textgenerationwebui: generateTextCompletion,
    kobold: generateKobold,
    novel: generateNovel,
    koboldhorde: generateHorde,
});

/**
 * @param {string} id
 * @param {string|undefined} handle
 * @returns {Promise<{state: 'unknown'|'saved'|'failed', node_id?: string, mes?: string, extra?: object, reason?: string}>}
 */
export async function retryGenerationStore(id, handle) {
    const entry = generationEntryOf(id, handle);
    if (!entry) {
        return { state: 'unknown' };
    }
    if (entry.persisted) {
        return { state: 'saved', node_id: entry.persisted.node_id, mes: entry.persisted.mes, extra: entry.persisted.extra };
    }
    if (!entry.unsaved) {
        return { state: 'unknown' };
    }
    const result = await retryPersistReply(entry.unsaved.pending, entry.unsaved.text);
    if (result && 'node_id' in result) {
        entry.persisted = result;
        entry.unsaved = null;
        return { state: 'saved', node_id: result.node_id, mes: result.mes, extra: result.extra };
    }
    const reason = result?.error ?? 'nothing to store';
    entry.unsaved.reason = reason;
    return { state: 'failed', reason };
}

export const router = express.Router();

/**
 * Whose chat a generation action is in, and the connection chosen for it.
 * @param {import('express').Request} request
 * @param {import('express').Response} response
 * @returns {{ avatar: string|null, groupId: string|null, api: keyof typeof GENERATORS }|null} Null when it answered the request.
 */
function generationTarget(request, response) {
    const body = request.body;
    const avatar = typeof body?.character_avatar === 'string' && body.character_avatar !== '' ? body.character_avatar : null;
    const groupId = typeof body?.group_id === 'string' && body.group_id !== '' ? body.group_id : null;
    if (avatar === null && groupId === null) {
        response.status(400).send({ error: { message: 'A generation needs a character or a group.' } });
        return null;
    }
    const { main_api: api } = readSettingsFor(request.user.directories, settingsContextOf({ avatar, groupId }), ['main_api']);
    if (!Object.hasOwn(GENERATORS, api)) {
        response.status(400).send({ error: { message: 'No API is chosen to generate with: choose one in API Connections.' } });
        return null;
    }
    response.setHeader('X-ST-Connection', api);
    return { avatar, groupId, api };
}

router.post('/generate', async function (request, response) {
    const target = generationTarget(request, response);
    if (!target) return;
    request.body.owner_id = target.groupId ?? target.avatar;
    return GENERATORS[target.api](request, response);
});

router.post('/prompt', async function (request, response) {
    const target = generationTarget(request, response);
    if (!target) return;
    const { avatar, groupId, api } = target;
    const body = request.body;
    const directories = request.user.directories;
    try {
        const chat = await chatContext(request, { avatar, group: groupId });
        if (!chat) return response.status(404).send({ error: { message: groupId ? `Group not found: ${groupId}` : `Character not found: ${avatar}` } });
        const type = typeof body.type === 'string' ? body.type : 'normal';
        const built = await PROMPT_BUILDERS[api](directories, {
            request, characterAvatar: avatar ?? undefined, groupId: groupId ?? undefined, chat,
            nodeId: typeof body.node_id === 'string' && body.node_id !== '' ? body.node_id : null,
            type, isImpersonate: type === 'impersonate', isContinue: type === 'continue', isSwipe: type === 'swipe' || type === 'regenerate',
            pageFacts: readPageMacroFacts(body.macro_facts), pageInjections: readPageInjections(body.extension_prompts),
            dryRun: true,
        });
        const itemization = await built.itemize();
        writeBack(directories, built.tokenCountRows).catch(error => console.error('Failed to store token counts:', error));
        return response.send({
            connection: api,
            prompt: built.prompt,
            itemization,
            prompt_manager: 'promptManagerParts' in built && built.promptManagerParts ? built.promptManagerParts() : null,
        });
    } catch (error) {
        console.error('Could not build the prompt:', error);
        return response.status(400).send({ error: { message: error?.message ?? 'Could not build the prompt' } });
    }
});

router.post('/generate/stop/:id', handleGenerationStop);
router.get('/generate/resume/:id', handleGenerationResume);

router.post('/store/:id', async function (request, response) {
    const result = await retryGenerationStore(request.params.id, request.user?.profile?.handle);
    if (result.state === 'unknown') {
        return response.status(404).json(result);
    }
    return response.json(result);
});

router.post('/raw', async function (request, response) {
    const target = generationTarget(request, response);
    if (!target) return;
    const { avatar, groupId, api } = target;
    const body = request.body;
    const directories = request.user.directories;
    try {
        const chat = await chatContext(request, { avatar, group: groupId });
        if (!chat) return response.status(404).send({ error: { message: groupId ? `Group not found: ${groupId}` : `Character not found: ${avatar}` } });
        const nodeId = typeof body.node_id === 'string' && body.node_id !== '' ? body.node_id : null;
        const responseLength = Number.isInteger(body.response_length) && body.response_length > 0 ? body.response_length : undefined;
        const built = await PROMPT_BUILDERS[api](directories, {
            request, characterAvatar: avatar ?? undefined, groupId: groupId ?? undefined, chat, nodeId, type: 'quiet',
            pageFacts: readPageMacroFacts(body.macro_facts), responseLength, jsonSchema: body.json_schema ?? null, dryRun: true,
        });
        const macroContext = await previewContext(request, { avatar_url: avatar ?? undefined, group_id: groupId ?? undefined, at: nodeId, macro_facts: body.macro_facts });
        const { power_user: powerUser = {}, horde_settings: hordeSettings = {} } = readSettingsFor(directories, settingsContextOf({ avatar, groupId }), ['power_user', 'horde_settings']);
        const prompt = rawPrompt(api, {
            prompt: typeof body.prompt === 'string' || Array.isArray(body.prompt) ? body.prompt : '',
            systemPrompt: typeof body.system_prompt === 'string' ? body.system_prompt : '',
            prefill: typeof body.prefill === 'string' ? body.prefill : '',
            instruct: body.instruct !== false,
            quietToLoud: body.quiet_to_loud === true,
        }, { macroContext, powerUser });
        /** @type {Record<string, any>} */
        const params = built.params;
        if (api === 'openai') {
            request.body = { ...params, messages: prompt, stream: false, chat_completion_source: /** @type {any} */ (built).settings.chat_completion_source };
        } else if (api === 'textgenerationwebui') {
            const backend = /** @type {any} */ (built).backend;
            request.body = { ...params, prompt, stream: false, api_type: backend.type, api_server: backend.serverUrl };
        } else if (api === 'novel') {
            request.body = { ...params, input: prompt, streaming: false };
        } else if (api === 'koboldhorde') {
            request.body = hordeJobOf(String(prompt), params, hordeSettings);
        } else {
            request.body = { ...params, prompt, streaming: false };
        }
        return GENERATORS[api](request, response);
    } catch (error) {
        console.error('Could not make the raw generation:', error);
        return response.status(400).send({ error: { message: error?.message ?? 'Could not make the generation' } });
    }
});
