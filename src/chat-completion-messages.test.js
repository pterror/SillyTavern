import assert from 'node:assert/strict';
import {
    character_names_behavior,
    MEDIA_DISPLAY,
    getMediaDisplay,
    getMediaIndex,
    buildChatCompletionMessages,
    parseExampleIntoIndividual,
    buildChatCompletionMessageExamples,
} from './chat-completion-messages.js';
import { IGNORE_SYMBOL } from './prompt-line-formatting.js';

let passed = 0;
function test(name, fn) {
    fn();
    passed++;
    console.log(`ok - ${name}`);
}

// ---- getMediaDisplay ----

test('getMediaDisplay: default fallback to LIST when nothing set', () => {
    assert.equal(getMediaDisplay({}), MEDIA_DISPLAY.LIST);
    assert.equal(getMediaDisplay(undefined), MEDIA_DISPLAY.LIST);
});

test('getMediaDisplay: falls back to mediaDisplaySetting param', () => {
    assert.equal(getMediaDisplay({}, { mediaDisplaySetting: MEDIA_DISPLAY.GALLERY }), MEDIA_DISPLAY.GALLERY);
});

test('getMediaDisplay: per-message override wins over setting', () => {
    const mes = { extra: { media_display: MEDIA_DISPLAY.GALLERY } };
    assert.equal(getMediaDisplay(mes, { mediaDisplaySetting: MEDIA_DISPLAY.LIST }), MEDIA_DISPLAY.GALLERY);
});

test('getMediaDisplay: invalid value falls back to LIST', () => {
    const mes = { extra: { media_display: 'bogus' } };
    assert.equal(getMediaDisplay(mes), MEDIA_DISPLAY.LIST);
});

// ---- getMediaIndex ----

test('getMediaIndex: no media array -> 0', () => {
    assert.equal(getMediaIndex({}), 0);
    assert.equal(getMediaIndex({ extra: { media: 'not-an-array' } }), 0);
});

test('getMediaIndex: valid index passed through', () => {
    const mes = { extra: { media: ['a', 'b', 'c'], media_index: 2 } };
    assert.equal(getMediaIndex(mes), 2);
});

test('getMediaIndex: out-of-bounds index clamps to 0', () => {
    const mes = { extra: { media: ['a', 'b'], media_index: 5 } };
    assert.equal(getMediaIndex(mes), 0);
    const negative = { extra: { media: ['a', 'b'], media_index: -1 } };
    assert.equal(getMediaIndex(negative), 0);
    const nanIdx = { extra: { media: ['a', 'b'], media_index: NaN } };
    assert.equal(getMediaIndex(nanIdx), 0);
});

// ---- buildChatCompletionMessages ----

test('buildChatCompletionMessages: basic role assignment', () => {
    // chat is oldest-first (chat[0] = oldest, matching the client's chat.push()-appends-newest
    // convention - see public/script.js's `chat.push(message)` call sites). The ported loop reads
    // chat[j] forward (j: 0 -> length-1) while writing messages[i] backward (i: length-1 -> 0), so
    // for a 2-element chat the oldest message (chat[0]) lands at messages[1] and the newest
    // (chat[1]) lands at messages[0] - preserved exactly from the client, not "fixed".
    const chat = [
        { is_user: true, mes: 'hi', name: 'User', extra: {} },
        { is_user: false, mes: 'hello', name: 'Bot', extra: {} },
    ];
    const messages = buildChatCompletionMessages(chat, {
        name1: 'User', name2: 'Bot', namesBehavior: character_names_behavior.NONE,
    });
    assert.equal(messages.length, 2);
    assert.equal(messages[1].role, 'user');
    assert.equal(messages[1].content, 'hi');
    assert.equal(messages[0].role, 'assistant');
    assert.equal(messages[0].content, 'hello');
});

test('buildChatCompletionMessages: narrator overrides role to system', () => {
    const chat = [
        { is_user: false, mes: 'The wind blows.', name: 'Narrator', extra: { type: 'narrator' } },
    ];
    const messages = buildChatCompletionMessages(chat, {
        name1: 'User', name2: 'Bot', namesBehavior: character_names_behavior.NONE,
    });
    assert.equal(messages[0].role, 'system');
});

