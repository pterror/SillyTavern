import assert from 'node:assert/strict';
import {
    TokenHandler,
    Message,
    MessageCollection,
    ChatCompletion,
    IdentifierNotFoundError,
    TokenBudgetExceededError,
} from './chat-completion-budget.js';

/** Deterministic fake tokenizer: token count = JSON length of the input. */
const fakeCountTokens = async (messages) => JSON.stringify(messages).length;

// --- TokenHandler ------------------------------------------------------------

{
    const th = new TokenHandler(fakeCountTokens);
    assert.deepEqual(th.getCounts(), {
        start_chat: 0, prompt: 0, bias: 0, nudge: 0, jailbreak: 0, impersonate: 0, examples: 0, conversation: 0,
    });

    const n = await th.countAsync({ role: 'system', content: 'hello' }, false, 'prompt');
    assert.equal(n, JSON.stringify({ role: 'system', content: 'hello' }).length);
    assert.equal(th.getCounts().prompt, n);
    assert.equal(th.getTokensForIdentifier('prompt'), n);
    assert.equal(th.getTokensForIdentifier('nonexistent'), 0);

    await th.countAsync({ role: 'user', content: 'x' }, false, 'conversation');
    const total = th.getTotal();
    assert.equal(total, th.getCounts().prompt + th.getCounts().conversation);

    th.uncount(5, 'prompt');
    assert.equal(th.getCounts().prompt, n - 5);

    th.resetCounts();
    assert.equal(th.getTotal(), 0);
    assert.ok(Object.values(th.getCounts()).every((v) => v === 0));

    th.setCounts({ prompt: 42 });
    assert.deepEqual(th.getCounts(), { prompt: 42 });

    // getTotal treats NaN as 0
    th.setCounts({ prompt: 10, bogus: NaN });
    assert.equal(th.getTotal(), 10);
}

// --- Message.createAsync ------------------------------------------------------

{
    const th = new TokenHandler(fakeCountTokens);
    const msg = await Message.createAsync('system', 'hello world', 'id1', th);
    assert.equal(msg.role, 'system');
    assert.equal(msg.content, 'hello world');
    assert.equal(msg.identifier, 'id1');
    const expected = JSON.stringify({ role: 'system', content: 'hello world' }).length;
    assert.equal(msg.tokens, expected);
    assert.equal(msg.getTokens(), expected);
    // countAsync with no "type" arg does `counts[undefined] += n`, i.e. undefined += n = NaN,
    // which getTotal() treats as 0 - so the running per-type totals are unaffected by Message
    // token counting (which never passes a "type").
    assert.ok(Number.isNaN(th.getCounts().undefined));
    assert.equal(th.getTotal(), 0);
}

{
    // Empty content = 0 tokens, tokenizer genuinely NOT called.
    let called = false;
    const th = new TokenHandler(async (messages, full) => {
        called = true;
        return fakeCountTokens(messages, full);
    });
    const msg = await Message.createAsync('system', '', 'id2', th);
    assert.equal(msg.tokens, 0);
    assert.equal(called, false, 'tokenizer must not be invoked for empty string content');

    const msg2 = await Message.createAsync('user', undefined, 'id3', th);
    assert.equal(msg2.tokens, 0);
    assert.equal(called, false, 'tokenizer must not be invoked for undefined content');
}

{
    // Falsy role defaults to 'system'.
    const th = new TokenHandler(fakeCountTokens);
    const msg = await Message.createAsync('', 'content', 'id4', th);
    assert.equal(msg.role, 'system');
}

// --- Message.setName / setToolCalls re-counting -------------------------------

{
    const th = new TokenHandler(fakeCountTokens);
    const msg = await Message.createAsync('system', 'hi', 'idN', th);
    const before = msg.tokens;
    await msg.setName('Bob', th);
    assert.equal(msg.name, 'Bob');
    const expected = JSON.stringify({ role: 'system', content: 'hi', name: 'Bob' }).length;
    assert.equal(msg.tokens, expected);
    assert.notEqual(msg.tokens, before);
}

