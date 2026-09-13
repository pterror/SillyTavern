import { TEXTGEN_TYPES, CHAT_COMPLETION_SOURCES } from './constants.js';
import { readSettingsAtPaths } from './settings-store.js';

// Mirrors setupConnectAPIMap() in public/scripts/slash-commands.js. Pure data, derived from the
// same enums already available server-side - kept as a direct port (not re-derived) so the two
// stay obviously in sync if either enum gains a new alias entry.
const CONNECT_API_MAP = {
    'kobold': { selected: 'kobold' },
    'horde': { selected: 'koboldhorde' },
    'novel': { selected: 'novel' },
    'koboldcpp': { selected: 'textgenerationwebui', type: TEXTGEN_TYPES.KOBOLDCPP },
    'kcpp': { selected: 'textgenerationwebui', type: TEXTGEN_TYPES.KOBOLDCPP },
    'openai': { selected: 'openai', source: CHAT_COMPLETION_SOURCES.OPENAI },
    'oai': { selected: 'openai', source: CHAT_COMPLETION_SOURCES.OPENAI },
    'google': { selected: 'openai', source: CHAT_COMPLETION_SOURCES.MAKERSUITE },
    'openrouter': { selected: 'openai', source: CHAT_COMPLETION_SOURCES.OPENROUTER },
    'openrouter-text': { selected: 'textgenerationwebui', type: TEXTGEN_TYPES.OPENROUTER },
};

for (const textGenType of Object.values(TEXTGEN_TYPES)) {
    if (CONNECT_API_MAP[textGenType]) continue;
    CONNECT_API_MAP[textGenType] = { selected: 'textgenerationwebui', type: textGenType };
}

for (const chatCompletionSource of Object.values(CHAT_COMPLETION_SOURCES)) {
    if (CONNECT_API_MAP[chatCompletionSource]) continue;
    CONNECT_API_MAP[chatCompletionSource] = { selected: 'openai', source: chatCompletionSource };
}

/**
 * Mirrors ConnectionManagerRequestService.getProfile()/validateProfile() in
 * public/scripts/extensions/shared.js.
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} profileId
 * @returns {{profile: object, selectedApiMap: {selected: string, type?: string, source?: string}}}
 */
export function resolveConnectionProfile(directories, profileId) {
    const { 'extension_settings.connectionManager.profiles': profiles } = readSettingsAtPaths(directories, ['extension_settings.connectionManager.profiles']);
    const profile = Array.isArray(profiles) ? profiles.find(p => p.id === profileId) : undefined;
    if (!profile) {
        throw new Error(`Profile not found (ID: ${profileId})`);
    }
    if (!profile.api) {
        throw new Error('Select a connection profile that has an API');
    }

    const selectedApiMap = CONNECT_API_MAP[profile.api];
    if (!selectedApiMap) {
        throw new Error(`Unknown API type ${profile.api}`);
    }
    if (selectedApiMap.selected !== 'openai' && selectedApiMap.selected !== 'textgenerationwebui') {
        throw new Error(`API type ${selectedApiMap.selected} is not supported. Supported types: Chat Completion, Text Completion`);
    }

    return { profile, selectedApiMap };
}
