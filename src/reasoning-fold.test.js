import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    REASONING_PLACEHOLDER,
    createReasoningFoldState,
    isReasoningLimitReached,
    foldReasoningIntoMessage,
    removeReasoningPrefix,
} from './reasoning-fold.js';

test('isReasoningLimitReached: addToPrompts false is always reached', () => {
    const state = createReasoningFoldState();
    assert.equal(isReasoningLimitReached(state, { addToPrompts: false, maxAdditions: 100 }), true);
});

test('isReasoningLimitReached: addToPrompts true and counter below max is not reached', () => {
    const state = { ...createReasoningFoldState(), counter: 1 };
    assert.equal(isReasoningLimitReached(state, { addToPrompts: true, maxAdditions: 3 }), false);
});

test('isReasoningLimitReached: counter at or above max is reached', () => {
    const state = { ...createReasoningFoldState(), counter: 3 };
    assert.equal(isReasoningLimitReached(state, { addToPrompts: true, maxAdditions: 3 }), true);
});

test('foldReasoningIntoMessage: !isPrefix past the limit returns content unchanged and does not increment counter', () => {
    const state = { ...createReasoningFoldState(), counter: 3 };
    const config = { addToPrompts: true, maxAdditions: 3, reasoningPrefix: 'P', reasoningSeparator: 'S', reasoningSuffix: 'X' };
    const result = foldReasoningIntoMessage(state, 'hello', 'some reasoning', false, null, config);
    assert.equal(result.content, 'hello');
    assert.equal(result.state.counter, 3);
    assert.equal(result.state, state); // returns the same state object unchanged (no new state needed)
});

test('foldReasoningIntoMessage: isPrefix past the limit still folds in (divergent from isReasoningLimitReached)', () => {
    const state = { ...createReasoningFoldState(), counter: 5 };
    const config = { addToPrompts: true, maxAdditions: 3, reasoningPrefix: '[', reasoningSeparator: '|', reasoningSuffix: ']' };
    // Sanity: the limit IS reached according to isReasoningLimitReached.
    assert.equal(isReasoningLimitReached(state, config), true);
    const result = foldReasoningIntoMessage(state, 'body', 'thinking', true, null, config);
    assert.equal(result.content, '[thinking]|body');
    assert.equal(result.state.counter, 6);
});

test('foldReasoningIntoMessage: missing reasoning returns content unchanged', () => {
    const state = createReasoningFoldState();
    const config = { addToPrompts: true, maxAdditions: 10 };
    const result = foldReasoningIntoMessage(state, 'hello', '', false, null, config);
    assert.equal(result.content, 'hello');
    assert.equal(result.state.counter, 0);
});

test('foldReasoningIntoMessage: REASONING_PLACEHOLDER reasoning returns content unchanged', () => {
    const state = createReasoningFoldState();
    const config = { addToPrompts: true, maxAdditions: 10 };
    const result = foldReasoningIntoMessage(state, 'hello', REASONING_PLACEHOLDER, false, null, config);
    assert.equal(result.content, 'hello');
    assert.equal(result.state.counter, 0);
});

test('foldReasoningIntoMessage: isPrefix && !content branch builds prefix+reasoning and marks prefixIncomplete true', () => {
    const state = createReasoningFoldState();
    const config = { addToPrompts: true, maxAdditions: 10, reasoningPrefix: '<think>', reasoningSeparator: '\n\n', reasoningSuffix: '</think>' };
    const result = foldReasoningIntoMessage(state, '', 'my reasoning', true, 42, config);
    assert.equal(result.content, '<think>my reasoning');
    assert.equal(result.state.prefixReasoning, 'my reasoning');
    assert.equal(result.state.prefixReasoningFormatted, '<think>my reasoning');
    assert.equal(result.state.prefixLength, '<think>my reasoning'.length);
    assert.equal(result.state.prefixDuration, 42);
    assert.equal(result.state.prefixIncomplete, true);
});

test('foldReasoningIntoMessage: normal branch concatenates prefix+reasoning+suffix+separator+content', () => {
    const state = createReasoningFoldState();
    const config = { addToPrompts: true, maxAdditions: 10, reasoningPrefix: '<think>', reasoningSeparator: '\n\n', reasoningSuffix: '</think>' };
    const result = foldReasoningIntoMessage(state, 'the body', 'my reasoning', false, 7, config);
    assert.equal(result.content, '<think>my reasoning</think>\n\nthe body');
});

test('foldReasoningIntoMessage: normal branch with isPrefix true marks prefixIncomplete false (complete)', () => {
    const state = createReasoningFoldState();
    const config = { addToPrompts: true, maxAdditions: 10, reasoningPrefix: '<think>', reasoningSeparator: '\n\n', reasoningSuffix: '</think>' };
    const result = foldReasoningIntoMessage(state, 'the body', 'my reasoning', true, 7, config);
    assert.equal(result.content, '<think>my reasoning</think>\n\nthe body');
    assert.equal(result.state.prefixReasoningFormatted, '<think>my reasoning</think>\n\n');
    assert.equal(result.state.prefixLength, '<think>my reasoning</think>\n\n'.length);
    assert.equal(result.state.prefixDuration, 7);
    assert.equal(result.state.prefixIncomplete, false);
});

test('foldReasoningIntoMessage: counter increments exactly once per successful call across a sequence', () => {
    let state = createReasoningFoldState();
    const config = { addToPrompts: true, maxAdditions: 100 };
    for (let i = 0; i < 5; i++) {
        const result = foldReasoningIntoMessage(state, `body-${i}`, `reasoning-${i}`, false, null, config);
        assert.equal(result.state.counter, i + 1);
        state = result.state;
    }
    assert.equal(state.counter, 5);
});

test('foldReasoningIntoMessage: substituteParams is actually invoked on prefix/separator/suffix via macroContext', () => {
    const state = createReasoningFoldState();
    const config = {
        addToPrompts: true,
        maxAdditions: 10,
        reasoningPrefix: '[{{user}} thinks: ',
        reasoningSeparator: ' -- said by {{char}} --',
        reasoningSuffix: ']',
        macroContext: { name1: 'Alice', name2: 'Bob' },
    };
    const result = foldReasoningIntoMessage(state, 'hi', 'stuff', false, null, config);
    assert.equal(result.content, '[Alice thinks: stuff] -- said by Bob --hi');
});

test('removeReasoningPrefix: slices when prefixLength > 0', () => {
    const state = { ...createReasoningFoldState(), prefixLength: 5 };
    assert.equal(removeReasoningPrefix(state, '12345rest'), 'rest');
});

test('removeReasoningPrefix: passes through unchanged when prefixLength is still the initial -1', () => {
    const state = createReasoningFoldState();
    assert.equal(state.prefixLength, -1);
    assert.equal(removeReasoningPrefix(state, 'unchanged'), 'unchanged');
});
