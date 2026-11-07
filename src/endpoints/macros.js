import express from 'express';
import { requireSessionHeader } from '../request-session.js';

import { chatContext, loadChatHistory } from '../chat-request.js';
import { getCharacterCardFields } from '../character-card-fields.js';
import { getChatCompletionModel } from '../chat-completion-generation-input.js';
import { apiTokenLimits, generationMacroFacts, readPageMacroFacts } from '../macro-facts.js';
import { resolveSpeakers } from '../macro-scope.js';
import { substituteParams } from '../macro-substitution.js';
import { readSettingsFor, settingsContextOf } from '../settings-reads.js';
import { resolveTextGenBackend } from '../textgen-backend-resolve.js';
import { storeRoute } from '../user-stores.js';
import { isSafeMacro, macrosIn, withMacroValues } from '../../public/scripts/safe-macros.js';

export const router = express.Router();
router.use(requireSessionHeader);

const MAX_MACROS = 1000;
const MAX_MACRO_LENGTH = 100_000;

/**
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {import('../settings-reads.js').SettingsContext} settingsContext
 * @param {string} mainApi
 * @param {Record<string, any>} oaiSettings
 */
function modelOf(directories, settingsContext, mainApi, oaiSettings) {
    if (mainApi === 'openai') return getChatCompletionModel(oaiSettings) ?? undefined;
    if (mainApi !== 'textgenerationwebui') return undefined;
    try {
        return resolveTextGenBackend(directories, settingsContext).model;
    } catch {
        return undefined;
    }
}

/**
 * @param {any} request
 * @param {Record<string, any>} [body]
 * @param {{ withChat?: boolean }} [options] Without the chat, the context has the character and no messages.
 * @returns {Promise<import('../macro-substitution.js').SubstituteParamsContext>}
 */
export async function previewContext(request, body = request.body ?? {}, { withChat = true } = {}) {
    const { directories } = request.user;
    const avatar = typeof body.avatar_url === 'string' && body.avatar_url !== '' ? body.avatar_url : null;
    const groupId = typeof body.group_id === 'string' && body.group_id !== '' ? body.group_id : null;
    const speakers = await resolveSpeakers(directories, { avatar, groupId });
    const chat = withChat && (avatar !== null || groupId !== null) ? await chatContext(request, { avatar, group: groupId }) : null;
    const at = typeof body.at === 'string' && body.at !== '' ? body.at : null;
    const settingsContext = settingsContextOf({ avatar, groupId, chat, nodeId: at });
    const {
        power_user: powerUser = {}, extension_settings: extensionSettings = {}, oai_settings: oaiSettings = {},
        username, user_avatar: userAvatar, main_api: mainApi = 'textgenerationwebui', ...limits
    } = /** @type {Record<string, any>} */ (readSettingsFor(directories, settingsContext, [
        'power_user', 'extension_settings', 'oai_settings', 'username', 'user_avatar', 'main_api', 'max_context', 'amount_gen',
    ]));
    const { chat: messages, metadata } = await loadChatHistory(chat, { nodeId: at });
    const chatMetadata = structuredClone(metadata);
    const pageFacts = readPageMacroFacts(body.macro_facts);
    const macroFacts = generationMacroFacts({
        powerUser, extensionSettings: structuredClone(extensionSettings), mainApi, pageFacts,
        lastGenerationType: pageFacts.lastGenerationType ?? '',
        ...apiTokenLimits({ ...limits, oai_settings: oaiSettings }, mainApi),
    });
    const name1 = typeof username === 'string' && username !== '' ? username : 'User';
    const name2 = typeof body.name2 === 'string' ? body.name2 : speakers.name2;
    const isGroup = groupId !== null;
    const base = { ...macroFacts, name1, name2, isGroup, groupMembers: speakers.groupMembers, groupDisabledMembers: speakers.groupDisabledMembers, chat: messages, chatMetadata };
    const characterCard = await getCharacterCardFields(directories, {
        avatar: avatar ?? undefined,
        groupId: groupId ?? undefined,
        preferCharacterPrompt: Boolean(powerUser.prefer_character_prompt),
        preferCharacterJailbreak: Boolean(powerUser.prefer_character_jailbreak),
        personaDescription: powerUser.persona_data?.[userAvatar]?.description,
        chatMetadata,
        macroContext: base,
    });
    return { ...base, characterCard, model: modelOf(directories, settingsContext, mainApi, oaiSettings) };
}

/**
 * @param {import('../macro-substitution.js').SubstituteParamsContext} context
 * @param {string[]} macros
 * @param {boolean} all
 * @returns {(string | null)[]}
 */
function macroValues(context, macros, all) {
    return macros.map((macro) => {
        if (!all && (!/^\{\{[\s\S]*\}\}$/.test(macro) || !isSafeMacro(macro))) return null;
        try {
            return substituteParams(macro, context);
        } catch (error) {
            console.warn('A macro could not be filled in:', error);
            return null;
        }
    });
}

/**
 * @param {any} request
 * @param {{ avatar_url?: string, group_id?: string, at?: string | null, macro_facts?: unknown }} scope
 * @param {string[]} texts
 * @returns {Promise<string[]>}
 */
export async function withSafeMacrosFilled(request, scope, texts) {
    const macros = [...new Set(texts.flatMap(text => macrosIn(text)))];
    if (macros.length === 0) return texts.map(text => withMacroValues(text, () => null));
    const values = new Map(macroValues(await previewContext(request, scope), macros, false).map((value, i) => [macros[i], value]));
    return texts.map(text => withMacroValues(text, source => values.get(source)));
}

router.post('/values', storeRoute('filling in macros', async (request, response) => {
    const macros = request.body?.macros;
    if (!Array.isArray(macros) || macros.length > MAX_MACROS || !macros.every(m => typeof m === 'string' && m.length <= MAX_MACRO_LENGTH)) {
        return response.status(400).send({ error: `macros must be a list of at most ${MAX_MACROS} texts` });
    }
    return response.send({ values: macroValues(await previewContext(request), macros, request.body.all === true) });
}));
