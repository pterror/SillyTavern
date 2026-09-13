import assert from 'node:assert/strict';
import { filterByInclusionGroups } from './inclusion-groups.js';
import { WorldInfoBuffer, scan_state } from './key-matching.js';
import { WorldInfoTimedEffects } from './timed-effects.js';

function makeTimedEffects() {
    return new WorldInfoTimedEffects(['a'], [], {});
}
const buffer = new WorldInfoBuffer(['a dragon appears'], {}, { depth: 1 });

// Ungrouped entries are untouched
{
    const activatedNow = [{ uid: '1', world: 'w', content: 'a' }];
    filterByInclusionGroups(activatedNow, new Map(), buffer, scan_state.INITIAL, makeTimedEffects());
    assert.equal(activatedNow.length, 1);
}

// Priority override wins regardless of weight/random
{
    const a = { uid: '1', world: 'w', group: 'g', order: 1 };
    const b = { uid: '2', world: 'w', group: 'g', order: 5, groupOverride: true };
    const activatedNow = [a, b];
    filterByInclusionGroups(activatedNow, new Map(), buffer, scan_state.INITIAL, makeTimedEffects(), { random: () => 0.01 });
    assert.deepEqual(activatedNow, [b]);
}

// Highest-order priority entry wins when multiple have groupOverride
{
    const a = { uid: '1', world: 'w', group: 'g', order: 1, groupOverride: true };
    const b = { uid: '2', world: 'w', group: 'g', order: 5, groupOverride: true };
    const activatedNow = [a, b];
    filterByInclusionGroups(activatedNow, new Map(), buffer, scan_state.INITIAL, makeTimedEffects());
    assert.deepEqual(activatedNow, [b]);
}

// Weighted random: a rollValue that lands past entry A's weight picks entry B
{
    const a = { uid: '1', world: 'w', group: 'g', groupWeight: 10 };
    const b = { uid: '2', world: 'w', group: 'g', groupWeight: 10 };
    const activatedNow = [a, b];
    // totalWeight = 20; roll = 0.6 * 20 = 12, which is past a's cumulative weight (10) -> b wins
    filterByInclusionGroups(activatedNow, new Map(), buffer, scan_state.INITIAL, makeTimedEffects(), { random: () => 0.6 });
    assert.deepEqual(activatedNow, [b]);
}

// A group already won in a previous pass is fully suppressed this pass (all removed, no new winner)
{
    const a = { uid: '1', world: 'w', group: 'g' };
    const winner = { uid: '2', world: 'w', group: 'g' };
    const activatedNow = [a];
    const allActivatedEntries = new Map([['w.2', winner]]);
    filterByInclusionGroups(activatedNow, allActivatedEntries, buffer, scan_state.INITIAL, makeTimedEffects());
    assert.equal(activatedNow.length, 0);
}

// Sticky entries in a group are the only survivors, bypassing weighted random entirely.
// setTimedEffect() marks the effect as starting "now"; checkTimedEffects() only considers it
// active once the chat has advanced past that start point (same two-step shape
// activateWorldInfoEntries naturally has across two real calls) - so this simulates that with a
// separate, later WorldInfoTimedEffects instance over a longer chat, same as a second generation.
{
    const sticky = { uid: '1', world: 'w', group: 'g', hash: 1, sticky: 3 };
    const other = { uid: '2', world: 'w', group: 'g', hash: 2 };
    const chatMetadata = {};
    new WorldInfoTimedEffects(['a'], [sticky, other], chatMetadata).setTimedEffect('sticky', sticky, true);

    const timedEffects = new WorldInfoTimedEffects(['a', 'b'], [sticky, other], chatMetadata);
    timedEffects.checkTimedEffects();

    const activatedNow = [sticky, other];
    filterByInclusionGroups(activatedNow, new Map(), buffer, scan_state.INITIAL, timedEffects, { random: () => 0.99 });
    assert.deepEqual(activatedNow, [sticky], 'sticky entry survives, non-sticky groupmate removed, no random roll needed');
}

// Cooldown/delay entries in a group are removed before any winner selection happens
{
    const cooling = { uid: '1', world: 'w', group: 'g', hash: 1, cooldown: 3 };
    const survivor = { uid: '2', world: 'w', group: 'g', hash: 2 };
    const chatMetadata = {};
    new WorldInfoTimedEffects(['a'], [cooling, survivor], chatMetadata).setTimedEffect('cooldown', cooling, true);

    const timedEffects = new WorldInfoTimedEffects(['a', 'b'], [cooling, survivor], chatMetadata);
    timedEffects.checkTimedEffects();

    const activatedNow = [cooling, survivor];
    filterByInclusionGroups(activatedNow, new Map(), buffer, scan_state.INITIAL, timedEffects, { random: () => 0.99 });
    assert.deepEqual(activatedNow, [survivor]);
}

// Entries in multiple comma-separated groups are considered part of each
{
    const a = { uid: '1', world: 'w', group: 'g1, g2', order: 1, groupOverride: true };
    const b = { uid: '2', world: 'w', group: 'g1', order: 0 };
    const c = { uid: '3', world: 'w', group: 'g2', order: 0 };
    const activatedNow = [a, b, c];
    filterByInclusionGroups(activatedNow, new Map(), buffer, scan_state.INITIAL, makeTimedEffects());
    assert.deepEqual(activatedNow, [a], 'a wins both g1 and g2 via priority override, removing b and c');
}

console.log('inclusion-groups.test.js: all assertions passed');
