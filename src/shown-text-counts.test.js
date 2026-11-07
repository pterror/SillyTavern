import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { setConfigFilePath } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', 'config.yaml'));

const { emptyUser } = await import('../tests/converted-user.fixture.js');
const { writeAllSettings } = await import('./settings-store.js');
const { shownTextCounts } = await import('./shown-text-counts.js');

const user = await emptyUser('st-shown-counts-test-');
after(() => user.close());

/**
 * @param {Record<string, any>} [extra]
 */
function settings(extra = {}) {
    return {
        main_api: 'openai', user_avatar: 'me.png', active_character: 'rex.png',
        oai_settings: { chat_completion_source: 'custom', custom_model: 'unknown-model', custom_url: '' },
        power_user: { persona_data: { 'me.png': { description: 'A tall traveller from the north.' } } },
        extension_settings: { note: { default: 'Keep it short.', chara: [{ name: 'rex', prompt: 'Rex limps.', useChara: true }] } },
        ...extra,
    };
}

test('the shown texts are counted as the chosen connection counts them, the open character\'s note among them', async () => {
    writeAllSettings(user.directories, settings());
    const counts = await shownTextCounts(user.directories, {}, { chatNote: 'It rains.' });
    assert.ok(counts);
    for (const key of ['persona', 'note_default', 'note_chara', 'chat_note']) {
        assert.ok(Number.isInteger(counts[key]) && counts[key] > 0, `${key}: ${counts[key]}`);
    }
    assert.equal(typeof counts.tokenizer?.key, 'string');
});

test('a character with no note of its own has none counted, and an action outside a chat counts no chat note', async () => {
    writeAllSettings(user.directories, settings({ active_character: 'ann.png' }));
    const counts = await shownTextCounts(user.directories, {});
    assert.equal(counts?.note_chara, null);
    assert.equal(counts && 'chat_note' in counts, false);
});

test('with no connection chosen nothing is counted', async () => {
    writeAllSettings(user.directories, settings({ main_api: '' }));
    assert.equal(await shownTextCounts(user.directories, {}), null);
});
