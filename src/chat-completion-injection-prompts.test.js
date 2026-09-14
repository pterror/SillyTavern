import assert from 'node:assert/strict';
import { populateInjectionPrompts } from './chat-completion-injection-prompts.js';
import { createExtensionPromptTable, setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from './extension-prompt-table.js';

// --- single prompt at one depth/role, hand-traced position -----------------
//
// messages (newest-first, as required by this function's I/O convention) = [orig0, orig1], where
// orig0 is the NEWEST original message and orig1 is the OLDEST.
//
// A single prompt at injection_depth 0, role 'user', content 'Hi' produces one roleMessage. It is
// spliced into the (still newest-first) working array at index `0 + 0 = 0`:
//   [ {role:'user',content:'Hi',injected:true}, orig0, orig1 ]
// Reversing this to chronological order gives:
//   [ orig1, orig0, {role:'user',content:'Hi',injected:true} ]
// i.e. the injected depth-0 message ends up LAST (newest) - orig1 (oldest) first, then orig0, then
// the injection.
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
    // Input array must not be mutated.
    assert.deepEqual(messages, [orig0, orig1]);
    assert.notEqual(result, messages);
}

// --- multiple prompts at the same depth+role are joined with '\n' ----------
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

// --- multiple occupied depths, each producing its own injection, with -----
// --- totalInsertedMessages correctly offsetting subsequent insertions -----
//
// Hand trace (newest-first input [orig0, orig1], orig0 newest / orig1 oldest):
//  i=0: depthPrompts -> one roleMessage 'D0'. injectIdx = 0 + 0 = 0.
//       working = [D0, orig0, orig1]; totalInserted = 1.
//  i=1: depthPrompts -> one roleMessage 'D1'. injectIdx = 1 + 1 = 2.
//       working = [D0, orig0, D1, orig1]; totalInserted = 2.
//  reverse -> [orig1, D1, orig0, D0]
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

// --- injection_order grouping, processed in DESCENDING numeric order ------
//
// Two prompts at the same depth/role but different injection_order: order 200 ('A') and order 100
// ('B'). Orders are visited highest-first (see module doc comment's sort-direction verification), so
// `roleMessages` is built as [{content:'A'}, {content:'B'}] (order 200 processed before order 100).
// That array is spliced, AS A BLOCK, into the still-newest-first working array at index 0:
//   [ {content:'A'}, {content:'B'}, orig ]
// The whole thing is then reversed exactly once at the very end (this function's ordering convention -
// see the single-prompt test above), which ALSO flips the internal relative order of the two injected
// messages along with everything else:
//   [ orig, {content:'B'}, {content:'A'} ]
// So the correct (descending-sort) final chronological order has 'B' BEFORE 'A'. If the sort direction
// were (wrongly) ascending instead, `roleMessages` would be built as [B, A], and after the same splice
// + single final reversal the result would come out as [orig, A, B] - the opposite, and detectably
// different, order. This test pins the correct (descending) result: [orig, B, A].
{
    const messages = [{ role: 'assistant', content: 'orig' }];
    const prompts = [
        { injection_depth: 0, injection_order: 200, role: 'user', content: 'A' },
        { injection_depth: 0, injection_order: 100, role: 'user', content: 'B' },
    ];

    const result = populateInjectionPrompts(prompts, messages);

    // Both order-groups produce separate messages (never merged with each other - different orders).
    assert.deepEqual(result, [
        { role: 'assistant', content: 'orig' },
        { role: 'user', content: 'B', injected: true },
        { role: 'user', content: 'A', injected: true },
    ]);
}

// --- '100'-order-bucket-only table-merge behavior --------------------------
{
    const table = createExtensionPromptTable();
    setExtensionPrompt(table, 'test-module', 'TableContent', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);

    // A prompt at the default/explicit order 100 DOES get merged with the table content.
    {
        const messages = [{ role: 'assistant', content: 'orig' }];
        const prompts = [{ injection_depth: 0, injection_order: 100, role: 'system', content: 'Explicit100' }];
        const result = populateInjectionPrompts(prompts, messages, { table });
        assert.deepEqual(result, [
            { role: 'assistant', content: 'orig' },
            { role: 'system', content: 'Explicit100\nTableContent', injected: true },
        ]);
    }

    // Same, but relying on the injection_order default (no explicit `injection_order` field) - also
    // merges, since the default is exactly 100.
    {
        const messages = [{ role: 'assistant', content: 'orig' }];
        const prompts = [{ injection_depth: 0, role: 'system', content: 'DefaultOrder' }];
        const result = populateInjectionPrompts(prompts, messages, { table });
        assert.deepEqual(result, [
            { role: 'assistant', content: 'orig' },
            { role: 'system', content: 'DefaultOrder\nTableContent', injected: true },
        ]);
    }

    // A prompt at a different explicit order does NOT get merged with the table - only its own content
    // is used for that order's message. NOTE: the client always initializes an (order 100) bucket
    // (`orderGroups = { [extensionPromptsOrder]: [] }`) up front, regardless of whether any actual
    // `prompts` entry uses order 100 - so that bucket is still processed and still pulls in the table
    // content as ITS OWN (empty-`rolePrompts`) message, entirely separate from the order-50 message.
    // Since order 100 > order 50, the (empty-prompts) order-100/table message is processed FIRST
    // (descending order), then order-50 second - so roleMessages = [TableContent, Order50] before the
    // single final reversal flips that to [Order50, TableContent] in the chronological result.
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

    // The table can produce a message on its own even with no `prompts` entry at all at that depth,
    // since a table-occupied depth is part of the occupied-depths union.
    {
        const messages = [{ role: 'assistant', content: 'orig' }];
        const result = populateInjectionPrompts([], messages, { table });
        assert.deepEqual(result, [
            { role: 'assistant', content: 'orig' },
            { role: 'system', content: 'TableContent', injected: true },
        ]);
    }
}

// --- three-role separation: system/user/assistant at the same depth stay ---
// --- as separate messages, never merged with each other --------------------
//
// All three land in the same (order 100) bucket and are processed in role order
// [system, user, assistant], giving roleMessages = [Sys, Usr, Asst]; the single final reversal (see
// this function's ordering convention) flips that to [Asst, Usr, Sys] in the chronological result.
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
    // The three roles remain three separate messages - none of them merged content across roles.
    const injectedContents = result.filter((m) => m.injected).map((m) => m.content);
    assert.deepEqual(new Set(injectedContents), new Set(['Sys', 'Usr', 'Asst']));
}

// --- input `messages` array is never mutated --------------------------------
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

// --- no occupied depths at all -> messages simply reversed, no injections --
{
    const messages = [{ role: 'assistant', content: 'orig0' }, { role: 'assistant', content: 'orig1' }];
    const result = populateInjectionPrompts([], messages);
    assert.deepEqual(result, [{ role: 'assistant', content: 'orig1' }, { role: 'assistant', content: 'orig0' }]);
}

console.log('All chat-completion-injection-prompts tests passed.');
