import assert from 'node:assert/strict';
import { activateWorldInfoEntries } from './activation.js';

const countTokens = async (text) => Math.ceil(text.length / 4); // cheap deterministic stand-in

// (a) Isolated suppression: a delayUntilRecursion entry whose key matches the chat directly is never
// activated on an INITIAL pass, and with only ONE distinct delay level requested, that level is
// "preset" as currentRecursionDelayLevel before scanning even starts - so there is nothing left in
// availableRecursionDelayLevels to force a RECURSION pass, and nothing else in this scenario
// naturally triggers one either. The entry never gets a chance to be scanned at all.
{
    const entries = [{ uid: '1', world: 'w', key: ['gold'], delayUntilRecursion: true, content: 'Gold treasure.' }];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['looking for gold'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens,
    });
    assert.equal(activatedEntries.length, 0, 'delayUntilRecursion entry is suppressed on every non-RECURSION pass, and no RECURSION pass ever happens here');
}

// (b)/(c) Full lifecycle: a plain trigger entry causes a normal RECURSION pass, which unlocks level 1
// (the preset level) for a level-1 delayed entry; since that entry has preventRecursion, nothing
// naturally continues the scan afterwards, but a still-open level-2 forces one more RECURSION pass
// (the "if scanning is done but delay levels remain, continue anyway" rule), unlocking the level-2
// entry. All three keys are present directly in chat text, so key matching itself isn't in question -
// only whether each entry is scanned/allowed on the right pass.
const lifecycleEntries = () => [
    { uid: 'trigger', world: 'w', key: ['dragon'], content: 'Dragon lore.' },
    { uid: 'levelone', world: 'w', key: ['gold'], delayUntilRecursion: true, content: 'Gold.', preventRecursion: true },
    { uid: 'leveltwo', world: 'w', key: ['shiny'], delayUntilRecursion: 2, content: 'Shiny.', preventRecursion: true },
];
const lifecycleChat = ['a dragon appears, there is gold and something shiny too'];

{
    const { activatedEntries } = await activateWorldInfoEntries(lifecycleEntries(), lifecycleChat, {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens,
    });
    const uids = activatedEntries.map(e => e.uid).sort();
    assert.deepEqual(uids, ['levelone', 'leveltwo', 'trigger'], 'given enough passes, the trigger and both delay levels all activate');
}

// Same scenario, but capped at 2 scan steps (INITIAL, then one RECURSION pass unlocking level 1) -
// the forced third pass that would unlock level 2 never gets to run, proving level 2 genuinely
// requires its own later pass rather than piggybacking on level 1's.
{
    const { activatedEntries } = await activateWorldInfoEntries(lifecycleEntries(), lifecycleChat, {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, maxRecursionStepsSetting: 2,
    });
    const uids = activatedEntries.map(e => e.uid).sort();
    assert.deepEqual(uids, ['levelone', 'trigger'], 'cutting the scan short before the forced third pass leaves the level-2 entry unactivated');
}

// (d) The forced continuation when delay levels remain open is NOT gated on the `recursive` setting
// at all. With recursive:false, no entry ever triggers a "normal" recursion pass - the ONLY way a
// RECURSION pass happens here is via the delay-continuation rule itself. Two levels are requested;
// the first is consumed as the preset starting level (never separately scanned for), and the
// still-open second level forces exactly one RECURSION pass. During that pass,
// currentRecursionDelayLevel is 2, so both entries (needing level 1 and level 2) pass the
// "required level > currentRecursionDelayLevel" check and both activate together.
{
    const entries = [
        { uid: 'levelone', world: 'w', key: ['gold'], delayUntilRecursion: 1, content: 'Gold.' },
        { uid: 'leveltwo', world: 'w', key: ['silver'], delayUntilRecursion: 2, content: 'Silver.' },
    ];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['there is gold and silver here'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, recursive: false,
    });
    const uids = activatedEntries.map(e => e.uid).sort();
    assert.deepEqual(uids, ['levelone', 'leveltwo'], 'delay-continuation forces a RECURSION pass even with recursive:false, unlocking both entries at once');
}

console.log('delay-until-recursion.test.js: all assertions passed');
