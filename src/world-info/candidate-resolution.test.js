import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWorldInfoCandidates, world_info_insertion_strategy, EMBEDDED_WORLD_NAME } from './candidate-resolution.js';

/** Minimal real on-disk lorebook shape, matching default/content/Eldoria.json's entries format. */
function makeEntry(uid, order, content = `content-${uid}`) {
    return {
        uid,
        key: [`key-${uid}`],
        keysecondary: [],
        comment: '',
        content,
        constant: false,
        selective: true,
        order,
        position: 0,
        disable: false,
    };
}

function writeLorebook(dir, name, entries) {
    const entriesObj = {};
    for (const entry of entries) {
        entriesObj[String(entry.uid)] = entry;
    }
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ entries: entriesObj }));
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wi-candidate-resolution-'));
const directories = { worlds: tmpRoot };

writeLorebook(tmpRoot, 'Global', [makeEntry('g1', 10), makeEntry('g2', 20)]);
writeLorebook(tmpRoot, 'CharBase', [makeEntry('c1', 15)]);
writeLorebook(tmpRoot, 'CharExtra', [makeEntry('c2', 5)]);
writeLorebook(tmpRoot, 'ChatWorld', [makeEntry('ch1', 1)]);
writeLorebook(tmpRoot, 'PersonaWorld', [makeEntry('p1', 1)]);

const character = { data: { extensions: { world: 'CharBase' } } };

// (a) global + character lore merge under each of the 3 strategies, asserting actual resulting order.
{
    const entries = await resolveWorldInfoCandidates({
        directories,
        selectedWorldInfo: ['Global'],
        character,
        worldInfoCharacterStrategy: world_info_insertion_strategy.evenly,
    });
    // evenly: [...globalLore, ...characterLore].sort by order desc -> g2(20), c1(15), g1(10)
    assert.deepEqual(entries.map(e => e.uid), ['g2', 'c1', 'g1']);
}
{
    const entries = await resolveWorldInfoCandidates({
        directories,
        selectedWorldInfo: ['Global'],
        character,
        worldInfoCharacterStrategy: world_info_insertion_strategy.character_first,
    });
    // character_first: characterLore sorted, then globalLore sorted -> c1(15), then g2(20), g1(10)
    assert.deepEqual(entries.map(e => e.uid), ['c1', 'g2', 'g1']);
}
{
    const entries = await resolveWorldInfoCandidates({
        directories,
        selectedWorldInfo: ['Global'],
        character,
        worldInfoCharacterStrategy: world_info_insertion_strategy.global_first,
    });
    // global_first: globalLore sorted, then characterLore sorted -> g2(20), g1(10), then c1(15)
    assert.deepEqual(entries.map(e => e.uid), ['g2', 'g1', 'c1']);
}

// (b) chat lore and persona lore always land first (in that order) regardless of strategy.
{
    const entries = await resolveWorldInfoCandidates({
        directories,
        selectedWorldInfo: ['Global'],
        character,
        chatWorldName: 'ChatWorld',
        personaWorldLorebook: 'PersonaWorld',
        worldInfoCharacterStrategy: world_info_insertion_strategy.evenly,
    });
    assert.deepEqual(entries.map(e => e.uid), ['ch1', 'p1', 'g2', 'c1', 'g1']);
}

// (c) skip-precedence rules in getCharacterLore.
{
    // A world already selected globally is excluded from character lore (it still appears via
    // global lore - just not duplicated).
    const entries = await resolveWorldInfoCandidates({
        directories,
        selectedWorldInfo: ['CharBase'],
        character,
    });
    assert.equal(entries.filter(e => e.uid === 'c1').length, 1, 'character world already in global selection is not duplicated');
}
{
    // A world matching the chat world is excluded from character lore.
    const charInChat = { data: { extensions: { world: 'ChatWorld' } } };
    const entries = await resolveWorldInfoCandidates({
        directories,
        character: charInChat,
        chatWorldName: 'ChatWorld',
    });
    // ch1 should appear exactly once (from chat lore), not duplicated via character lore.
    assert.equal(entries.filter(e => e.uid === 'ch1').length, 1);
}
{
    // A world matching the persona world is excluded from character lore.
    const charAsPersona = { data: { extensions: { world: 'PersonaWorld' } } };
    const entries = await resolveWorldInfoCandidates({
        directories,
        character: charAsPersona,
        personaWorldLorebook: 'PersonaWorld',
    });
    assert.equal(entries.filter(e => e.uid === 'p1').length, 1);
}
{
    // characterExtraBooks contributes additional worlds beyond extensions.world.
    const entries = await resolveWorldInfoCandidates({
        directories,
        character,
        characterExtraBooks: ['CharExtra'],
    });
    assert.ok(entries.some(e => e.uid === 'c1'));
    assert.ok(entries.some(e => e.uid === 'c2'));
}