{
    const th = new TokenHandler(fakeCountTokens);
    const msg = await Message.createAsync('assistant', '', 'idT', th);
    const invocations = [
        { id: 'call_1', name: 'search', parameters: { q: 'x' }, signature: 'sig1', reasoning: '' },
        { id: 'call_2', name: 'lookup', parameters: { y: 1 }, reasoning: 'thinking about it' },
    ];
    await msg.setToolCalls(invocations, true, true, th);
    assert.equal(msg.tool_calls.length, 2);
    assert.deepEqual(msg.tool_calls[0], {
        id: 'call_1', type: 'function', function: { arguments: { q: 'x' }, name: 'search' }, signature: 'sig1',
    });
    assert.deepEqual(msg.tool_calls[1], {
        id: 'call_2', type: 'function', function: { arguments: { y: 1 }, name: 'lookup' },
    });
    assert.equal(msg.reasoning, 'thinking about it', 'first invocation with non-empty reasoning wins as fallback');
    const expectedPayload = {
        role: 'assistant',
        tool_calls: JSON.stringify(msg.tool_calls),
        reasoning: 'thinking about it',
    };
    assert.equal(msg.tokens, JSON.stringify(expectedPayload).length);

    // includeSignature = false strips signatures; includeReasoning = false clears reasoning.
    const msg2 = await Message.createAsync('assistant', '', 'idT2', th);
    await msg2.setToolCalls(invocations, false, false, th);
    assert.equal(msg2.tool_calls[0].signature, undefined);
    assert.equal(msg2.reasoning, null);
}

// --- Message.ensureContentIsArray ---------------------------------------------

{
    const th = new TokenHandler(fakeCountTokens);
    const msg = await Message.createAsync('user', 'plain text', 'idA', th);
    const arr = msg.ensureContentIsArray();
    assert.deepEqual(arr, [{ type: 'text', text: 'plain text' }]);
    assert.strictEqual(msg.content, arr);

    // Already-array content is left untouched (a fresh array is only built from non-array content).
    const msg2 = new Message('user', [{ type: 'text', text: 'x' }], 'idB');
    const before = msg2.content;
    const arr2 = msg2.ensureContentIsArray();
    assert.strictEqual(arr2, before);
}

// --- MessageCollection.getChat -------------------------------------------------

{
    const th = new TokenHandler(fakeCountTokens);
    const m1 = await Message.createAsync('system', 'sys text', 'sys1', th);
    const m2 = await Message.createAsync('user', 'user text', 'user1', th);
    await m2.setName('Alice', th);
    const mToolResult = new Message('tool', 'tool result text', 'call_abc');
    mToolResult.tokens = 1;
    const mEmpty = new Message('assistant', '', 'empty1'); // no content, no tool_calls -> skipped
    const mWithToolCalls = new Message('assistant', '', 'asst1');
    await mWithToolCalls.setToolCalls([{ id: 'c1', name: 'f', parameters: {} }], false, false, th);

    const coll = new MessageCollection('root', m1, m2, mToolResult, mEmpty, mWithToolCalls);
    const chat = coll.getChat();

    assert.equal(chat.length, 4, 'the no-content/no-tool_calls message is skipped');
    assert.deepEqual(chat[0], { role: 'system', content: 'sys text' });
    assert.deepEqual(chat[1], { role: 'user', content: 'user text', name: 'Alice' });
    assert.deepEqual(chat[2], { role: 'tool', content: 'tool result text', tool_call_id: 'call_abc' });
    assert.equal(chat[3].role, 'assistant');
    assert.ok(Array.isArray(chat[3].tool_calls));
    assert.equal(chat[3].content, '');

    assert.equal(coll.getCollection().length, 5);
    assert.equal(coll.getItemByIdentifier('user1'), m2);
    assert.equal(coll.getItemByIdentifier('missing'), undefined);
    assert.equal(coll.hasItemWithIdentifier('sys1'), true);
    assert.equal(coll.hasItemWithIdentifier('missing'), false);

    const expectedTokens = [m1, m2, mToolResult, mEmpty, mWithToolCalls].reduce((a, m) => a + m.getTokens(), 0);
    assert.equal(coll.getTokens(), expectedTokens);
}