test('buildChatCompletionMessages: IGNORE_SYMBOL skip leaves a gap, not a compacted array', () => {
    // chat is oldest-first: index 0 = 'first' (oldest), index 1 = hidden, index 2 = 'third' (newest).
    // The read cursor j walks chat forward (0, 1, 2, ...) while the write cursor i walks messages
    // backward (length-1, ..., 0) in lockstep per *iteration* (not per write). So:
    //   iteration 1: i=2, j=0 -> reads chat[0] ('first'), writes messages[2]; j becomes 1
    //   iteration 2: i=1, j=1 -> reads chat[1] (IGNORE_SYMBOL) -> j becomes 2, `continue` - messages[1] is never written
    //   iteration 3: i=0, j=2 -> reads chat[2] ('third'), writes messages[0]; j becomes 3
    // So the gap left by the skip lands at messages[1], not shifted to compact the array, and the
    // surviving entries end up reversed relative to chat's oldest-to-newest order.
    const chat = [
        { is_user: true, mes: 'first', name: 'User', extra: {} },
        { is_user: false, mes: 'hidden', name: 'Bot', extra: { [IGNORE_SYMBOL]: true } },
        { is_user: false, mes: 'third', name: 'Bot', extra: {} },
    ];
    const messages = buildChatCompletionMessages(chat, {
        name1: 'User', name2: 'Bot', namesBehavior: character_names_behavior.NONE,
    });
    // length still reflects the highest written index + 1 (index 2 was written)
    assert.equal(messages.length, 3);
    assert.equal(messages[2].content, 'first');
    assert.equal(messages[0].content, 'third');
    // index 1 must be a genuine hole, not an explicit undefined assignment
    assert.equal(1 in messages, false);
    assert.equal(messages[1], undefined);
});

test('buildChatCompletionMessages: character_names_behavior.NONE never prepends name', () => {
    const chat = [{ is_user: false, mes: 'hey', name: 'Bot', extra: {}, force_avatar: 'x' }];
    const messages = buildChatCompletionMessages(chat, {
        isGroup: true, name1: 'User', name2: 'Zzz', namesBehavior: character_names_behavior.NONE,
    });
    assert.equal(messages[0].content, 'hey');
});

test('buildChatCompletionMessages: character_names_behavior.COMPLETION never prepends name', () => {
    const chat = [{ is_user: false, mes: 'hey', name: 'Bot', extra: {}, force_avatar: 'x' }];
    const messages = buildChatCompletionMessages(chat, {
        isGroup: true, name1: 'User', name2: 'Zzz', namesBehavior: character_names_behavior.COMPLETION,
    });
    assert.equal(messages[0].content, 'hey');
});

test('buildChatCompletionMessages: character_names_behavior.CONTENT prepends name unless narrator', () => {
    // chat[0] (oldest) -> messages[1]; chat[1] (newest) -> messages[0] (see the reversal note above).
    const chat = [
        { is_user: false, mes: 'hey', name: 'Bot', extra: {} },
        { is_user: false, mes: 'narrated', name: 'Narrator', extra: { type: 'narrator' } },
    ];
    const messages = buildChatCompletionMessages(chat, {
        name1: 'User', name2: 'Bot', namesBehavior: character_names_behavior.CONTENT,
    });
    assert.equal(messages[1].content, 'Bot: hey');
    assert.equal(messages[0].content, 'narrated');
});

test('buildChatCompletionMessages: DEFAULT case - group membership trigger', () => {
    const chat = [{ is_user: false, mes: 'hey', name: 'Other', extra: {} }];
    const messages = buildChatCompletionMessages(chat, {
        isGroup: true, name1: 'User', name2: 'Bot', namesBehavior: character_names_behavior.DEFAULT,
    });
    assert.equal(messages[0].content, 'Other: hey');
});

test('buildChatCompletionMessages: DEFAULT case - group but name matches name1, no prepend', () => {
    const chat = [{ is_user: true, mes: 'hey', name: 'User', extra: {} }];
    const messages = buildChatCompletionMessages(chat, {
        isGroup: true, name1: 'User', name2: 'Bot', namesBehavior: character_names_behavior.DEFAULT,
    });
    assert.equal(messages[0].content, 'hey');
});

test('buildChatCompletionMessages: DEFAULT case - force_avatar trigger (non-group)', () => {
    const chat = [{ is_user: false, mes: 'hey', name: 'Someone', extra: {}, force_avatar: 'avatar.png' }];
    const messages = buildChatCompletionMessages(chat, {
        isGroup: false, name1: 'User', name2: 'Bot', namesBehavior: character_names_behavior.DEFAULT,
    });
    assert.equal(messages[0].content, 'Someone: hey');
});

test('buildChatCompletionMessages: DEFAULT case - force_avatar but narrator suppresses prepend', () => {
    const chat = [{ is_user: false, mes: 'hey', name: 'Someone', extra: { type: 'narrator' }, force_avatar: 'avatar.png' }];
    const messages = buildChatCompletionMessages(chat, {
        isGroup: false, name1: 'User', name2: 'Bot', namesBehavior: character_names_behavior.DEFAULT,
    });
    assert.equal(messages[0].content, 'hey');
});

test('buildChatCompletionMessages: DEFAULT case - force_avatar but name matches name1, no prepend', () => {
    const chat = [{ is_user: false, mes: 'hey', name: 'User', extra: {}, force_avatar: 'avatar.png' }];
    const messages = buildChatCompletionMessages(chat, {
        isGroup: false, name1: 'User', name2: 'Bot', namesBehavior: character_names_behavior.DEFAULT,
    });
    assert.equal(messages[0].content, 'hey');
});

