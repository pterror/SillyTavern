import { setting_names as TEXTGEN_SETTING_NAMES } from '../public/scripts/textgen-setting-names.js';

export { TEXTGEN_SETTING_NAMES };

/**
 * @param {object} baseSettings
 * @param {object} preset
 * @returns {object}
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
