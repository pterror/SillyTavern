import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from './util.js';

setConfigFilePath(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.yaml'));

// The server finishes a generated reply before storing it: the reasoning block is split off its text, as upstream's
// page did (public/scripts/reasoning.js), and the page only shows what was stored.

const { finishReply, splitReasoningBlock, noteReplyReasoning, noteReplyText, extractReasoningFromData, extractReasoningSignatureFromData } = await import('./reply-reasoning.js');

/** @returns {import('./reply-reasoning.js').ReplyFinishSettings} */
function settings(overrides = {}) {
    return {
        mainApi: 'textgenerationwebui', source: 'llamacpp', showThoughts: true, hiddenReasoningModel: false,
        autoParse: true, prefix: '<think>', suffix: '</think>', promptPrefix: '<think>', trimSpaces: true, replyBias: '',
        regexScripts: [], regexEnabled: true, macroContext: { name1: 'User', name2: 'Bot' },
        ...overrides,
    };
}

function pending(overrides = {}) {
    return { isContinue: false, isSwipe: false, anchorContent: null, generationStop: { startedAt: Date.now() - 1000 }, finish: settings(), ...overrides };
}

describe('splitReasoningBlock', () => {
    const s = { prefix: '<think>', suffix: '</think>', trimSpaces: true };

    test('splits a block at the start, whitespace allowed before it', () => {
        assert.deepEqual(splitReasoningBlock('\n<think>\nplan\n</think>\n\nHello', s, false), { reasoning: 'plan', content: 'Hello' });
    });

    test('a block that is not at the start is not split', () => {
        assert.equal(splitReasoningBlock('Hi <think>x</think> there', s, false), null);
    });

    test('an unclosed block is not one when not streamed, and is all reasoning when streamed', () => {
        assert.equal(splitReasoningBlock('<think>still thinking', s, false), null);
        assert.deepEqual(splitReasoningBlock('<think>still thinking', s, true), { reasoning: 'still thinking', content: '' });
    });

    test('custom prefix and suffix match literally', () => {
        const custom = { prefix: '<|channel>thought', suffix: '<channel|>', trimSpaces: true };
        assert.deepEqual(splitReasoningBlock('<|channel>thought\nweighing it\n<channel|>Answer.', custom, false), { reasoning: 'weighing it', content: 'Answer.' });
        assert.deepEqual(splitReasoningBlock('<|channel>thought\nweighing it\n<channel|>Answer.', custom, true), { reasoning: 'weighing it', content: 'Answer.' });
    });

    test('trim_spaces off keeps the spaces', () => {
        assert.deepEqual(splitReasoningBlock('<think> a </think> b ', { ...s, trimSpaces: false }, false), { reasoning: ' a ', content: ' b ' });
    });
});

describe('finishReply', () => {
    test('auto-parse moves the block into extra.reasoning, type parsed (not streamed: no duration)', () => {
        const finished = finishReply(pending(), '<think>plan</think>\nHello there');
        assert.deepEqual(finished, {
            mes: 'Hello there',
            extra: { reasoning: 'plan', reasoning_duration: null, reasoning_signature: null, reasoning_type: 'parsed' },
        });
    });

    test('streamed: the duration runs from the request to the text after the block', () => {
        const p = pending({ generationStop: { startedAt: Date.now() - 5000 } });
        noteReplyText(p, '<think>pl');
        noteReplyText(p, '<think>plan</think>');
        assert.equal(p.replyStream.reasoningEndedAt, null, 'no text after the block yet');
        noteReplyText(p, '<think>plan</think>Hi');
        assert.ok(p.replyStream.reasoningEndedAt);
        const finished = finishReply(p, '<think>plan</think>Hi');
        assert.equal(finished.mes, 'Hi');
        assert.equal(finished.extra.reasoning, 'plan');
        assert.equal(finished.extra.reasoning_type, 'parsed');
        assert.ok(finished.extra.reasoning_duration >= 5000 && finished.extra.reasoning_duration < 60000, String(finished.extra.reasoning_duration));
    });

    test('auto-parse off leaves the text as generated', () => {
        const finished = finishReply(pending({ finish: settings({ autoParse: false }) }), '<think>plan</think>Hello');
        assert.equal(finished.mes, '<think>plan</think>Hello');
        assert.equal(finished.extra.reasoning, '');
        assert.equal('reasoning_type' in finished.extra, false);
    });

    test('"Start Reply With" starts the reply, so a <think> it opens is split off too', () => {
        const finished = finishReply(pending({ finish: settings({ replyBias: '<think>\n' }) }), 'plan\n</think>\nHello');
        assert.equal(finished.mes, 'Hello');
        assert.equal(finished.extra.reasoning, 'plan');
    });

    test('native reasoning of a non-streamed answer is kept, with no type, as upstream saveReply() stores it', () => {
        const p = pending({ finish: settings({ mainApi: 'openai', source: 'deepseek' }) });
        const data = { choices: [{ message: { content: 'Hi', reasoning_content: ' thought ' } }] };
        const finished = finishReply(p, 'Hi', { data });
        assert.deepEqual(finished, { mes: 'Hi', extra: { reasoning: 'thought', reasoning_duration: null, reasoning_signature: null } });
    });

    test('chat completion reasoning is dropped with "show thoughts" off', () => {
        const p = pending({ finish: settings({ mainApi: 'openai', source: 'deepseek', showThoughts: false, autoParse: false }) });
        const data = { choices: [{ message: { content: 'Hi', reasoning_content: 'thought' } }] };
        assert.equal(finishReply(p, 'Hi', { data }).extra.reasoning, '');
        noteReplyReasoning(p, 'thought');
        assert.equal(p.replyStream, undefined);
    });

    test('streamed native reasoning is type model, timed to the first text', () => {
        const p = pending({ finish: settings({ mainApi: 'openai', source: 'custom' }), generationStop: { startedAt: Date.now() - 2000 } });
        noteReplyReasoning(p, 'step one, ');
        noteReplyReasoning(p, 'step two');
        noteReplyText(p, 'Done');
        const finished = finishReply(p, 'Done');
        assert.equal(finished.mes, 'Done');
        assert.equal(finished.extra.reasoning, 'step one, step two');
        assert.equal(finished.extra.reasoning_type, 'model');
        assert.ok(finished.extra.reasoning_duration >= 2000);
    });

    test('native reasoning wins over a block in the text, which stays (as upstream)', () => {
        const p = pending();
        noteReplyReasoning(p, 'native');
        noteReplyText(p, '<think>x</think>y');
        const finished = finishReply(p, '<think>x</think>y');
        assert.equal(finished.extra.reasoning, 'native');
        assert.equal(finished.mes, '<think>x</think>y');
    });

    test('REASONING regex scripts apply to the reasoning', () => {
        const regexScripts = [{ scriptName: 'shout', findRegex: '/plan/g', replaceString: 'PLAN', placement: [6], disabled: false, trimStrings: [] }];
        const finished = finishReply(pending({ finish: settings({ regexScripts }) }), '<think>a plan</think>Hi');
        assert.equal(finished.extra.reasoning, 'a PLAN');
        assert.equal(finished.mes, 'Hi');
    });

    test('a continue lengthens the message, keeping its reasoning', () => {
        const anchorContent = { mes: 'Hello', extra: { reasoning: 'old', reasoning_type: 'parsed', reasoning_duration: 1200 } };
        const finished = finishReply(pending({ isContinue: true, anchorContent }), ' world');
        assert.deepEqual(finished, { mes: 'Hello world', extra: { reasoning: 'old', reasoning_duration: 1200, reasoning_signature: null, reasoning_type: 'parsed' } });
    });

    test('a continue of a message that is all reasoning continues the reasoning', () => {
        const anchorContent = { mes: '', extra: { reasoning: 'first,', reasoning_type: 'parsed' } };
        const finished = finishReply(pending({ isContinue: true, anchorContent }), ' second</think>Answer');
        assert.equal(finished.mes, 'Answer');
        assert.equal(finished.extra.reasoning, 'first, second');
    });

    test('no settings read (a caller that never set them): the text is stored as generated', () => {
        const finished = finishReply({ isContinue: false }, ' <think>x</think>y ');
        assert.equal(finished.mes, ' <think>x</think>y ');
    });
});

describe('extracting native reasoning (ports of the page\'s)', () => {
    test('Claude thinking blocks', () => {
        const data = { content: [{ type: 'thinking', thinking: 'a' }, { type: 'text', text: 'b' }, { type: 'thinking', thinking: 'c' }] };
        assert.equal(extractReasoningFromData(data, settings({ mainApi: 'openai', source: 'claude' })), 'a\n\nc');
    });

    test('Ollama thinking', () => {
        assert.equal(extractReasoningFromData({ thinking: 't' }, settings({ source: 'ollama' })), 't');
    });

    test('OpenRouter signature', () => {
        const data = { choices: [{ message: { reasoning_details: [{ id: 'tool_1', type: 'reasoning.encrypted', data: 'no' }, { id: 'r', type: 'reasoning.encrypted', data: 'sig' }] } }] };
        assert.equal(extractReasoningSignatureFromData(data, settings({ mainApi: 'openai', source: 'openrouter' })), 'sig');
    });
});