test('buildChatCompletionMessages: strips carriage returns', () => {
    const chat = [{ is_user: true, mes: 'line1\r\nline2\r', name: 'User', extra: {} }];
    const messages = buildChatCompletionMessages(chat, {
        name1: 'User', name2: 'Bot', namesBehavior: character_names_behavior.NONE,
    });
    assert.equal(messages[0].content, 'line1\nline2');
});

test('buildChatCompletionMessages: same-model reasoning/signature pass through', () => {
    const chat = [{
        is_user: false, mes: 'hi', name: 'Bot',
        extra: { api: 'openai', model: 'gpt-x', reasoning: 'thinking...', reasoning_signature: 'sig123' },
    }];
    const messages = buildChatCompletionMessages(chat, {
        name1: 'User', name2: 'Bot', namesBehavior: character_names_behavior.NONE,
        currentApi: 'openai', currentModel: 'gpt-x',
    });
    assert.equal(messages[0].reasoning, 'thinking...');
    assert.equal(messages[0].signature, 'sig123');
});

test('buildChatCompletionMessages: different-model reasoning/signature stripped from top-level fields', () => {
    const chat = [{
        is_user: false, mes: 'hi', name: 'Bot',
        extra: { api: 'openai', model: 'gpt-old', reasoning: 'thinking...', reasoning_signature: 'sig123' },
    }];
    const messages = buildChatCompletionMessages(chat, {
        name1: 'User', name2: 'Bot', namesBehavior: character_names_behavior.NONE,
        currentApi: 'openai', currentModel: 'gpt-new',
    });
    assert.equal(messages[0].reasoning, '');
    assert.equal(messages[0].signature, null);
});

test('buildChatCompletionMessages: different-model invocation cloning strips signature/reasoning, leaves original untouched', () => {
    const originalInvocation = { id: '1', signature: 'sig', reasoning: 'why', name: 'tool_a' };
    const chat = [{
        is_user: false, mes: 'hi', name: 'Bot',
        extra: {
            api: 'openai', model: 'gpt-old',
            tool_invocations: [originalInvocation],
        },
    }];
    const messages = buildChatCompletionMessages(chat, {
        name1: 'User', name2: 'Bot', namesBehavior: character_names_behavior.NONE,
        currentApi: 'openai', currentModel: 'gpt-new',
    });
    // Original object must be untouched
    assert.equal(originalInvocation.signature, 'sig');
    assert.equal(originalInvocation.reasoning, 'why');
    // The result's invocation must be a different object with the fields stripped
    const resultInvocation = messages[0].invocations[0];
    assert.notEqual(resultInvocation, originalInvocation);
    assert.equal('signature' in resultInvocation, false);
    assert.equal('reasoning' in resultInvocation, false);
    assert.equal(resultInvocation.id, '1');
    assert.equal(resultInvocation.name, 'tool_a');
});

test('buildChatCompletionMessages: same-model invocations pass through unmodified (same object)', () => {
    const originalInvocation = { id: '1', signature: 'sig', reasoning: 'why' };
    const chat = [{
        is_user: false, mes: 'hi', name: 'Bot',
        extra: {
            api: 'openai', model: 'gpt-x',
            tool_invocations: [originalInvocation],
        },
    }];
    const messages = buildChatCompletionMessages(chat, {
        name1: 'User', name2: 'Bot', namesBehavior: character_names_behavior.NONE,
        currentApi: 'openai', currentModel: 'gpt-x',
    });
    assert.equal(messages[0].invocations[0].signature, 'sig');
    assert.equal(messages[0].invocations[0].reasoning, 'why');
});

test('buildChatCompletionMessages: isOtherGroupMember suppresses reasoning/signature even if same model', () => {
    const chat = [{
        is_user: false, mes: 'hi', name: 'OtherBot',
        extra: { api: 'openai', model: 'gpt-x', reasoning: 'thinking...', reasoning_signature: 'sig123' },
    }];
    const messages = buildChatCompletionMessages(chat, {
        isGroup: true, name1: 'User', name2: 'Bot', namesBehavior: character_names_behavior.NONE,
        currentApi: 'openai', currentModel: 'gpt-x',
    });
    assert.equal(messages[0].reasoning, '');
    assert.equal(messages[0].signature, null);
});

