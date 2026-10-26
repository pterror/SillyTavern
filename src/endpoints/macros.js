import express from 'express';

import { chatContext, loadChatHistory } from '../chat-request.js';
import { getCharacterCardFields } from '../character-card-fields.js';
import { getChatCompletionModel } from '../chat-completion-generation-input.js';
import { apiTokenLimits, generationMacroFacts, readPageMacroFacts } from '../macro-facts.js';
import { resolveSpeakers } from '../macro-scope.js';
import { substituteParams } from '../macro-substitution.js';
import { readSettingsAtPaths } from '../settings-store.js';
import { resolveTextGenBackend } from '../textgen-backend-resolve.js';
import { storeRoute } from '../user-stores.js';
import { isSafeMacro } from '../../public/scripts/safe-macros.js';

/**
 * What the page shows in a macro's place (a pill, a preview), filled in by the engine that fills in the prompts, from
 * the same facts: the page never fills in macros for itself.
 */
export const router = express.Router();

/** The most macros one request fills in, and the longest one. */
const MAX_MACROS = 1000;
const MAX_MACRO_LENGTH = 100_000;

/**
 * The model the macros name ({{model}}), as the prompt builders read it.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {string} mainApi
 * @param {Record<string, any>} oaiSettings
 */
function modelOf(directories, mainApi, oaiSettings) {
    if (mainApi === 'openai') return getChatCompletionModel(oaiSettings) ?? undefined;
    if (mainApi !== 'textgenerationwebui') return undefined;
    try {
        return resolveTextGenBackend(directories).model;
    } catch {
        return undefined;
    }
}

/**
 * What the macros read for the page's open chat: the character's and the group's (`avatar_url`, `group_id`), the
 * chat at the message `at` (left out: the tree's root), the user's settings and what the page sent of its own
 * (`macro_facts`); `name2` names the character instead (a greeting shown under the name being typed).
 * @param {any} request
 * @returns {Promise<import('../macro-substitution.js').SubstituteParamsContext>}
 */
async function previewContext(request) {
    const { directories } = request.user;
    const body = request.body ?? {};
    const avatar = typeof body.avatar_url === 'string' && body.avatar_url !== '' ? body.avatar_url : null;
    const groupId = typeof body.group_id === 'string' && body.group_id !== '' ? body.group_id : null;
    const {
        power_user: powerUser = {}, extension_settings: extensionSettings = {}, oai_settings: oaiSettings = {},
        username, user_avatar: userAvatar, main_api: mainApi = 'textgenerationwebui', ...limits
    } = /** @type {Record<string, any>} */ (readSettingsAtPaths(directories, [
        'power_user', 'extension_settings', 'oai_settings', 'username', 'user_avatar', 'main_api', 'max_context', 'amount_gen',
    ]));

    const speakers = await resolveSpeakers(directories, { avatar, groupId });
    const chat = avatar !== null || groupId !== null ? await chatContext(request, { avatar, group: groupId }) : null;
    const at = typeof body.at === 'string' && body.at !== '' ? body.at : null;
    const { chat: messages, metadata } = await loadChatHistory(chat, { nodeId: at });
    // Only read: a copy, whatever a macro does.
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
    return { ...base, characterCard, model: modelOf(directories, mainApi, oaiSettings) };
}

/**
 * `{ macros: string[], avatar_url?, group_id?, at?, name2?, all?, macro_facts? }`: each macro's value (`{{…}}`, a
 * whole one), in order; null for one that runs only when sent (side effects or randomness), which the page shows as
 * written. With `all`, each is a text whose every macro is filled in, those too, on a copy of the variables: nothing
 * a macro sets is kept.
 */
router.post('/values', storeRoute('filling in macros', async (request, response) => {
    const macros = request.body?.macros;
    if (!Array.isArray(macros) || macros.length > MAX_MACROS || !macros.every(m => typeof m === 'string' && m.length <= MAX_MACRO_LENGTH)) {
        return response.status(400).send({ error: `macros must be a list of at most ${MAX_MACROS} texts` });
    }
    const all = request.body.all === true;
    const context = await previewContext(request);
    const values = macros.map((macro) => {
        if (!all && (!/^\{\{[\s\S]*\}\}$/.test(macro) || !isSafeMacro(macro))) return null;
        try {
            return substituteParams(macro, context);
        } catch (error) {
            console.warn('A macro could not be filled in:', error);
            return null;
        }
    });
    return response.send({ values });
}));
