import assert from 'node:assert/strict';
import { substituteParams, baseChatReplace } from './macro-substitution.js';

// {{user}}/{{char}}
assert.equal(substituteParams('Hello {{user}}, I am {{char}}.', { name1: 'Alice', name2: 'Bob' }), 'Hello Alice, I am Bob.');

// Legacy non-curly aliases
assert.equal(substituteParams('<USER> and <BOT> and <CHAR>', { name1: 'Alice', name2: 'Bob' }), 'Alice and Bob and Bob');

// Group macros: solo chat falls back to name2/name1
assert.equal(substituteParams('{{group}}', { name1: 'Alice', name2: 'Bob', isGroup: false }), 'Bob');
assert.equal(substituteParams('{{notChar}}', { name1: 'Alice', name2: 'Bob', isGroup: false }), 'Alice');

// Group macros: group chat
assert.equal(
    substituteParams('{{group}}', { name1: 'Alice', name2: 'Bob', isGroup: true, groupMembers: ['Bob', 'Carol'] }),
    'Bob, Carol',
);
assert.equal(
    substituteParams('{{groupNotMuted}}', { name1: 'Alice', name2: 'Bob', isGroup: true, groupMembers: ['Bob', 'Carol'], groupDisabledMembers: ['Carol'] }),
    'Bob',
);
assert.equal(
    substituteParams('{{notChar}}', { name1: 'Alice', name2: 'Bob', isGroup: true, groupMembers: ['Bob', 'Carol'] }),
    'Carol, Alice',
);

// Explicit group override wins over groupMembers-derived value
assert.equal(substituteParams('{{group}}', { name1: 'Alice', name2: 'Bob', group: 'Explicit Group' }), 'Explicit Group');

// {{original}} substitutes once, then goes empty on reuse
assert.equal(substituteParams('{{original}} / {{original}}', { original: 'ORIG' }), 'ORIG / ');

// Character card fields
assert.equal(
    substituteParams('{{description}} says {{personality}}', {
        name1: 'Alice', name2: 'Bob',
        characterCard: { description: 'A hero', personality: 'brave' },
    }),
    'A hero says brave',
);

// replaceCharacterCard: false suppresses card fields but keeps user/char
assert.equal(
    substituteParams('{{description}}{{user}}', {
        name1: 'Alice', name2: 'Bob', replaceCharacterCard: false,
        characterCard: { description: 'A hero' },
    }),
    '{{description}}Alice',
);

// {{model}}
assert.equal(substituteParams('{{model}}', { model: 'gpt-4' }), 'gpt-4');

// dynamicMacros override precedence (checked after built-ins are assigned, so they can add new keys)
assert.equal(substituteParams('{{custom}}', { dynamicMacros: { custom: 'value' } }), 'value');
assert.equal(substituteParams('{{custom}}', { dynamicMacros: { custom: () => 'fn-value' } }), 'fn-value');

// Pure utility macros
assert.equal(substituteParams('a{{newline}}b'), 'a\nb');
assert.equal(substituteParams('a{{noop}}b'), 'ab');
assert.equal(substituteParams('{{reverse:abc}}'), 'cba');
assert.equal(substituteParams('before{{//a comment}}after'), 'beforeafter');
assert.equal(substituteParams('no macros here'), 'no macros here');
assert.equal(substituteParams(''), '');

// {{trim}} eats surrounding newlines
assert.equal(substituteParams('a\n{{trim}}\nb'), 'ab');

// {{roll}}
{
    const result = substituteParams('{{roll:1d1}}'); // 1d1 is deterministic: always 1
    assert.equal(result, '1');
}
assert.equal(substituteParams('{{roll:20}}').length > 0, true); // bare number -> 1dN, just check it produces a number
assert.equal(substituteParams('{{roll:not-a-formula}}'), '');

// {{timeDiff}}
assert.equal(typeof substituteParams('{{timeDiff::2024-01-01::2024-01-02}}'), 'string');

