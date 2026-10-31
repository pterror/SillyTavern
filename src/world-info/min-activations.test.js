import assert from 'node:assert/strict';
import { activateWorldInfoEntries } from './activation.js';

const countTokens = async (text) => Math.ceil(text.length / 4);

{
    const entries = [{ uid: '1', world: 'w', key: ['gold'], content: 'Gold coin.' }];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['no match here', 'a gold coin glints'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, minActivations: 1,
    });
    assert.equal(activatedEntries.length, 1, 'depth advances until the minimum is satisfied');
}

{
    const entries = [{ uid: '1', world: 'w', key: ['gold'], content: 'Gold coin.' }];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['no match here', 'a gold coin glints'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens,
    });
    assert.equal(activatedEntries.length, 0, 'control: no minActivations means no depth-advancing, so the entry is never found');
}

{
    const entries = [{ uid: '1', world: 'w', key: ['gold'], content: 'Gold coin.' }];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['no match here', 'a gold coin glints'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, minActivations: 1, recursive: false,
    });
    assert.equal(activatedEntries.length, 1, 'min-activations depth-advancing still works with recursive:false');
}

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

{
    let calls = 0;
    const countingCountTokens = async (text) => { calls++; return Math.ceil(text.length / 4); };
    const entries = [{ uid: '1', world: 'w', key: ['nonexistent-keyword'], content: 'Never matches.' }];
    const chat = ['msg1', 'msg2', 'msg3'];
    const { activatedEntries } = await activateWorldInfoEntries(entries, chat, {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens: countingCountTokens, minActivations: 5,
    });
    assert.equal(activatedEntries.length, 0);
    assert.equal(calls, 4, `expected exactly 4 countTokens calls (one per pass at depth 1-4), got ${calls} - a higher count suggests the depth-exceeds-chat-length check isn't stopping the scan correctly`);
}

{
    const entries = [{ uid: '1', world: 'w', key: ['treasure'], content: 'Treasure lore.' }];
    const chat = ['m0', 'm1', 'm2', 'm3', 'treasure chest here', 'm5', 'm6', 'm7', 'm8', 'm9'];
    const { activatedEntries } = await activateWorldInfoEntries(entries, chat, {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, minActivations: 1, minActivationsDepthMax: 2,
    });
    assert.equal(activatedEntries.length, 0, 'depth is capped at 2 by minActivationsDepthMax, well short of the match at index 4');
}

{
    const entries = [{ uid: '1', world: 'w', key: ['treasure'], content: 'Treasure lore.' }];
    const chat = ['m0', 'm1', 'm2', 'm3', 'treasure chest here', 'm5', 'm6', 'm7', 'm8', 'm9'];
    const { activatedEntries } = await activateWorldInfoEntries(entries, chat, {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, minActivations: 1,
    });
    assert.equal(activatedEntries.length, 1, 'without a depth cap, depth eventually advances far enough to find the match');
}

console.log('min-activations.test.js: all assertions passed');
