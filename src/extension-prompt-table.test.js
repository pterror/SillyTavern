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

    assert.equal(getExtensionPrompt(table, { position: extension_prompt_types.IN_CHAT, depth: 3, wrap: false }), 'depth-3-value');
    assert.equal(getExtensionPrompt(table, { position: extension_prompt_types.IN_CHAT, depth: 5, wrap: false }), 'depth-5-value');
    assert.equal(getExtensionPrompt(table, { position: extension_prompt_types.IN_CHAT, depth: 4, wrap: false }), '');

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
    assert.equal(getExtensionPrompt(emptyTable, { position: extension_prompt_types.IN_PROMPT, wrap: true }), '');

    const table = createExtensionPromptTable();
    setExtensionPrompt(table, 'a', 'value-without-separators', extension_prompt_types.IN_PROMPT, 0);
    const wrapped = getExtensionPrompt(table, { position: extension_prompt_types.IN_PROMPT, wrap: true, separator: '\n' });
    assert.equal(wrapped, '\nvalue-without-separators\n');

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
    setExtensionPrompt(table, 'c', '', extension_prompt_types.IN_CHAT, 2);
    setExtensionPrompt(table, 'd', 'value', extension_prompt_types.IN_PROMPT, 3);
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

    assert.equal(result.length, 5);
    assert.deepEqual(result.map((m) => m.mes), ['oldest', 'newest', 'assistant-text', 'user-text', 'system-text']);

    const reversed = [...result].reverse();
    assert.deepEqual(injectedIndices, [0, 1, 2]);
    assert.deepEqual(injectedIndices.map((i) => reversed[i].mes), ['system-text', 'user-text', 'assistant-text']);
    assert.equal(reversed[0].extra.type, 'narrator');
    assert.equal(reversed[1].name, 'User');
    assert.equal(reversed[1].is_user, true);
    assert.equal(reversed[2].name, 'Aria');
    assert.equal(reversed[2].is_user, false);

    assert.equal(coreChat.length, 2);
});

test('doChatInject: totalInsertedMessages correctly offsets later depths\' injection index', () => {
    const table = createExtensionPromptTable();
    setExtensionPrompt(table, 'd0', 'depth-0-text', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
    setExtensionPrompt(table, 'd1', 'depth-1-text', extension_prompt_types.IN_CHAT, 1, false, extension_prompt_roles.SYSTEM);

    const coreChat = [
        { name: 'User', mes: 'first', is_user: true },
        { name: 'Aria', mes: 'second', is_user: false },
        { name: 'User', mes: 'third', is_user: true },
    ];

    const { coreChat: result, injectedIndices } = doChatInject(coreChat, false, { name1: 'User', name2: 'Aria', table });

    assert.deepEqual(result.map((m) => m.mes), ['first', 'second', 'depth-1-text', 'third', 'depth-0-text']);

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
    assert.deepEqual(notContinue.coreChat.map((m) => m.mes), ['first', 'second', 'depth-0-text']);

    const continued = doChatInject(coreChat, true, { name1: 'User', name2: 'Aria', table });
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

    const reversed = [...result].reverse();
    for (const idx of injectedIndices) {
        assert.ok(idx >= 0 && idx < reversed.length, `index ${idx} should be a valid position in the reversed array`);
    }
    assert.deepEqual(injectedIndices.map((i) => reversed[i].mes), ['d0-sys', 'd0-usr', 'd2-sys']);
    assert.deepEqual(result.map((m) => m.mes).filter((mes) => mes.startsWith('m')).sort(), ['m0', 'm1', 'm2', 'm3']);
});
