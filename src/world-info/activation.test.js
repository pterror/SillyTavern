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

// Sticky: an entry activated once stays active (bypassing key matching) for its sticky duration,
// tracked in chatMetadata across calls - simulating two separate generations against the same chat.
{
    const entries = [{ uid: '1', world: 'w', key: ['dragon'], content: 'Dragon lore.', sticky: 3 }];
    const chatMetadata = {};

    // First call: matches on "dragon", becomes sticky for the next 3 messages.
    const first = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, chatMetadata,
    });
    assert.equal(first.activatedEntries.length, 1);

    // Second call: the new incoming message (most recent = index 0) has no key match, but the entry
    // is still within its sticky window (chat grew by 1, sticky lasts 3) - should still activate
    // via isSticky, bypassing key matching entirely.
    const second = await activateWorldInfoEntries(entries, ['something unrelated', 'a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, chatMetadata,
    });
    assert.equal(second.activatedEntries.length, 1, 'sticky keeps the entry active without a new key match');
}

// Cooldown: once a sticky entry's window ends, it goes on cooldown and is suppressed even if its key matches again
{
    const entries = [{ uid: '1', world: 'w', key: ['dragon'], content: 'Dragon lore.', sticky: 1, cooldown: 5 }];
    const chatMetadata = {};

    await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, chatMetadata,
    });
    // Chat advances past the sticky window (sticky=1 -> ends when chat.length >= start+1 = 2).
    // "dragon again" is the new incoming message (most recent = index 0) - it WOULD match the key
    // directly if cooldown weren't suppressing the entry.
    const afterSticky = await activateWorldInfoEntries(entries, ['dragon again', 'a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, chatMetadata,
    });
    assert.equal(afterSticky.activatedEntries.length, 0, 'entry is on cooldown, suppressed despite matching key');
    assert.ok(chatMetadata.timedWorldInfo.cooldown['w.1'], 'cooldown recorded on sticky expiry');
}

// Delay: an entry with a delay longer than the current chat length never activates, even on key match
{
    const entries = [{ uid: '1', world: 'w', key: ['dragon'], content: 'Dragon lore.', delay: 10 }];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, chatMetadata: {},
    });
    assert.equal(activatedEntries.length, 0, 'suppressed by delay regardless of key match');
}

// isDryRun: sticky state is never written, so a second dry-run call doesn't see it as sticky
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

// Inclusion groups: two entries sharing a group tag are mutually exclusive - only one activates
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

// Character filter: an entry restricted to a different character never activates for this one
{
    const entries = [{ uid: '1', world: 'w', key: ['dragon'], content: 'Dragon lore.', characterFilter: { names: ['other.png'], isExclude: false } }];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens,
        entryFilterContext: { characterFilename: 'alice.png' },
    });
    assert.equal(activatedEntries.length, 0, 'entry restricted to a different character is filtered out');
}

// Generation-trigger filter: an entry restricted to specific trigger types is suppressed otherwise
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

// Once budget overflows, recursion stops entirely for the rest of the scan - verified against the
// client source: nextScanState only ever becomes RECURSION/MIN_ACTIVATIONS when !token_budget_overflowed,
// so a match that would only be reachable via a post-overflow recursion pass never activates, even
// though the entry that overflowed the budget DOES contain the recursion trigger word in its content.
{
    let calls = 0;
    const countingCountTokens = async (text) => { calls++; return Math.ceil(text.length / 4); };
    const entries = [
        { uid: '1', world: 'w', key: ['dragon'], content: 'x'.repeat(4000) + ' cave' }, // overflows the tiny budget below
        { uid: '2', world: 'w', key: ['cave'], content: 'Cave lore.' }, // would only be reachable by recursing through entry 1's content
    ];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['a dragon appears'], {
        maxContext: 4000, budgetPercent: 1, countTokens: countingCountTokens, depth: 1, recursive: true, // budget = 40 tokens, entry 1 alone overflows it
    });
    assert.equal(activatedEntries.length, 0, 'entry 1 is cut by budget, and entry 2 never gets a recursion pass to be found in');
    assert.equal(calls, 2, 'exactly one pass ran (1 shared scanTokens call + 1 for entry 1'
        + '\'s own content) - no second pass was attempted after overflow');
}

console.log('activation.test.js: all assertions passed');
