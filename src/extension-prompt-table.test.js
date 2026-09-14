import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    createExtensionPromptTable,
    setExtensionPrompt,
    getExtensionPrompt,
    getExtensionPromptByName,
    getOccupiedInChatDepths,
    doChatInject,
    extension_prompt_types,
    extension_prompt_roles,
} from './extension-prompt-table.js';

test('setExtensionPrompt/getExtensionPrompt: basic store and retrieve', () => {
    const table = createExtensionPromptTable();
    setExtensionPrompt(table, 'mykey', 'hello world', extension_prompt_types.IN_PROMPT, 0);
    const result = getExtensionPrompt(table, { position: extension_prompt_types.IN_PROMPT });
    assert.equal(result, '\nhello world\n', 'default wrap=true should wrap with the default separator');
});

test('getExtensionPrompt: position filtering', () => {
    const table = createExtensionPromptTable();
    setExtensionPrompt(table, 'a', 'in-prompt-value', extension_prompt_types.IN_PROMPT, 0);
    setExtensionPrompt(table, 'b', 'in-chat-value', extension_prompt_types.IN_CHAT, 0);

    const inPrompt = getExtensionPrompt(table, { position: extension_prompt_types.IN_PROMPT, wrap: false });
    const inChat = getExtensionPrompt(table, { position: extension_prompt_types.IN_CHAT, wrap: false });

    assert.equal(inPrompt, 'in-prompt-value');
    assert.equal(inChat, 'in-chat-value');
});

test('getExtensionPrompt: depth filtering, including "undefined matches any" semantics', () => {
    const table = createExtensionPromptTable();
    setExtensionPrompt(table, 'depth3', 'depth-3-value', extension_prompt_types.IN_CHAT, 3);
    setExtensionPrompt(table, 'depth5', 'depth-5-value', extension_prompt_types.IN_CHAT, 5);

    // Querying a specific depth only returns the matching entry.
    assert.equal(getExtensionPrompt(table, { position: extension_prompt_types.IN_CHAT, depth: 3, wrap: false }), 'depth-3-value');
    assert.equal(getExtensionPrompt(table, { position: extension_prompt_types.IN_CHAT, depth: 5, wrap: false }), 'depth-5-value');
    // A depth with nothing stored returns ''.
    assert.equal(getExtensionPrompt(table, { position: extension_prompt_types.IN_CHAT, depth: 4, wrap: false }), '');

    // Querying with depth === undefined matches every entry regardless of its own depth.
    const both = getExtensionPrompt(table, { position: extension_prompt_types.IN_CHAT, depth: undefined, wrap: false, separator: '|' });
    assert.equal(both, 'depth-3-value|depth-5-value');
});

test('getExtensionPrompt: role filtering, including "undefined matches any" semantics', () => {
    const table = createExtensionPromptTable();
    setExtensionPrompt(table, 'sys', 'system-value', extension_prompt_types.IN_CHAT, 1, false, extension_prompt_roles.SYSTEM);
    setExtensionPrompt(table, 'usr', 'user-value', extension_prompt_types.IN_CHAT, 1, false, extension_prompt_roles.USER);

    assert.equal(
        getExtensionPrompt(table, { position: extension_prompt_types.IN_CHAT, depth: 1, role: extension_prompt_roles.SYSTEM, wrap: false }),
        'system-value',
    );
    assert.equal(
        getExtensionPrompt(table, { position: extension_prompt_types.IN_CHAT, depth: 1, role: extension_prompt_roles.ASSISTANT, wrap: false }),
        '',
    );
    // role === undefined matches any role.
    const anyRole = getExtensionPrompt(table, { position: extension_prompt_types.IN_CHAT, depth: 1, role: undefined, wrap: false, separator: '|' });
    assert.equal(anyRole, 'system-value|user-value');
});

test('getExtensionPrompt: multi-entry joining is alphabetical-by-key and separator-joined', () => {
    const table = createExtensionPromptTable();
    setExtensionPrompt(table, 'zkey', 'last-alphabetically', extension_prompt_types.IN_CHAT, 2);
    setExtensionPrompt(table, 'akey', 'first-alphabetically', extension_prompt_types.IN_CHAT, 2);

    const joined = getExtensionPrompt(table, { position: extension_prompt_types.IN_CHAT, depth: 2, wrap: false, separator: ' :: ' });
    assert.equal(joined, 'first-alphabetically :: last-alphabetically');
});