// --- MessageCollection.flatten (nested) ---------------------------------------

{
    const th = new TokenHandler(fakeCountTokens);
    const a = await Message.createAsync('system', 'a', 'a', th);
    const b = await Message.createAsync('system', 'b', 'b', th);
    const c = await Message.createAsync('system', 'c', 'c', th);
    const inner = new MessageCollection('inner', b, c);
    const outer = new MessageCollection('outer', a, inner);

    const flat = outer.flatten();
    assert.deepEqual(flat, [a, b, c]);
    assert.equal(outer.getTokens(), a.getTokens() + inner.getTokens());
    assert.equal(inner.getTokens(), b.getTokens() + c.getTokens());
}

{
    // Constructor validation: only Message/MessageCollection instances allowed.
    assert.throws(() => new MessageCollection('bad', { role: 'user', content: 'x' }));
}

// --- ChatCompletion.add: budget check success/failure --------------------------

{
    const th = new TokenHandler(fakeCountTokens);
    const cc = new ChatCompletion(th);
    const msg = await Message.createAsync('system', 'short', 'sys', th);
    cc.setTokenBudget(1000, 0);
    const coll = new MessageCollection('block1', msg);

    cc.add(coll);
    assert.equal(cc.has('block1'), true);
    assert.equal(cc.tokenBudget, 1000 - coll.getTokens());
}

{
    const th = new TokenHandler(fakeCountTokens);
    const cc = new ChatCompletion(th);
    const msg = await Message.createAsync('system', 'x'.repeat(100), 'sys', th);
    cc.setTokenBudget(5, 0); // budget too small
    const coll = new MessageCollection('block1', msg);

    assert.throws(() => cc.add(coll), TokenBudgetExceededError);
    assert.equal(cc.has('block1'), false, 'failed add must not have inserted anything');
}

{
    // add() with non-MessageCollection throws a plain Error (not a custom class).
    const th = new TokenHandler(fakeCountTokens);
    const cc = new ChatCompletion(th);
    cc.setTokenBudget(1000, 0);
    assert.throws(() => cc.add({ identifier: 'x', getTokens: () => 0 }), (err) => {
        return err instanceof Error && !(err instanceof TokenBudgetExceededError) && !(err instanceof IdentifierNotFoundError);
    });
}

// --- ChatCompletion.insert / insertAtStart / insertAtEnd ------------------------

{
    const th = new TokenHandler(fakeCountTokens);
    const cc = new ChatCompletion(th);
    cc.setTokenBudget(1000, 0);
    cc.add(new MessageCollection('convo'));

    const m1 = await Message.createAsync('user', 'first', 'u1', th);
    const m2 = await Message.createAsync('user', 'second', 'u2', th);
    cc.insertAtEnd(m1, 'convo');
    cc.insertAtStart(m2, 'convo');

    const convoColl = cc.messages.getItemByIdentifier('convo');
    assert.deepEqual(convoColl.getCollection(), [m2, m1]);

    const budgetAfterInserts = 1000 - m1.getTokens() - m2.getTokens();
    assert.equal(cc.tokenBudget, budgetAfterInserts);

    // IdentifierNotFoundError when the target collection doesn't exist.
    const m3 = await Message.createAsync('user', 'third', 'u3', th);
    assert.throws(() => cc.insert(m3, 'nonexistent-block'), IdentifierNotFoundError);

    // Message with no content and no tool_calls is skipped entirely - no throw, no budget change.
    const budgetBefore = cc.tokenBudget;
    const emptyMsg = new Message('user', '', 'u4');
    cc.insert(emptyMsg, 'convo');
    assert.equal(cc.tokenBudget, budgetBefore, 'budget unchanged for skipped empty-content insert');
    assert.equal(convoColl.getCollection().length, 2, 'empty message was not actually inserted');
}

