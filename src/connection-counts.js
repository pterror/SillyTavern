import { readSettingsFor } from './settings-reads.js';
import { resolveTextGenBackend } from './textgen-backend-resolve.js';
import { getChatCompletionModel } from './chat-completion-model.js';
import { chatCompletionSettingsWithDefaults } from '../public/scripts/chat-completion-defaults.js';
import { tokenizerAnswer, tokenizerResponseWarnings } from './tokenizer-resolve.js';
import { openTokenizer } from './endpoints/tokenizers-current.js';

/**
 * The tokenizer state of a kind of connection, as its stored settings make it.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {import('./settings-reads.js').SettingsContext} settingsContext
 * @param {string} [api] The kind of connection; the chosen one's when not given.
 * @param {{ model?: string|null }} [overrides] The chat completion model a prompt was built for.
 * @returns {import('./tokenizer-resolve.js').TokenizerState|null}
 */
export function tokenizerStateFor(directories, settingsContext, api = undefined, { model } = {}) {
    const {
        main_api: mainApi, power_user: powerUser = {}, kai_settings: koboldSettings = {}, nai_settings: novelSettings = {},
        horde_settings: hordeSettings = {}, oai_settings: oaiSettings = {},
    } = readSettingsFor(directories, settingsContext, ['main_api', 'power_user', 'kai_settings', 'nai_settings', 'horde_settings', 'oai_settings']);
    const kind = api ?? mainApi;
    const tokenizerSetting = powerUser.tokenizer;
    switch (kind) {
        case 'textgenerationwebui': {
            const backend = resolveTextGenBackend(directories, settingsContext);
            return { api: kind, type: backend.type, url: backend.serverUrl, model: backend.model ?? '', tokenizerSetting };
        }
        case 'kobold':
            return { api: kind, url: koboldSettings.api_server ?? '', model: '', tokenizerSetting };
        case 'novel':
            return { api: kind, model: novelSettings.model_novel ?? '', tokenizerSetting };
        case 'koboldhorde':
            return { api: kind, hordeModels: Array.isArray(hordeSettings.models) ? hordeSettings.models : [], tokenizerSetting };
        case 'openai': {
            const source = oaiSettings.chat_completion_source;
            const chosen = model !== undefined ? model : getChatCompletionModel(chatCompletionSettingsWithDefaults(oaiSettings));
            return { api: kind, source, url: oaiSettings.custom_url, model: chosen ?? '', tokenizerSetting };
        }
        default:
            return null;
    }
}

/**
 * Texts counted as the chosen connection counts them: a chat completion's as one message each, another's as text.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {import('./settings-reads.js').SettingsContext} settingsContext
 * @param {string[]} texts
 * @param {{ recount?: boolean }} [options] recount: count again instead of taking stored counts.
 * @returns {Promise<{ counts: number[], tokenizer: object|null, warnings?: object[] }|null>} Null when no connection is chosen.
 */
export async function countWithConnection(directories, settingsContext, texts, { recount = false } = {}) {
    let state;
    try {
        state = tokenizerStateFor(directories, settingsContext);
    } catch (error) {
        console.warn('No connection to count with:', error?.message ?? error);
        return null;
    }
    if (!state) return null;
    const tokenizer = await openTokenizer(state, directories, { recount });
    const counter = await tokenizer.storedCounter();
    const counts = await Promise.all(texts.map(text => (typeof text !== 'string' || text.length === 0
        ? 0
        : state.api === 'openai' ? counter.countChatMessage([{ content: text }]) : counter.countText(text))));
    tokenizer.writeCounted().catch(error => console.error('Failed to store token counts:', error));
    const warnings = tokenizerResponseWarnings(state, tokenizer.resolved, tokenizer.outcome);
    return { counts, tokenizer: tokenizerAnswer(state, tokenizer.resolved, tokenizer.outcome), ...(warnings.length > 0 ? { warnings } : {}) };
}
