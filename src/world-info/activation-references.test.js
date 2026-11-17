import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { emptyUser, seedMessages } from '../../tests/converted-user.fixture.js';
import { TYPE } from '../library-codes.js';
import { SLOT } from '../world-info-engine.js';
import { keysThatBroughtUp } from './activation-record.js';
import { resolveActivationReferences, resolvedActivations } from './activation-references.js';

const user = await emptyUser('st-activation-references-');
after(() => user.close());
const lib = user.store.lib;

test('regular and embedded references resolve to exact targets, with null for unavailable or mismatched entries', async () => {
    await lib.books.write('References', { entries: { 4: { uid: 4, key: ['lamp'], content: 'Regular.' } } });
    const [regular] = await lib.books.entryRefs([{ world: 'References', uid: 4 }]);
    const target = { book: String(regular.book), entry: String(regular.entry) };
    const card = JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: {
        name: 'Keeper', extensions: {}, character_book: { entries: [
            { id: 73, keys: ['lamp'], content: 'Embedded.', enabled: true, extensions: {} },
            { keys: ['door'], content: 'Without a card ID.', enabled: true, extensions: {} },
        ] },
    } });
    await lib.writeCard(user.directories, 'Keeper.png', card);
    const [character] = await lib.ids(TYPE.character, ['Keeper.png']);
    const [book] = await lib.ids(TYPE.ownedBook, [`${character}:${SLOT.characterBook}`]);
    const stored = await lib.books.storedEntries(book);
    const embedded = { book: String(book), entry: String(stored[0].entity.id) };
    const withoutId = { book: String(book), entry: String(stored[1].entity.id) };
    const refs = [target, { card: '73' }, { card: '1' }, { card: 'missing' },
        { book: target.book, entry: embedded.entry }, { book: 'bad', entry: 'bad' },
        { book: target.book, entry: '999999999' }];
    assert.deepEqual(await resolveActivationReferences(lib, refs, 'Keeper.png'),
        [target, embedded, withoutId, null, null, null, null]);
    assert.deepEqual(await resolveActivationReferences(lib, [{ card: '73' }, target], null), [null, target]);
    assert.deepEqual(await resolveActivationReferences(lib, [{ card: '73' }], 'Missing.png'), [null]);

    const record = { entries: [
        { ref: { card: 'missing' }, keys: [], via: [] },
        { ref: { card: '73' }, keys: [{ key: 'lamp' }], via: [0] },
    ], cut: [{ ref: target, why: 'budget' }] };
    await lib.writeGroup({ id: 'references-group', name: 'References', members: ['Keeper.png'] });
    const [groupReply] = await seedMessages(user.store, { group: 'references-group' }, null,
        [{ mes: 'Reply', is_user: false, original_avatar: 'Keeper.png', extra: { activations: record } }]);
    const resolvedGroup = await resolvedActivations(user.store, groupReply);
    assert.deepEqual(resolvedGroup.entries.map(entry => entry.ref), [null, embedded], 'group replies use the original speaker');
    assert.deepEqual(resolvedGroup.entries[1].via, [0], 'unavailable rows keep their index');
    assert.deepEqual(resolvedGroup.cut[0].ref, target, 'cut entries use the same resolver');
    const [characterReply] = await seedMessages(user.store, { avatar: 'Keeper.png' }, null,
        [{ mes: 'Reply', is_user: false, extra: { activations: record } }]);
    assert.deepEqual((await resolvedActivations(user.store, characterReply)).entries[1].ref, embedded,
        'single-character replies resolve through the chat owner without original_avatar');
    assert.equal(await resolvedActivations(user.store, 'missing'), null);

    const resolved = await resolveActivationReferences(lib, [target, { card: '73' }, { card: 'missing' }], 'Keeper.png');
    assert.deepEqual(keysThatBroughtUp({ entries: resolved.map((ref, index) => ({ ref, keys: [{ key: `key${index}` }] })) },
        [target, embedded, withoutId]), [['key0'], ['key1'], null], 'preview provenance uses resolved targets too');

    await lib.books.write('References', { entries: {} });
    assert.deepEqual(await resolveActivationReferences(lib, [target], 'Keeper.png'), [null]);
    await lib.writeCard(user.directories, 'Keeper.png', JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Keeper', extensions: {} } }));
    assert.deepEqual(await resolveActivationReferences(lib, [{ card: '73' }], 'Keeper.png'), [null]);
});
