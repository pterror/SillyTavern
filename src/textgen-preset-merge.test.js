import assert from 'node:assert/strict';
import { mergeTextGenPreset, TEXTGEN_SETTING_NAMES } from './textgen-preset-merge.js';

const base = { type: 'ooba', temp: 1.0, top_p: 1.0, custom_model: 'base-model', unrelated_field: 'keep-me' };

// Only fields in TEXTGEN_SETTING_NAMES get overlaid
const merged = mergeTextGenPreset(base, { temp: 0.7, not_a_real_setting: 'ignored' });
assert.equal(merged.temp, 0.7);
assert.equal(merged.not_a_real_setting, undefined);

// Fields the preset doesn't touch are untouched
assert.equal(merged.top_p, 1.0);
assert.equal(merged.unrelated_field, 'keep-me');

// type isn't in TEXTGEN_SETTING_NAMES, so a preset can't override which backend this targets
const withType = mergeTextGenPreset(base, { type: 'mancer', temp: 0.5 });
assert.equal(withType.type, 'ooba');
assert.equal(withType.temp, 0.5);

// Doesn't mutate the original
mergeTextGenPreset(base, { temp: 0.1 });
assert.equal(base.temp, 1.0);

// No preset / non-object preset is a no-op clone
assert.deepEqual(mergeTextGenPreset(base, null), base);
assert.deepEqual(mergeTextGenPreset(base, undefined), base);

assert.equal(TEXTGEN_SETTING_NAMES.includes('temp'), true);
assert.equal(TEXTGEN_SETTING_NAMES.includes('type'), false);

console.log('textgen-preset-merge.test.js: all assertions passed');
