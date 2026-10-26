import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

// What a saved preset or template file holds: its object less the keys that aren't a preset's, and for a text API
// the response length and context size.
test.describe('Preset files', () => {
    test.beforeEach(testSetup.awaitST);

    test('a text completion preset holds its samplers and the lengths, not the connection or streaming', async ({ page }) => {
        const preset = await page.evaluate(async () => {
            const { getPresetManager } = await import('./scripts/preset-manager.js');
            return getPresetManager('textgenerationwebui').getPresetSettings('Probe');
        });
        const { amount_gen, max_context } = await page.evaluate(async () => {
            const params = await import('./scripts/generation-params.js');
            return { amount_gen: params.amount_gen, max_context: params.max_context };
        });
        expect(preset.temp).toBeDefined();
        expect(preset.genamt).toBe(amount_gen);
        expect(preset.max_length).toBe(max_context);
        for (const key of ['server_urls', 'type', 'streaming', 'llamacpp_model', 'preset']) {
            expect(Object.hasOwn(preset, key), key).toBe(false);
        }
    });

    test('a context template holds the power user keys it carries', async ({ page }) => {
        const preset = await page.evaluate(async () => {
            const { getPresetManager } = await import('./scripts/preset-manager.js');
            const { power_user } = await import('./scripts/power-user.js');
            power_user.trim_sentences = true;
            return getPresetManager('context').getPresetSettings('Probe');
        });
        expect(preset.name).toBe('Probe');
        expect(preset.trim_sentences).toBe(true);
        expect(typeof preset.always_force_name2).toBe('boolean');
        expect(typeof preset.story_string).toBe('string');
        expect(Object.hasOwn(preset, 'genamt')).toBe(false);
    });

    test('the preset routes save, list, rename and delete a preset file', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const { getRequestHeaders } = await import('./scripts/request-headers.js');
            const post = (url, body) => fetch(url, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) });
            const saved = await (await post('/api/presets/save', { apiId: 'textgenerationwebui', name: 'Probe/Route', preset: { temp: 0.42 } })).json();
            const listed = await (await post('/api/settings/get', {})).json();
            const index = listed.textgenerationwebui_preset_names.indexOf(saved.name);
            const text = index === -1 ? null : JSON.parse(listed.textgenerationwebui_presets[index]);
            const taken = (await post('/api/presets/rename', { apiId: 'textgenerationwebui', name: saved.name, newName: 'Default' })).status;
            const renamed = await (await post('/api/presets/rename', { apiId: 'textgenerationwebui', name: saved.name, newName: 'Probe Renamed' })).json();
            const deleted = (await post('/api/presets/delete', { apiId: 'textgenerationwebui', name: 'Probe Renamed' })).status;
            const again = (await post('/api/presets/delete', { apiId: 'textgenerationwebui', name: 'Probe Renamed' })).status;
            const badApi = (await post('/api/presets/save', { apiId: 'nope', name: 'x', preset: {} })).status;
            return { saved, text, taken, renamed, deleted, again, badApi };
        });
        expect(result.saved).toEqual({ name: 'ProbeRoute' });
        expect(result.text).toEqual({ temp: 0.42 });
        expect(result.taken).toBe(400);
        expect(result.renamed).toEqual({ name: 'Probe Renamed' });
        expect([result.deleted, result.again, result.badApi]).toEqual([200, 404, 400]);
    });
});
