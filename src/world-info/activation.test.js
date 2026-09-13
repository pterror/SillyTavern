import assert from 'node:assert/strict';
import { activateWorldInfoEntries } from './activation.js';

const countTokens = async (text) => Math.ceil(text.length / 4); // cheap deterministic stand-in

// Basic key match activates an entry
{
    const entries = [{ uid: '1', world: 'w', key: ['dragon'], content: 'Dragons breathe fire.' }];
    const { activatedEntries, content } = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens,
    });
    assert.equal(activatedEntries.length, 1);
    assert.equal(content, 'Dragons breathe fire.');
}

// No key match -> nothing activates
{
    const entries = [{ uid: '1', world: 'w', key: ['griffin'], content: 'Griffins fly.' }];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens,
    });
    assert.equal(activatedEntries.length, 0);
}

// Constant entries always activate regardless of chat content
{
    const entries = [{ uid: '1', world: 'w', key: [], constant: true, content: 'Always here.' }];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['nothing relevant'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens,
    });
    assert.equal(activatedEntries.length, 1);
}

// Recursion: entry A's content contains the key for entry B
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

// Recursion disabled: only the directly-matched entry activates
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

// preventRecursion: entry's content doesn't feed back into the recursion buffer
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

// Token budget enforcement: a tiny budget stops further entries from activating
{
    const entries = [
        { uid: '1', world: 'w', key: ['dragon'], content: 'x'.repeat(400) },
        { uid: '2', world: 'w', key: ['dragon'], content: 'y'.repeat(400) },
    ];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 1, countTokens, depth: 1, // budget = round(1% of 4000) = 40 tokens
    });
    assert.ok(activatedEntries.length < 2, 'budget should prevent both large entries from activating');
}

// ignoreBudget entries activate even past the overflow point
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

// Probability: injected RNG deterministically gates activation
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

// disabled entries never activate even with a matching key
{
    const entries = [{ uid: '1', world: 'w', key: ['dragon'], content: 'hidden', disable: true }];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens,
    });
    assert.equal(activatedEntries.length, 0);
}

// budgetCap clamps a large percentage-based budget
{
    const entries = [{ uid: '1', world: 'w', key: ['dragon'], content: 'x'.repeat(2000) }];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 100000, budgetPercent: 100, budgetCap: 10, countTokens, depth: 1,
    });
    assert.equal(activatedEntries.length, 0, 'a 10-token cap should reject a ~500-token entry');
}

// countTokens is called once per pass for the accumulated-so-far text, not once per entry -
// regression guard for a real inefficiency this session caught by cross-checking the client source
// (which computes textToScanTokens once before its per-entry loop, not inside it).
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
    // 1 call for the shared "scanned so far" total (once per pass) + 1 call per entry for its own
    // accumulated newContent = 1 + 3 = 4, not 3 entries x 2 calls each = 6.
    assert.equal(calls, 4, `expected 4 countTokens calls (1 shared + 1 per entry), got ${calls}`);
}

console.log('activation.test.js: all assertions passed');
