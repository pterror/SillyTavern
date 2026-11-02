import assert from 'node:assert/strict';
import { activate as activateWorldInfoEntries } from './test-globals.js';
import { parseDecorators } from './decorators.js';

const countTokens = async (text) => Math.ceil(text.length / 4);

{
    const entries = [{ uid: '1', world: 'w', key: ['dragon'], content: 'Dragons breathe fire.' }];
    const { activatedEntries, content } = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens,
    });
    assert.equal(activatedEntries.length, 1);
    assert.equal(content, 'Dragons breathe fire.');
}

{
    const entries = [{ uid: '1', world: 'w', key: ['griffin'], content: 'Griffins fly.' }];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens,
    });
    assert.equal(activatedEntries.length, 0);
}

{
    const entries = [{ uid: '1', world: 'w', key: [], constant: true, content: 'Always here.' }];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['nothing relevant'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens,
    });
    assert.equal(activatedEntries.length, 1);
}

{
    const entries = [
        { uid: '1', world: 'w', key: ['dragon'], content: 'The dragon guards a cave.' },
        { uid: '2', world: 'w', key: ['cave'], content: 'The cave is dark.' },
    ];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, recursive: true, countTokens,
    });
    assert.equal(activatedEntries.length, 2, 'both the directly-matched and recursively-matched entry activate');
    assert.ok(activatedEntries.some(e => e.uid === '2'));
}

{
    const entries = [
        { uid: '1', world: 'w', key: ['dragon'], content: 'The dragon guards a cave.' },
        { uid: '2', world: 'w', key: ['cave'], content: 'The cave is dark.' },
    ];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, recursive: false, countTokens,
    });
    assert.equal(activatedEntries.length, 1);
}

{
    const entries = [
        { uid: '1', world: 'w', key: ['dragon'], content: 'The dragon guards a cave.', preventRecursion: true },
        { uid: '2', world: 'w', key: ['cave'], content: 'The cave is dark.' },
    ];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, recursive: true, countTokens,
    });
    assert.equal(activatedEntries.length, 1, 'entry 2 never gets a chance to match since entry 1 is excluded from recursion feed');
}

{
    const entries = [
        { uid: '1', world: 'w', key: ['dragon'], content: 'x'.repeat(400) },
        { uid: '2', world: 'w', key: ['dragon'], content: 'y'.repeat(400) },
    ];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 1, countTokens, depth: 1,
    });
    assert.ok(activatedEntries.length < 2, 'budget should prevent both large entries from activating');
}

{
    const entries = [
        { uid: '1', world: 'w', key: ['dragon'], content: 'x'.repeat(4000) },
        { uid: '2', world: 'w', key: ['dragon'], content: 'important', ignoreBudget: true },
    ];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 1, countTokens, depth: 1,
    });
    assert.ok(activatedEntries.some(e => e.uid === '2'), 'ignoreBudget entry activates despite overflow');
}

{
    const entries = [{ uid: '1', world: 'w', key: ['dragon'], content: 'Maybe here.', useProbability: true, probability: 10 }];
    const failing = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, random: () => 0.9,
    });
    assert.equal(failing.activatedEntries.length, 0, '90 > 10% probability fails the roll');

    const passing = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, random: () => 0.05,
    });
    assert.equal(passing.activatedEntries.length, 1, '5 <= 10% probability passes the roll');
}

{
    const entries = [{ uid: '1', world: 'w', key: ['dragon'], content: 'hidden', disable: true }];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens,
    });
    assert.equal(activatedEntries.length, 0);
}

{
    const entries = [{ uid: '1', world: 'w', key: ['dragon'], content: 'x'.repeat(2000) }];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 100000, budgetPercent: 100, budgetCap: 10, countTokens, depth: 1,
    });
    assert.equal(activatedEntries.length, 0, 'a 10-token cap should reject a ~500-token entry');
}

{
    let calls = 0;
    const countingCountTokens = async (text) => { calls++; return Math.ceil(text.length / 4); };
    const entries = [
        { uid: '1', world: 'w', key: ['dragon'], content: 'one' },
        { uid: '2', world: 'w', key: ['dragon'], content: 'two' },
        { uid: '3', world: 'w', key: ['dragon'], content: 'three' },
    ];
    await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens: countingCountTokens,
    });
    assert.equal(calls, 5, `expected 5 countTokens calls (4 from pass 1 + 1 shared call in the empty follow-up pass), got ${calls}`);
}

{
    const entries = [{ uid: '1', world: 'w', key: ['dragon'], content: 'Dragon lore.', sticky: 3 }];
    const chatMetadata = {};

    const first = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, chatMetadata,
    });
    assert.equal(first.activatedEntries.length, 1);

    const second = await activateWorldInfoEntries(entries, ['something unrelated', 'a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, chatMetadata,
    });
    assert.equal(second.activatedEntries.length, 1, 'sticky keeps the entry active without a new key match');
}

{
    const entries = [{ uid: '1', world: 'w', key: ['dragon'], content: 'Dragon lore.', sticky: 1, cooldown: 5 }];
    const chatMetadata = {};

    await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, chatMetadata,
    });
    const afterSticky = await activateWorldInfoEntries(entries, ['dragon again', 'a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, chatMetadata,
    });
    assert.equal(afterSticky.activatedEntries.length, 0, 'entry is on cooldown, suppressed despite matching key');
    assert.ok(chatMetadata.timedWorldInfo.cooldown['w.1'], 'cooldown recorded on sticky expiry');
}

