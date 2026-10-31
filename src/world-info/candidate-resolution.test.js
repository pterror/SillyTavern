import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setConfigFilePath } from '../util.js';

setConfigFilePath(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'default', 'config.yaml'));

const { resolveWorldInfoCandidates, world_info_insertion_strategy, EMBEDDED_WORLD_NAME } = await import('./candidate-resolution.js');
const { importWorldInfoFromRaw } = await import('../endpoints/worldinfo.js');
const user = await (await import('../../tests/converted-user.fixture.js')).convertedUser('wi-candidate-resolution-');
const directories = user.directories;

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

async function writeLorebook(name, entries) {
    const entriesObj = {};
    for (const entry of entries) {
        entriesObj[String(entry.uid)] = entry;
    }
    await importWorldInfoFromRaw(directories, name, JSON.stringify({ entries: entriesObj }));
}

await writeLorebook('Global', [makeEntry('g1', 10), makeEntry('g2', 20)]);
await writeLorebook('CharBase', [makeEntry('c1', 15)]);
await writeLorebook('CharExtra', [makeEntry('c2', 5)]);
await writeLorebook('ChatWorld', [makeEntry('ch1', 1)]);
await writeLorebook('PersonaWorld', [makeEntry('p1', 1)]);

const character = { data: { extensions: { world: 'CharBase' } } };

{
    const entries = await resolveWorldInfoCandidates({
        directories,
        selectedWorldInfo: ['Global'],
        character,
        worldInfoCharacterStrategy: world_info_insertion_strategy.evenly,
    });
    assert.deepEqual(entries.map(e => e.uid), ['g2', 'c1', 'g1']);
}
{
    const entries = await resolveWorldInfoCandidates({
        directories,
        selectedWorldInfo: ['Global'],
        character,
        worldInfoCharacterStrategy: world_info_insertion_strategy.character_first,
    });
    assert.deepEqual(entries.map(e => e.uid), ['c1', 'g2', 'g1']);
}
{
    const entries = await resolveWorldInfoCandidates({
        directories,
        selectedWorldInfo: ['Global'],
        character,
        worldInfoCharacterStrategy: world_info_insertion_strategy.global_first,
    });
    assert.deepEqual(entries.map(e => e.uid), ['g2', 'g1', 'c1']);
}

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

{
    const entries = await resolveWorldInfoCandidates({
        directories,
        selectedWorldInfo: ['CharBase'],
        character,
    });
    assert.equal(entries.filter(e => e.uid === 'c1').length, 1, 'character world already in global selection is not duplicated');
}
{
    const charInChat = { data: { extensions: { world: 'ChatWorld' } } };
    const entries = await resolveWorldInfoCandidates({
        directories,
        character: charInChat,
        chatWorldName: 'ChatWorld',
    });
    assert.equal(entries.filter(e => e.uid === 'ch1').length, 1);
}
{
    const charAsPersona = { data: { extensions: { world: 'PersonaWorld' } } };
    const entries = await resolveWorldInfoCandidates({
        directories,
        character: charAsPersona,
        personaWorldLorebook: 'PersonaWorld',
    });
    assert.equal(entries.filter(e => e.uid === 'p1').length, 1);
}
{
    const entries = await resolveWorldInfoCandidates({
        directories,
        character,
        characterExtraBooks: ['CharExtra'],
    });
    assert.ok(entries.some(e => e.uid === 'c1'));
    assert.ok(entries.some(e => e.uid === 'c2'));
}

{
    await writeLorebook('Decorated', [makeEntry('d1', 1, '@@activate\nThe rest of the content.')]);
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
    const entries = await resolveWorldInfoCandidates({ directories });
    assert.deepEqual(entries, []);
}

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
    const characterNoBaseWorld = {
        data: { character_book: { entries: [{ id: 0, keys: ['delta'], content: 'Embedded, no base world', insertion_order: 1, enabled: true }] } },
    };
    const entries = await resolveWorldInfoCandidates({ directories, character: characterNoBaseWorld });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].world, EMBEDDED_WORLD_NAME);
}

await user.close();

console.log('candidate-resolution.test.js passed');