test('getExtensionPrompt: wrap behavior wraps with a leading/trailing separator only when non-empty and not already present', () => {
    const emptyTable = createExtensionPromptTable();
    // Empty result: wrap should not add anything.
    assert.equal(getExtensionPrompt(emptyTable, { position: extension_prompt_types.IN_PROMPT, wrap: true }), '');

    const table = createExtensionPromptTable();
    setExtensionPrompt(table, 'a', 'value-without-separators', extension_prompt_types.IN_PROMPT, 0);
    const wrapped = getExtensionPrompt(table, { position: extension_prompt_types.IN_PROMPT, wrap: true, separator: '\n' });
    assert.equal(wrapped, '\nvalue-without-separators\n');

    // A value that already starts/ends with the separator (post-trim) should not get a duplicate
    // wrap. Since `.trim()` strips whitespace, a whitespace separator (like the default '\n') can
    // never survive at the edges of a trimmed value - so use a non-whitespace separator to actually
    // exercise the "already present" skip branch.
    const alreadyWrappedTable = createExtensionPromptTable();
    setExtensionPrompt(alreadyWrappedTable, 'a', '|already-wrapped|', extension_prompt_types.IN_PROMPT, 0);
    const notDoubled = getExtensionPrompt(alreadyWrappedTable, { position: extension_prompt_types.IN_PROMPT, wrap: true, separator: '|' });
    assert.equal(notDoubled, '|already-wrapped|', 'should not add duplicate separators when already present');
});

test('getExtensionPrompt: macro substitution runs on the joined result', () => {
    const table = createExtensionPromptTable();
    setExtensionPrompt(table, 'a', 'Hello {{user}}!', extension_prompt_types.IN_PROMPT, 0);
    const result = getExtensionPrompt(table, { position: extension_prompt_types.IN_PROMPT, wrap: false }, { name1: 'Alice' });
    assert.equal(result, 'Hello Alice!');
});

test('getExtensionPromptByName: looks up one key and macro-substitutes it', () => {
    const table = createExtensionPromptTable();
    setExtensionPrompt(table, 'mymodule', 'Hi {{user}}', extension_prompt_types.IN_PROMPT, 0);
    assert.equal(getExtensionPromptByName(table, 'mymodule', { name1: 'Bob' }), 'Hi Bob');
    assert.equal(getExtensionPromptByName(table, 'missing'), '');
    assert.equal(getExtensionPromptByName(table, ''), '');
});

test('getOccupiedInChatDepths: only returns depths with a stored, non-empty IN_CHAT entry, sorted ascending', () => {
    const table = createExtensionPromptTable();
    setExtensionPrompt(table, 'a', 'value', extension_prompt_types.IN_CHAT, 5);
    setExtensionPrompt(table, 'b', 'value', extension_prompt_types.IN_CHAT, 1);
    setExtensionPrompt(table, 'c', '', extension_prompt_types.IN_CHAT, 2); // empty value - excluded
    setExtensionPrompt(table, 'd', 'value', extension_prompt_types.IN_PROMPT, 3); // wrong position - excluded
    assert.deepEqual(getOccupiedInChatDepths(table), [1, 5]);
});

