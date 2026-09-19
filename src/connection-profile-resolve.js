import { TEXTGEN_TYPES, CHAT_COMPLETION_SOURCES } from './constants.js';
import { readSettingsAtPaths } from './settings-store.js';
import { buildConnectApiMap, getConnectApiMapAllowedSelected } from '../public/scripts/connect-api-map.js';

const CONNECT_API_MAP = buildConnectApiMap(TEXTGEN_TYPES, CHAT_COMPLETION_SOURCES);

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
    if (!getConnectApiMapAllowedSelected().includes(selectedApiMap.selected)) {
        throw new Error(`API type ${selectedApiMap.selected} is not supported. Supported types: Chat Completion, Text Completion`);
    }

    return { profile, selectedApiMap };
}