// --- canAfford / canAffordAll --------------------------------------------------

{
    const th = new TokenHandler(fakeCountTokens);
    const cc = new ChatCompletion(th);
    cc.setTokenBudget(35, 0);
    const small = await Message.createAsync('user', 'hi', 'a', th); // 30 tokens
    const big = await Message.createAsync('user', 'x'.repeat(50), 'b', th); // 78 tokens

    assert.equal(small.getTokens(), 30);
    assert.equal(big.getTokens(), 78);
    assert.equal(cc.canAfford(small), true, '35 - 30 >= 0');
    assert.equal(cc.canAfford(big), false, '35 - 78 < 0');
    assert.equal(cc.canAffordAll([small, small]), false, '35 - 60 < 0');
    assert.equal(cc.canAffordAll([small, big]), false);
}

// --- ChatCompletion.getChat full flattening ------------------------------------

{
    const th = new TokenHandler(fakeCountTokens);
    const cc = new ChatCompletion(th);
    cc.setTokenBudget(10000, 0);

    const sys = await Message.createAsync('system', 'system prompt', 'sysPrompt', th);
    cc.add(new MessageCollection('systemBlock', sys));

    const u1 = await Message.createAsync('user', 'hello', 'msg1', th);
    const a1 = await Message.createAsync('assistant', 'hi there', 'msg2', th);
    const convo = new MessageCollection('conversation', u1, a1);
    cc.add(convo);

    // A collection nested INSIDE another MessageCollection is NOT recursed into by
    // MessageCollection.getChat() (it only checks `message.content || message.tool_calls` on each
    // direct member, and a MessageCollection has neither) - only ChatCompletion.getChat()'s own
    // top-level loop recurses one level via `instanceof MessageCollection`. This matches the
    // client's real (non-recursive, non-shared) implementations exactly; verified here by nesting
    // a tool-result collection inside `convo` and confirming it is silently skipped.
    const nestedTool = new Message('tool', 'tool output', 'toolcall1');
    nestedTool.tokens = 3;
    convo.add(new MessageCollection('toolResults', nestedTool));

    // A second TOP-LEVEL collection, by contrast, IS picked up by ChatCompletion.getChat().
    const toolBlock = new Message('tool', 'top-level tool output', 'toolcall2');
    toolBlock.tokens = 3;
    cc.add(new MessageCollection('toolBlock', toolBlock));

    const chat = cc.getChat();
    assert.deepEqual(chat, [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
        { role: 'tool', content: 'top-level tool output', tool_call_id: 'toolcall2' },
    ]);
}

// --- squashSystemMessages -------------------------------------------------------

{
    // Consecutive squashable system messages get merged.
    const th = new TokenHandler(fakeCountTokens);
    const cc = new ChatCompletion(th);
    cc.setTokenBudget(100000, 0);
    const s1 = await Message.createAsync('system', 'part one', 'sysA', th);
    const s2 = await Message.createAsync('system', 'part two', 'sysB', th);
    const u1 = await Message.createAsync('user', 'hi', 'userMsg', th);
    cc.messages.add(s1);
    cc.messages.add(s2);
    cc.messages.add(u1);

    await cc.squashSystemMessages();
    const result = cc.messages.getCollection();
    assert.equal(result.length, 2);
    assert.equal(result[0].content, 'part one\npart two');
    assert.equal(result[0].tokens, JSON.stringify({ role: 'system', content: 'part one\npart two' }).length);
    assert.equal(result[1], u1);
}

