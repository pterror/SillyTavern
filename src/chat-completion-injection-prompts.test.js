import assert from 'node:assert/strict';
import { populateInjectionPrompts } from './chat-completion-injection-prompts.js';
import { createExtensionPromptTable, setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from './extension-prompt-table.js';

{
    const orig0 = { role: 'assistant', content: 'orig0' };
    const orig1 = { role: 'assistant', content: 'orig1' };
    const messages = [orig0, orig1];
    const prompts = [{ injection_depth: 0, role: 'user', content: 'Hi' }];

    const result = populateInjectionPrompts(prompts, messages);

    assert.deepEqual(result, [
        orig1,
        orig0,
        { role: 'user', content: 'Hi', injected: true },
    ]);
    assert.deepEqual(messages, [orig0, orig1]);
    assert.notEqual(result, messages);
}

{
    const messages = [{ role: 'assistant', content: 'orig' }];
    const prompts = [
        { injection_depth: 0, role: 'system', content: 'first' },
        { injection_depth: 0, role: 'system', content: 'second' },
    ];

    const result = populateInjectionPrompts(prompts, messages);

    assert.deepEqual(result, [
        { role: 'assistant', content: 'orig' },
        { role: 'system', content: 'first\nsecond', injected: true },
    ]);
}

{
    const orig0 = { role: 'assistant', content: 'orig0' };
    const orig1 = { role: 'assistant', content: 'orig1' };
    const messages = [orig0, orig1];
    const prompts = [
        { injection_depth: 0, role: 'system', content: 'D0' },
        { injection_depth: 1, role: 'system', content: 'D1' },
    ];

    const result = populateInjectionPrompts(prompts, messages);

    assert.deepEqual(result, [
        orig1,
        { role: 'system', content: 'D1', injected: true },
        orig0,
        { role: 'system', content: 'D0', injected: true },
    ]);
}

{
    const messages = [{ role: 'assistant', content: 'orig' }];
    const prompts = [
        { injection_depth: 0, injection_order: 200, role: 'user', content: 'A' },
        { injection_depth: 0, injection_order: 100, role: 'user', content: 'B' },
    ];

    const result = populateInjectionPrompts(prompts, messages);

    assert.deepEqual(result, [
        { role: 'assistant', content: 'orig' },
        { role: 'user', content: 'B', injected: true },
        { role: 'user', content: 'A', injected: true },
    ]);
}

{
    const table = createExtensionPromptTable();
    setExtensionPrompt(table, 'test-module', 'TableContent', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);

    {
        const messages = [{ role: 'assistant', content: 'orig' }];
        const prompts = [{ injection_depth: 0, injection_order: 100, role: 'system', content: 'Explicit100' }];
        const result = populateInjectionPrompts(prompts, messages, { table });
        assert.deepEqual(result, [
            { role: 'assistant', content: 'orig' },
            { role: 'system', content: 'Explicit100\nTableContent', injected: true },
        ]);
    }

    {
        const messages = [{ role: 'assistant', content: 'orig' }];
        const prompts = [{ injection_depth: 0, role: 'system', content: 'DefaultOrder' }];
        const result = populateInjectionPrompts(prompts, messages, { table });
        assert.deepEqual(result, [
            { role: 'assistant', content: 'orig' },
            { role: 'system', content: 'DefaultOrder\nTableContent', injected: true },
        ]);
    }

    {
        const messages = [{ role: 'assistant', content: 'orig' }];
        const prompts = [{ injection_depth: 0, injection_order: 50, role: 'system', content: 'Order50' }];
        const result = populateInjectionPrompts(prompts, messages, { table });
        assert.deepEqual(result, [
            { role: 'assistant', content: 'orig' },
            { role: 'system', content: 'Order50', injected: true },
            { role: 'system', content: 'TableContent', injected: true },
        ]);
    }

    {
        const messages = [{ role: 'assistant', content: 'orig' }];
        const result = populateInjectionPrompts([], messages, { table });
        assert.deepEqual(result, [
            { role: 'assistant', content: 'orig' },
            { role: 'system', content: 'TableContent', injected: true },
        ]);
    }
}

{
    const messages = [{ role: 'assistant', content: 'orig' }];
    const prompts = [
        { injection_depth: 0, role: 'system', content: 'Sys' },
        { injection_depth: 0, role: 'user', content: 'Usr' },
        { injection_depth: 0, role: 'assistant', content: 'Asst' },
    ];

    const result = populateInjectionPrompts(prompts, messages);

    assert.deepEqual(result, [
        { role: 'assistant', content: 'orig' },
        { role: 'assistant', content: 'Asst', injected: true },
        { role: 'user', content: 'Usr', injected: true },
        { role: 'system', content: 'Sys', injected: true },
    ]);
    const injectedContents = result.filter((m) => m.injected).map((m) => m.content);
    assert.deepEqual(new Set(injectedContents), new Set(['Sys', 'Usr', 'Asst']));
}

{
    const messages = [{ role: 'assistant', content: 'orig0' }, { role: 'assistant', content: 'orig1' }];
    const messagesCopyForComparison = messages.map((m) => ({ ...m }));
    const prompts = [
        { injection_depth: 0, role: 'system', content: 'D0' },
        { injection_depth: 1, role: 'system', content: 'D1' },
    ];

    const result = populateInjectionPrompts(prompts, messages);

    assert.deepEqual(messages, messagesCopyForComparison, 'input messages array must be unchanged');
    assert.equal(messages.length, 2, 'input messages array length must be unchanged');
    assert.notEqual(result, messages, 'must return a new array, not the same reference');
}

{
    const messages = [{ role: 'assistant', content: 'orig0' }, { role: 'assistant', content: 'orig1' }];
    const result = populateInjectionPrompts([], messages);
    assert.deepEqual(result, [{ role: 'assistant', content: 'orig1' }, { role: 'assistant', content: 'orig0' }]);
}

console.log('All chat-completion-injection-prompts tests passed.');