test('doChatInject: SYSTEM/USER/ASSISTANT priority ordering at one depth', () => {
    const table = createExtensionPromptTable();
    setExtensionPrompt(table, 'sys', 'system-text', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
    setExtensionPrompt(table, 'usr', 'user-text', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.USER);
    setExtensionPrompt(table, 'asst', 'assistant-text', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.ASSISTANT);

    const coreChat = [
        { name: 'User', mes: 'oldest', is_user: true },
        { name: 'Aria', mes: 'newest', is_user: false },
    ];

    const { coreChat: result, injectedIndices } = doChatInject(coreChat, false, { name1: 'User', name2: 'Aria', table });

    // Depth 0 = newest. Internally the three role messages are spliced, in SYSTEM/USER/ASSISTANT
    // priority order, at the front of the REVERSED (newest-first) working array; reversing back to
    // normal order at the end therefore flips that block to ASSISTANT/USER/SYSTEM, appended after
    // the two original (normal-order) messages.
    assert.equal(result.length, 5);
    assert.deepEqual(result.map((m) => m.mes), ['oldest', 'newest', 'assistant-text', 'user-text', 'system-text']);

    // injectedIndices are in the REVERSED index space (see DoChatInjectResult's doc comment) -
    // verify by indexing into [...result].reverse(), which is what fillContextBudget's chat2 array
    // uses downstream. In that reversed space, the three role messages come first, in SYSTEM/USER/
    // ASSISTANT priority order.
    const reversed = [...result].reverse();
    assert.deepEqual(injectedIndices, [0, 1, 2]);
    assert.deepEqual(injectedIndices.map((i) => reversed[i].mes), ['system-text', 'user-text', 'assistant-text']);
    assert.equal(reversed[0].extra.type, 'narrator');
    assert.equal(reversed[1].name, 'User');
    assert.equal(reversed[1].is_user, true);
    assert.equal(reversed[2].name, 'Aria');
    assert.equal(reversed[2].is_user, false);

    // Original array must not be mutated.
    assert.equal(coreChat.length, 2);
});

test('doChatInject: totalInsertedMessages correctly offsets later depths\' injection index', () => {
    const table = createExtensionPromptTable();
    // Depth 0 (newest): one SYSTEM message.
    setExtensionPrompt(table, 'd0', 'depth-0-text', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
    // Depth 1: one SYSTEM message - should land one further back, *and* be shifted further by the
    // depth-0 injection already having added a message.
    setExtensionPrompt(table, 'd1', 'depth-1-text', extension_prompt_types.IN_CHAT, 1, false, extension_prompt_roles.SYSTEM);

    const coreChat = [
        { name: 'User', mes: 'first', is_user: true },
        { name: 'Aria', mes: 'second', is_user: false },
        { name: 'User', mes: 'third', is_user: true },
    ];

    const { coreChat: result, injectedIndices } = doChatInject(coreChat, false, { name1: 'User', name2: 'Aria', table });

    // Reversed working order is [third, second, first]. Depth 0 injects at index min(0+0,3)=0 in the
    // reversed array -> reversed becomes [depth-0-text, third, second, first], totalInserted=1.
    // Depth 1 injects at index min(1+1,4)=2 in the reversed array (note: the "+1" IS
    // totalInsertedMessages already offsetting this later depth by the earlier depth-0 insertion) ->
    // reversed becomes [depth-0-text, third, depth-1-text, second, first].
    // Un-reversed (the returned `coreChat`): [first, second, depth-1-text, third, depth-0-text].
    assert.deepEqual(result.map((m) => m.mes), ['first', 'second', 'depth-1-text', 'third', 'depth-0-text']);

    // injectedIndices are in the REVERSED index space - i.e. indices into
    // [depth-0-text, third, depth-1-text, second, first], where depth-0-text is at 0 and
    // depth-1-text is at 2. This confirms totalInsertedMessages correctly offset the later depth.
    const reversed = [...result].reverse();
    assert.deepEqual(injectedIndices, [0, 2]);
    assert.deepEqual(injectedIndices.map((i) => reversed[i].mes), ['depth-0-text', 'depth-1-text']);
});

test('doChatInject: isContinue depth-0-becomes-1 special case', () => {
    const table = createExtensionPromptTable();
    setExtensionPrompt(table, 'd0', 'depth-0-text', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);

    const coreChat = [
        { name: 'User', mes: 'first', is_user: true },
        { name: 'Aria', mes: 'second', is_user: false },
    ];

    const notContinue = doChatInject(coreChat, false, { name1: 'User', name2: 'Aria', table });
    // Not continuing: depth 0 injects right at the reversed-array head (index 0) -> ends up as the
    // very last message overall.
    assert.deepEqual(notContinue.coreChat.map((m) => m.mes), ['first', 'second', 'depth-0-text']);

    const continued = doChatInject(coreChat, true, { name1: 'User', name2: 'Aria', table });
    // Continuing: depth 0 becomes depth 1, so it injects one further back in the reversed array
    // (index 1) -> ends up second-to-last overall instead of last.
    assert.deepEqual(continued.coreChat.map((m) => m.mes), ['first', 'depth-0-text', 'second']);
});

test('doChatInject: injectedIndices correctly locate spliced messages after multiple depths of splicing', () => {
    const table = createExtensionPromptTable();
    setExtensionPrompt(table, 'd0sys', 'd0-sys', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
    setExtensionPrompt(table, 'd0usr', 'd0-usr', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.USER);
    setExtensionPrompt(table, 'd2sys', 'd2-sys', extension_prompt_types.IN_CHAT, 2, false, extension_prompt_roles.SYSTEM);

    const coreChat = [
        { mes: 'm0', is_user: true },
        { mes: 'm1', is_user: false },
        { mes: 'm2', is_user: true },
        { mes: 'm3', is_user: false },
    ];

    const { coreChat: result, injectedIndices } = doChatInject(coreChat, false, { name1: 'U', name2: 'A', table });

    // injectedIndices are in the REVERSED index space (see DoChatInjectResult's doc comment), i.e.
    // indices into [...result].reverse() - which is exactly the array fillContextBudget's chat2
    // indexes into downstream.
    const reversed = [...result].reverse();
    for (const idx of injectedIndices) {
        assert.ok(idx >= 0 && idx < reversed.length, `index ${idx} should be a valid position in the reversed array`);
    }
    // Every message flagged as injected should actually be one of the synthetic ones (identifiable
    // by its text, since none of the original fixture messages share these strings), and in the
    // SYSTEM/USER priority order they were generated in for depth 0, followed by depth 2.
    assert.deepEqual(injectedIndices.map((i) => reversed[i].mes), ['d0-sys', 'd0-usr', 'd2-sys']);
    // Every original message must still be present somewhere in the final result.
    assert.deepEqual(result.map((m) => m.mes).filter((mes) => mes.startsWith('m')).sort(), ['m0', 'm1', 'm2', 'm3']);
});