// (d) each returned entry has decorators/content/hash/world fields; content has decorators stripped.
{
    writeLorebook(tmpRoot, 'Decorated', [makeEntry('d1', 1, '@@activate\nThe rest of the content.')]);
    const entries = await resolveWorldInfoCandidates({
        directories,
        selectedWorldInfo: ['Decorated'],
    });
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.equal(entry.world, 'Decorated');
    assert.deepEqual(entry.decorators, ['@@activate']);
    assert.equal(entry.content, 'The rest of the content.');
    assert.equal(typeof entry.hash, 'number');
}

// (e) missing/absent lorebooks degrade to empty contributions, not a crash.
{
    const entries = await resolveWorldInfoCandidates({
        directories,
        selectedWorldInfo: ['DoesNotExist'],
        character: { data: { extensions: { world: 'AlsoMissing' } } },
        chatWorldName: 'StillMissing',
        personaWorldLorebook: 'MissingToo',
    });
    assert.deepEqual(entries, []);
}
{
    // No character, no persona, no chat lorebook configured at all.
    const entries = await resolveWorldInfoCandidates({ directories });
    assert.deepEqual(entries, []);
}

// (f) embedded character_book fallback: extensions.world names a book that doesn't exist on disk,
// and the character carries its own embedded character_book - its entries get converted and
// tagged with EMBEDDED_WORLD_NAME.
{
    const embeddedCharacter = {
        data: {
            extensions: { world: 'DoesNotExistOnDisk' },
            character_book: {
                entries: [
                    { id: 0, keys: ['alpha'], content: 'Embedded content A', insertion_order: 1, enabled: true },
                    { id: 1, keys: ['beta'], content: 'Embedded content B', insertion_order: 2, enabled: true, extensions: { position: 1 } },
                ],
            },
        },
    };
    const entries = await resolveWorldInfoCandidates({ directories, character: embeddedCharacter });
    assert.equal(entries.length, 2);
    assert.ok(entries.every(e => e.world === EMBEDDED_WORLD_NAME));
    const a = entries.find(e => e.uid === 0);
    assert.equal(a.key[0], 'alpha');
    assert.equal(a.content, 'Embedded content A');
    assert.equal(a.disable, false);
    const b = entries.find(e => e.uid === 1);
    assert.equal(b.position, 1);
}
{
    // Real World file exists for extensions.world -> embedded book is NOT used, even though present.
    const characterWithRealWorld = {
        data: {
            extensions: { world: 'CharBase' },
            character_book: { entries: [{ id: 0, keys: ['gamma'], content: 'Should not appear', insertion_order: 1, enabled: true }] },
        },
    };
    const entries = await resolveWorldInfoCandidates({ directories, character: characterWithRealWorld });
    assert.ok(!entries.some(e => e.world === EMBEDDED_WORLD_NAME));
    assert.ok(entries.some(e => e.uid === 'c1' && e.world === 'CharBase'));
}
{
    // No extensions.world at all, but an embedded character_book exists -> still used (baseWorldName
    // is falsy, so baseWorldResolves is false, matching the client's `!!baseWorldName && ...` check).
    const characterNoBaseWorld = {
        data: { character_book: { entries: [{ id: 0, keys: ['delta'], content: 'Embedded, no base world', insertion_order: 1, enabled: true }] } },
    };
    const entries = await resolveWorldInfoCandidates({ directories, character: characterNoBaseWorld });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].world, EMBEDDED_WORLD_NAME);
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log('candidate-resolution.test.js passed');