test('buildChatCompletionMessages: reasoning allowed for the currently generating group member (name matches name2)', () => {
    const chat = [{
        is_user: false, mes: 'hi', name: 'Bot',
        extra: { api: 'openai', model: 'gpt-x', reasoning: 'thinking...', reasoning_signature: 'sig123' },
    }];
    const messages = buildChatCompletionMessages(chat, {
        isGroup: true, name1: 'User', name2: 'Bot', namesBehavior: character_names_behavior.NONE,
        currentApi: 'openai', currentModel: 'gpt-x',
    });
    assert.equal(messages[0].reasoning, 'thinking...');
    assert.equal(messages[0].signature, 'sig123');
});

// ---- parseExampleIntoIndividual ----

test('parseExampleIntoIndividual: simple 2-turn example block', () => {
    const block = '{Example Dialogue:}\nUser: hello there\nBot: hi, how are you?';
    const result = parseExampleIntoIndividual(block, { name1: 'User', name2: 'Bot' });
    assert.deepEqual(result, [
        { role: 'system', content: 'hello there', name: 'example_user' },
        { role: 'system', content: 'hi, how are you?', name: 'example_assistant' },
    ]);
});

test('parseExampleIntoIndividual: group chat with non-name2 bot name via groupBotNames', () => {
    const block = '{Example Dialogue:}\nUser: hello there\nGroupie: hi from groupie';
    const result = parseExampleIntoIndividual(block, {
        name1: 'User', name2: 'Bot', isGroup: true, groupBotNames: ['Groupie:'], appendNamesForGroup: false,
    });
    assert.deepEqual(result, [
        { role: 'system', content: 'hello there', name: 'example_user' },
        { role: 'system', content: 'hi from groupie', name: 'example_assistant' },
    ]);
});

test('parseExampleIntoIndividual: appendNamesForGroup toggle prepends name when true, isGroup true', () => {
    const block = '{Example Dialogue:}\nUser: hello there\nBot: hi there';
    const withNames = parseExampleIntoIndividual(block, {
        name1: 'User', name2: 'Bot', isGroup: true, appendNamesForGroup: true,
    });
    assert.equal(withNames[0].content, 'User: hello there');
    assert.equal(withNames[1].content, 'Bot: hi there');

    const withoutNames = parseExampleIntoIndividual(block, {
        name1: 'User', name2: 'Bot', isGroup: true, appendNamesForGroup: false,
    });
    assert.equal(withoutNames[0].content, 'hello there');
    assert.equal(withoutNames[1].content, 'hi there');
});

test('parseExampleIntoIndividual: appendNamesForGroup has no effect when isGroup is false', () => {
    const block = '{Example Dialogue:}\nUser: hello there\nBot: hi there';
    const result = parseExampleIntoIndividual(block, {
        name1: 'User', name2: 'Bot', isGroup: false, appendNamesForGroup: true,
    });
    assert.equal(result[0].content, 'hello there');
    assert.equal(result[1].content, 'hi there');
});

test('parseExampleIntoIndividual: unflushed final block still gets added', () => {
    // Ends mid-bot-message with no following user line to trigger the flush.
    const block = '{Example Dialogue:}\nUser: question\nBot: this is the final unflushed answer';
    const result = parseExampleIntoIndividual(block, { name1: 'User', name2: 'Bot' });
    assert.equal(result.length, 2);
    assert.equal(result[1].content, 'this is the final unflushed answer');
    assert.equal(result[1].name, 'example_assistant');
});

test('parseExampleIntoIndividual: unflushed final user block also gets added', () => {
    const block = '{Example Dialogue:}\nBot: opening line\nUser: trailing unflushed question';
    const result = parseExampleIntoIndividual(block, { name1: 'User', name2: 'Bot' });
    assert.equal(result.length, 2);
    assert.equal(result[1].content, 'trailing unflushed question');
    assert.equal(result[1].name, 'example_user');
});

// ---- buildChatCompletionMessageExamples ----

test('buildChatCompletionMessageExamples: multiple blocks parsed independently', () => {
    const examples = [
        '<START>\nUser: hi\nBot: hello',
        '<START>\nUser: bye\nBot: goodbye',
    ];
    const result = buildChatCompletionMessageExamples(examples, { name1: 'User', name2: 'Bot' });
    assert.equal(result.length, 2);
    assert.equal(result[0][0].content, 'hi');
    assert.equal(result[0][1].content, 'hello');
    assert.equal(result[1][0].content, 'bye');
    assert.equal(result[1][1].content, 'goodbye');
});

test('buildChatCompletionMessageExamples: <START> replaced with {Example Dialogue:} and consumed as header line', () => {
    // If <START> were not replaced/skipped as the header line, "User: hi" would still parse fine
    // regardless; verify indirectly by checking the case-insensitive match and \r stripping.
    const examples = ['<start>\r\nUser: hi\r\nBot: hello\r'];
    const result = buildChatCompletionMessageExamples(examples, { name1: 'User', name2: 'Bot' });
    assert.equal(result[0][0].content, 'hi');
    assert.equal(result[0][1].content, 'hello');
});

console.log(`\n${passed} tests passed.`);