{
    const entries = [{ uid: '1', world: 'w', key: ['dragon'], content: 'Dragon lore.', delay: 10 }];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, chatMetadata: {},
    });
    assert.equal(activatedEntries.length, 0, 'suppressed by delay regardless of key match');
}

{
    const entries = [{ uid: '1', world: 'w', key: ['dragon'], content: 'Dragon lore.', sticky: 3 }];
    const chatMetadata = {};
    await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, chatMetadata, isDryRun: true,
    });
    const second = await activateWorldInfoEntries(entries, ['unrelated', 'a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, chatMetadata, isDryRun: true,
    });
    assert.equal(second.activatedEntries.length, 0, 'dry run never persists sticky, so no carryover (depth:1 only scans the most recent message, "unrelated")');
}

{
    const entries = [
        { uid: '1', world: 'w', key: ['dragon'], content: 'Version A.', group: 'lore', order: 1 },
        { uid: '2', world: 'w', key: ['dragon'], content: 'Version B.', group: 'lore', order: 5, groupOverride: true },
    ];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens,
    });
    assert.equal(activatedEntries.length, 1, 'only one entry from the group activates');
    assert.equal(activatedEntries[0].uid, '2', 'the groupOverride entry wins');
}

{
    const entries = [{ uid: '1', world: 'w', key: ['dragon'], content: 'Dragon lore.', characterFilter: { names: ['other.png'], isExclude: false } }];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens,
        entryFilterContext: { characterFilename: 'alice.png' },
    });
    assert.equal(activatedEntries.length, 0, 'entry restricted to a different character is filtered out');
}

{
    const entries = [{ uid: '1', world: 'w', key: ['dragon'], content: 'Dragon lore.', triggers: ['impersonate'] }];
    const suppressed = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, entryFilterContext: { trigger: 'normal' },
    });
    assert.equal(suppressed.activatedEntries.length, 0);

    const allowed = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, entryFilterContext: { trigger: 'impersonate' },
    });
    assert.equal(allowed.activatedEntries.length, 1);
}

{
    let calls = 0;
    const countingCountTokens = async (text) => { calls++; return Math.ceil(text.length / 4); };
    const entries = [
        { uid: '1', world: 'w', key: ['dragon'], content: 'x'.repeat(4000) + ' cave' },
        { uid: '2', world: 'w', key: ['cave'], content: 'Cave lore.' },
    ];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 1, countTokens: countingCountTokens, depth: 1, recursive: true,
    });
    assert.equal(activatedEntries.length, 0, 'entry 1 is cut by budget, and entry 2 never gets a recursion pass to be found in');
    assert.equal(calls, 2, 'exactly one pass ran (1 shared scanTokens call + 1 for entry 1'
        + '\'s own content) - no second pass was attempted after overflow');
}

{
    const original = { uid: '1', world: 'w', key: ['nonexistent-keyword'], content: 'original content' };
    const forced = { uid: '1', world: 'w', key: ['nonexistent-keyword'], content: 'forced content override' };
    const externalActivations = new Map([['w.1', forced]]);
    const { activatedEntries } = await activateWorldInfoEntries([original], ['nothing relevant'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, externalActivations,
    });
    assert.equal(activatedEntries.length, 1);
    assert.equal(activatedEntries[0].content, 'forced content override', 'the forced entry object is used, not the original candidate');
}

{
    const entries = [{ uid: '1', world: 'w', key: ['nonexistent-keyword'], content: 'never matches' }];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['nothing relevant'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens,
    });
    assert.equal(activatedEntries.length, 0);
}

{
    const [decorators, content] = parseDecorators('@@activate\nThis lore has no matching key.');
    const entries = [{ uid: '1', world: 'w', key: ['nonexistent-keyword'], content, decorators }];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['nothing relevant here'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens,
    });
    assert.equal(activatedEntries.length, 1, '@@activate forces activation despite no key match');
    assert.equal(activatedEntries[0].content, 'This lore has no matching key.', 'decorator header stripped from content before scanning');
}

{
    const [decorators, content] = parseDecorators('@@dont_activate\nDragon lore that would normally match.');
    const entries = [{ uid: '1', world: 'w', key: ['dragon'], content, decorators }];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens,
    });
    assert.equal(activatedEntries.length, 0, '@@dont_activate suppresses the entry even though its key matches the chat');
}

{
    const entries = [{ uid: '1', world: 'w', key: ['nonexistent-keyword'], content: 'No decorators here.' }];
    const noMatch = await activateWorldInfoEntries(entries, ['nothing relevant here'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens,
    });
    assert.equal(noMatch.activatedEntries.length, 0, 'without @@activate, a non-matching key does not activate');

    const matchingEntries = [{ uid: '1', world: 'w', key: ['dragon'], content: 'Dragon lore.' }];
    const withMatch = await activateWorldInfoEntries(matchingEntries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens,
    });
    assert.equal(withMatch.activatedEntries.length, 1, 'without @@dont_activate, a matching key does activate');
}

{
    const entries = [{ uid: '1', world: 'w', key: ['unicorn'], content: 'Unicorns are rare.' }];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['nothing relevant here'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens,
        additionalScanInjects: ['a unicorn was mentioned in the quiet prompt'],
    });
    assert.equal(activatedEntries.length, 1, 'entry activates purely from additionalScanInjects text');
}

{
    const entries = [{ uid: '1', world: 'w', key: ['unicorn'], content: 'Unicorns are rare.' }];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['nothing relevant here'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens,
        additionalScanInjects: ['', null, undefined],
    });
    assert.equal(activatedEntries.length, 0, 'empty/falsy injects contribute no scannable text');
}

console.log('activation.test.js: all assertions passed');
