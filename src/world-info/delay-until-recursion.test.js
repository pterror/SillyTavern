import assert from 'node:assert/strict';
import { activateWorldInfoEntries } from './activation.js';

const countTokens = async (text) => Math.ceil(text.length / 4);

{
    const entries = [{ uid: '1', world: 'w', key: ['gold'], delayUntilRecursion: true, content: 'Gold treasure.' }];
    const { activatedEntries } = await activateWorldInfoEntries(entries, ['looking for gold'], {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens,
    });
    assert.equal(activatedEntries.length, 0, 'delayUntilRecursion entry is suppressed on every non-RECURSION pass, and no RECURSION pass ever happens here');
}

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

{
    const { activatedEntries } = await activateWorldInfoEntries(lifecycleEntries(), lifecycleChat, {
        maxContext: 4000, budgetPercent: 100, depth: 1, countTokens, maxRecursionStepsSetting: 2,
    });
    const uids = activatedEntries.map(e => e.uid).sort();
    assert.deepEqual(uids, ['levelone', 'trigger'], 'cutting the scan short before the forced third pass leaves the level-2 entry unactivated');
}

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
