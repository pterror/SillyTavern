import assert from 'node:assert/strict';
import test from 'node:test';

import { rawPrompt } from './raw-prompt.js';

const context = { macroContext: { name1: 'Ann', name2: 'Rex' }, powerUser: { instruct: { enabled: false } } };

test('chat completion: the given messages, the system prompt first and the prefill last', () => {
    const prompt = rawPrompt('openai', { prompt: 'Hello {{char}}.', systemPrompt: 'Be brief.', prefill: 'Well,' }, context);
    assert.deepEqual(prompt, [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hello Rex.' },
        { role: 'assistant', content: 'Well,' },
    ]);
});

test('text completion without instruct: name-prefixed lines, then the prefill on its own line', () => {
    const prompt = rawPrompt('textgenerationwebui', { prompt: [{ role: 'user', content: 'Hi.' }, { role: 'assistant', content: 'Hey.' }], prefill: 'So' }, context);
    assert.equal(prompt, 'Ann: Hi.\nRex: Hey.\nSo');
});

test('NovelAI: the instruction in braces', () => {
    assert.equal(rawPrompt('novel', { prompt: 'Describe the room.' }, context), '{ Ann: Describe the room. }\n');
});

test('no messages and no system prompt is refused', () => {
    assert.throws(() => rawPrompt('openai', { prompt: [] }, context), /No messages provided/);
});
