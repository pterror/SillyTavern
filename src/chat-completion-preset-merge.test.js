import assert from 'node:assert/strict';
import { mergeChatCompletionPreset } from './chat-completion-preset-merge.js';

const base = { chat_completion_source: 'openai', temp_openai: 1.0, top_p_openai: 1.0, unrelated_field: 'keep-me' };

const merged = mergeChatCompletionPreset(base, { temperature: 0.7, not_a_real_setting: 'ignored' });
assert.equal(merged.temp_openai, 0.7);
assert.equal(merged.not_a_real_setting, undefined);

assert.equal(merged.top_p_openai, 1.0);
assert.equal(merged.unrelated_field, 'keep-me');

const withBiasSelected = mergeChatCompletionPreset(base, { bias_preset_selected: 'SomePreset' });
assert.equal(withBiasSelected.bias_preset_selected, undefined);

const withBiasPresets = mergeChatCompletionPreset(base, { bias_preset_selected: 'SomePreset', bias_presets: {} });
assert.equal(withBiasPresets.bias_preset_selected, 'SomePreset');

mergeChatCompletionPreset(base, { temperature: 0.1 });
assert.equal(base.temp_openai, 1.0);

assert.deepEqual(mergeChatCompletionPreset(base, null), base);
assert.deepEqual(mergeChatCompletionPreset(base, undefined), base);

console.log('chat-completion-preset-merge.test.js: all assertions passed');
