import { setting_names as TEXTGEN_SETTING_NAMES } from '../public/scripts/textgen-setting-names.js';

export { TEXTGEN_SETTING_NAMES };

/**
 * Mirrors TextCompletionService.presetToGeneratePayload()'s preset-merge step (public/scripts/custom-request.js):
 * clone the base settings, then overlay only the fields a preset is allowed to carry.
 * @param {object} baseSettings The server's own stored textgenerationwebui_settings
 * @param {object} preset A named preset's raw fields (as read from disk)
 * @returns {object} baseSettings with the preset's TextCompletionSettings fields applied
 */
export function mergeTextGenPreset(baseSettings, preset) {
    const settings = structuredClone(baseSettings);
    if (!preset || typeof preset !== 'object') return settings;
    for (const [key, value] of Object.entries(preset)) {
        if (!TEXTGEN_SETTING_NAMES.includes(key)) continue;
        settings[key] = value;
    }
    return settings;
}
