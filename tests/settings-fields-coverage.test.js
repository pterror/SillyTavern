import { describe, test, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

// The settings declarations (packages/areas/settings/protocol.ts) against the old panel they replace: every setting
// the old tables list is declared or named here with where it belongs instead, and every declared control is in the
// old markup. Deleted with the old panel.

/** The old tables' settings that aren't fields of the panel, and why. */
const ELSEWHERE = {
    'oai_settings.bias_preset_selected': 'the logit bias editor',
    'textgenerationwebui_settings.sampler_order': 'the sampler order list',
    'textgenerationwebui_settings.sampler_priority': 'the sampler order list',
    'textgenerationwebui_settings.samplers': 'the sampler order list',
    'textgenerationwebui_settings.samplers_priorities': 'the sampler order list',
    'textgenerationwebui_settings.logit_bias': 'the logit bias editor',
    'textgenerationwebui_settings.custom_model': 'the connection panel',
    'textgenerationwebui_settings.bypass_status_check': 'the connection panel',
    'textgenerationwebui_settings.openrouter_allow_fallbacks': 'the connection panel',
    'textgenerationwebui_settings.generic_model': 'the connection panel',
    'textgenerationwebui_settings.extensions': 'the backend extensions list, not a field',
};

describe('settings declarations', () => {
    test('every setting of the old tables is declared, or named with where it belongs', async () => {
        const { FIELDS } = await import('../packages/areas/settings/protocol.ts');
        const { settingsToUpdate } = await import('../public/scripts/chat-completion-defaults.js');
        const { setting_names } = await import('../public/scripts/textgen-setting-names.js');
        const declared = new Set(FIELDS.map(field => field.path));
        const listed = [
            // `#NULL_SELECTOR` marks a preset key with no control (carried in presets only).
            ...Object.values(settingsToUpdate).filter(([selector, , , connection]) => selector && selector !== '#NULL_SELECTOR' && !connection).map(([, key]) => `oai_settings.${key}`),
            ...setting_names.map(name => `textgenerationwebui_settings.${name}`),
        ];
        const missing = listed.filter(p => !declared.has(p) && !(p in ELSEWHERE));
        expect(missing).toEqual([]);
    });

    test('every declared control of a family the old page still shows is in its markup, by its id; the new page\'s families\' aren\'t', async () => {
        const { FIELDS, SERVER_FAMILIES } = await import('../packages/areas/settings/protocol.ts');
        const html = fs.readFileSync(path.join(process.cwd(), '..', 'public', 'index.html'), 'utf8');
        const idsOf = (/** @type {typeof FIELDS} */ fields) => fields.flatMap(field => [field.id, ...(field.inputs ?? [])]);
        const old = FIELDS.filter(field => !SERVER_FAMILIES.includes(field.family));
        const moved = FIELDS.filter(field => SERVER_FAMILIES.includes(field.family));
        expect(idsOf(old).filter(id => !html.includes(`id="${id}"`))).toEqual([]);
        expect(idsOf(moved).filter(id => html.includes(`id="${id}"`))).toEqual([]);
    });
});