// baseChatReplace: substitutes but does not re-expand character-card macros
assert.equal(baseChatReplace('Hi {{user}}, {{description}} stays literal', { name1: 'Alice' }), 'Hi Alice, {{description}} stays literal');
assert.equal(baseChatReplace(''), '');
assert.equal(baseChatReplace(null), null);

// Message-history family: exclude an in-progress swipe (swipe_id >= swipes.length)
{
    const chat = [
        { mes: 'Hello', is_user: true, send_date: Date.now() - 100000 },
        { mes: 'Hi there', is_user: false, swipes: ['Hi there', 'Yo'], swipe_id: 0, send_date: Date.now() - 50000 },
        { mes: '', is_user: false, swipes: ['Hi there'], swipe_id: 1 },
    ];
    assert.equal(substituteParams('{{lastMessage}}', { chat }), 'Hi there');
    assert.equal(substituteParams('{{lastMessageId}}', { chat }), '1');
    assert.equal(substituteParams('{{lastUserMessage}}', { chat }), 'Hello');
    assert.equal(substituteParams('{{lastCharMessage}}', { chat }), 'Hi there');
    assert.equal(substituteParams('{{lastSwipeId}}', { chat }), '1');
    assert.equal(substituteParams('{{currentSwipeId}}', { chat }), '2');
    assert.equal(substituteParams('{{allChatRange}}', { chat }), '0-2');
    assert.equal(typeof substituteParams('{{idle_duration}}', { chat }), 'string');
}

// chatMetadata-derived: {{firstIncludedMessageId}}, {{firstDisplayedMessageId}}, {{input}}
assert.equal(substituteParams('{{firstIncludedMessageId}}', { chatMetadata: { lastInContextMessageId: 5 } }), '5');
assert.equal(substituteParams('{{firstDisplayedMessageId}}', { firstDisplayedMessageId: 2 }), '2');
assert.equal(substituteParams('{{input}}', { currentInput: 'draft text' }), 'draft text');

// Local/global variables read/write the passed-in mutable objects
{
    const chatMetadata = { variables: {} };
    substituteParams('{{setvar::score::10}}', { chatMetadata });
    assert.equal(chatMetadata.variables.score, '10');
    assert.equal(substituteParams('{{getvar::score}}', { chatMetadata }), '10');
    substituteParams('{{incvar::score}}', { chatMetadata });
    assert.equal(substituteParams('{{getvar::score}}', { chatMetadata }), '11');
    substituteParams('{{decvar::score}}', { chatMetadata });
    assert.equal(substituteParams('{{getvar::score}}', { chatMetadata }), '10');

    const globalVariables = {};
    substituteParams('{{setglobalvar::flag::yes}}', { globalVariables });
    assert.equal(globalVariables.flag, 'yes');
    assert.equal(substituteParams('{{getglobalvar::flag}}', { globalVariables }), 'yes');
}

// {{banned}} resolves to empty and reports the word via the sink instead of a module-level global
{
    const bannedWordsSink = [];
    assert.equal(substituteParams('before {{banned "badword"}} after', { bannedWordsSink }), 'before  after');
    assert.deepEqual(bannedWordsSink, ['badword']);
}

// {{random}}/{{pick}}: pick from the list; pick is deterministic for the same chatId+content+offset
{
    const randomResult = substituteParams('{{random::a::b::c}}', {});
    assert.equal(['a', 'b', 'c'].includes(randomResult), true);

    const pick1 = substituteParams('{{pick::a::b::c}}', { chatId: 'chat-1' });
    const pick2 = substituteParams('{{pick::a::b::c}}', { chatId: 'chat-1' });
    assert.equal(pick1, pick2);
    assert.equal(['a', 'b', 'c'].includes(pick1), true);
}

console.log('macro-substitution.test.js: all assertions passed');
