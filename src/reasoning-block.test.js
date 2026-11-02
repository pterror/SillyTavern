import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ReasoningType, reasoningOf, withReasoning } from '../public/scripts/reasoning-block.js';

test('reasoningOf: no extra, no field, upstream\'s cleared form and the legacy placeholder are no block', () => {
    assert.equal(reasoningOf(undefined), null);
    assert.equal(reasoningOf({}), null);
    assert.equal(reasoningOf({ reasoning: '' }), null);
    assert.equal(reasoningOf({ reasoning: '​', reasoning_type: 'manual' }), null);
});

test('reasoningOf: a hidden-reasoning model\'s duration is no block', () => {
    assert.equal(reasoningOf({ reasoning: '', reasoning_type: ReasoningType.Model, reasoning_duration: 900 }), null);
});

test('reasoningOf: an empty block marked by its type is an empty block', () => {
    for (const type of [ReasoningType.Parsed, ReasoningType.Manual, ReasoningType.Edited]) {
        assert.equal(reasoningOf({ reasoning: '', reasoning_type: type }), '');
    }
});

test('reasoningOf: text is a block whatever its type', () => {
    assert.equal(reasoningOf({ reasoning: 'plan' }), 'plan');
    assert.equal(reasoningOf({ reasoning: 'plan', reasoning_type: ReasoningType.Model }), 'plan');
});

test('withReasoning: each state written reads back as itself', () => {
    for (const [value, type] of [[null, undefined], ['', ReasoningType.Manual], ['', ReasoningType.Model], ['plan', ReasoningType.Model], ['plan', ReasoningType.Parsed]]) {
        const extra = withReasoning({ api: 'x', reasoning: 'old', reasoning_type: 'parsed' }, value, type);
        assert.equal(reasoningOf(extra), value);
        assert.equal(extra.api, 'x');
        assert.equal(reasoningOf(JSON.parse(JSON.stringify(extra))), value, 'survives storage');
    }
});

test('withReasoning: removing a block writes upstream\'s cleared form', () => {
    assert.deepEqual(withReasoning({ reasoning: 'plan', reasoning_type: 'parsed' }, null), { reasoning: '' });
});