{
    // excludeList identifiers are never squashed together with neighbors.
    const th = new TokenHandler(fakeCountTokens);
    const cc = new ChatCompletion(th);
    const s1 = await Message.createAsync('system', 'alpha', 'newMainChat', th);
    const s2 = await Message.createAsync('system', 'beta', 'newChat', th);
    const s3 = await Message.createAsync('system', 'gamma', 'groupNudge', th);
    cc.messages.add(s1);
    cc.messages.add(s2);
    cc.messages.add(s3);

    await cc.squashSystemMessages();
    const result = cc.messages.getCollection();
    assert.equal(result.length, 3, 'excludeList identifiers stay separate');
    assert.deepEqual(result.map((m) => m.content), ['alpha', 'beta', 'gamma']);
}

{
    // Named system messages are never squashed (with each other or with unnamed neighbors).
    const th = new TokenHandler(fakeCountTokens);
    const cc = new ChatCompletion(th);
    const s1 = await Message.createAsync('system', 'unnamed one', 'sysX', th);
    const s2 = await Message.createAsync('system', 'named', 'sysY', th);
    await s2.setName('Narrator', th);
    const s3 = await Message.createAsync('system', 'unnamed two', 'sysZ', th);
    cc.messages.add(s1);
    cc.messages.add(s2);
    cc.messages.add(s3);

    await cc.squashSystemMessages();
    const result = cc.messages.getCollection();
    // s1 alone, s2 (named) alone, s3 alone - none squash across the named message.
    assert.equal(result.length, 3);
    assert.deepEqual(result.map((m) => m.content), ['unnamed one', 'named', 'unnamed two']);
}

{
    // Empty-content system messages are dropped entirely.
    const th = new TokenHandler(fakeCountTokens);
    const cc = new ChatCompletion(th);
    const s1 = await Message.createAsync('system', 'kept before', 'sysK1', th);
    const empty = new Message('system', '', 'sysEmpty');
    const s2 = await Message.createAsync('system', 'kept after', 'sysK2', th);
    cc.messages.add(s1);
    cc.messages.add(empty);
    cc.messages.add(s2);

    await cc.squashSystemMessages();
    const result = cc.messages.getCollection();
    // empty message dropped; the two real ones squash together since it's never seen as "lastMessage"
    assert.equal(result.length, 1);
    assert.equal(result[0].content, 'kept before\nkept after');
}

// --- reserveBudget / freeBudget / removeLastFrom round-trip ---------------------

{
    const th = new TokenHandler(fakeCountTokens);
    const cc = new ChatCompletion(th);
    cc.setTokenBudget(1000, 0);
    const initialBudget = cc.tokenBudget;

    const msg = await Message.createAsync('user', 'reserve me', 'r1', th);
    cc.reserveBudget(msg);
    assert.equal(cc.tokenBudget, initialBudget - msg.getTokens());
    cc.freeBudget(msg);
    assert.equal(cc.tokenBudget, initialBudget);

    // reserveBudget also accepts a raw number.
    cc.reserveBudget(50);
    assert.equal(cc.tokenBudget, initialBudget - 50);
    cc.increaseTokenBudgetBy(50);
    assert.equal(cc.tokenBudget, initialBudget);

    // removeLastFrom round-trips the budget for insert/remove.
    cc.add(new MessageCollection('block'));
    const before = cc.tokenBudget;
    const inserted = await Message.createAsync('user', 'to be removed', 'ins1', th);
    cc.insertAtEnd(inserted, 'block');
    assert.equal(cc.tokenBudget, before - inserted.getTokens());
    cc.removeLastFrom('block');
    assert.equal(cc.tokenBudget, before, 'budget restored after removing the message that was inserted');

    // removeLastFrom on an already-empty collection: no-op, no throw.
    cc.removeLastFrom('block');
    assert.equal(cc.tokenBudget, before);
}

console.log('All chat-completion-budget.test.js assertions passed.');
