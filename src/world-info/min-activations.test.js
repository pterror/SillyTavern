import assert from 'node:assert/strict';
import { activateWorldInfoEntries } from './activation.js';

const countTokens = async (text) => Math.ceil(text.length / 4); // cheap deterministic stand-in

// minActivations advances scan depth until the minimum is met, finding a key only present further
// back in chat history than the initial depth would reach.
{
    const entries = [{ uid: '1', world: 'w', key: ['gold'], content: 'Gold coin.' }];
    // messages are most-recent-first; depth:1 only sees 'no match here' initially.
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['no match here', 'a gold coin glints'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, minActivations: 1,
    });
    assert.equal(activatedEntries.length, 1, 'depth advances until the minimum is satisfied');
}

// Without minActivations set, the same scenario finds nothing (depth never advances past the initial 1).
{
    const entries = [{ uid: '1', world: 'w', key: ['gold'], content: 'Gold coin.' }];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['no match here', 'a gold coin glints'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens,
    });
    assert.equal(activatedEntries.length, 0, 'control: no minActivations means no depth-advancing, so the entry is never found');
}

// minActivations advancing depth is independent of the `recursive` setting entirely.
{
    const entries = [{ uid: '1', world: 'w', key: ['gold'], content: 'Gold coin.' }];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['no match here', 'a gold coin glints'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, minActivations: 1, recursive: false,
    });
    assert.equal(activatedEntries.length, 1, 'min-activations depth-advancing still works with recursive:false');
}

// MIN_ACTIVATIONS -> RECURSION handoff: entry 1 is only found once depth advances; entry 2 is only
// reachable by recursing through entry 1's own content (which contains entry 2's key).
{
    const entries = [
        { uid: '1', world: 'w', key: ['gold'], content: 'The gold is guarded by a dragon.' },
        { uid: '2', world: 'w', key: ['dragon'], content: 'Dragons are fierce.' },
    ];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['no match here', 'a gold coin glints'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, minActivations: 2, recursive: true,
    });
    assert.equal(activatedEntries.length, 2, 'entry 1 found via depth-advance, entry 2 found via the recursion pass that follows it');
    assert.ok(activatedEntries.some(e => e.uid === '1'));
    assert.ok(activatedEntries.some(e => e.uid === '2'));
}

// Same MIN_ACTIVATIONS -> RECURSION handoff, but with recursive:false. The RECURSION pass that
// finds entry 2 is itself gated on `recursive` (both the "normal recursion" and the
// "MIN_ACTIVATIONS+hasRecurse" checks in activateWorldInfoEntries require `recursive`), so entry 2
// should NOT activate even though entry 1 still does via pure depth-advancing.
{
    const entries = [
        { uid: '1', world: 'w', key: ['gold'], content: 'The gold is guarded by a dragon.' },
        { uid: '2', world: 'w', key: ['dragon'], content: 'Dragons are fierce.' },
    ];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['no match here', 'a gold coin glints'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, minActivations: 2, recursive: false,
    });
    assert.ok(activatedEntries.some(e => e.uid === '1'), 'entry 1 still found via depth-advancing alone');
    assert.equal(activatedEntries.some(e => e.uid === '2'), false, 'entry 2 never found - recursion into entry 1\'s content is gated on `recursive`');
}

// Termination: minActivations set higher than any entry could ever satisfy must stop once scan
// depth exceeds chat length, not loop until the internal maxRecursionSteps safety cap (25).
{
    let calls = 0;
    const countingCountTokens = async (text) => { calls++; return Math.ceil(text.length / 4); };
    const entries = [{ uid: '1', world: 'w', key: ['nonexistent-keyword'], content: 'Never matches.' }];
    const chat = ['msg1', 'msg2', 'msg3'];
    const { activatedEntries } = await activateWorldInfoEntries(entries, chat, {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens: countingCountTokens, minActivations: 5,
    });
    assert.equal(activatedEntries.length, 0);
    // Depth starts at 1 and advances by 1 each unsatisfied pass; stops once buffer.getDepth() > chat.length (3).
    // That's passes at depth 1,2,3,4 = 4 passes, each with 1 shared countTokens call = 4, well under
    // the 25-step safety cap - proves the depth check (not the safety cap) is what stopped the scan.
    assert.equal(calls, 4, `expected exactly 4 countTokens calls (one per pass at depth 1-4), got ${calls} - a higher count suggests the depth-exceeds-chat-length check isn't stopping the scan correctly`);
}

// minActivationsDepthMax caps depth-advancing even when chat is long enough that the plain
// chat-length check alone would have allowed continuing further.
{
    const entries = [{ uid: '1', world: 'w', key: ['treasure'], content: 'Treasure lore.' }];
    // 10 messages, most-recent-first; the matching one is 5 messages back (index 4).
    const chat = ['m0', 'm1', 'm2', 'm3', 'treasure chest here', 'm5', 'm6', 'm7', 'm8', 'm9'];
    const { activatedEntries } = await activateWorldInfoEntries(entries, chat, {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, minActivations: 1, minActivationsDepthMax: 2,
    });
    assert.equal(activatedEntries.length, 0, 'depth is capped at 2 by minActivationsDepthMax, well short of the match at index 4');
}

// Sanity: without the depth cap, the same scenario DOES find the entry (proving the cap above is
// actually what prevented it, not some other mistake).
{
    const entries = [{ uid: '1', world: 'w', key: ['treasure'], content: 'Treasure lore.' }];
    const chat = ['m0', 'm1', 'm2', 'm3', 'treasure chest here', 'm5', 'm6', 'm7', 'm8', 'm9'];
    const { activatedEntries } = await activateWorldInfoEntries(entries, chat, {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, minActivations: 1,
    });
    assert.equal(activatedEntries.length, 1, 'without a depth cap, depth eventually advances far enough to find the match');
}

console.log('min-activations.test.js: all assertions passed');
