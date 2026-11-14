import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { TYPE } from '../library-codes.js';
import { worldbuildingWorldPorts } from './worldbuilding-worlds.js';
import { worldbuildingViewPorts } from './worldbuilding-views.js';

const { emptyUser } = await import('../../tests/converted-user.fixture.js');
const user = await emptyUser('st-worldbuilding-views-test-');
after(() => user.close());
const lib = user.store.lib;
const uiUser = /** @type {import('@st/server-ui').User} */ ({ handle: 'u', directories: user.directories });
const who = { user: uiUser, session: 's' };
const worlds = worldbuildingWorldPorts({ libOf: async () => lib, booksChanged: async (_user, change) => change() });
const views = worldbuildingViewPorts({ libOf: async () => lib });

const holder = lib.nextId++;
await lib.store.commit([{ kind: 'entityCreate', entity: holder, type: TYPE.user, key: 'u', added: 0 }]);

/**
 * @param {string} name
 * @param {unknown} contents
 */
function upload(name, contents) {
    const file = path.join(user.dataRoot, `upload-${name}`);
    fs.writeFileSync(file, JSON.stringify(contents));
    return { path: file, name, type: 'application/json', size: 0 };
}

const WORLD = {
    relationKinds: [{ id: 1, name: 'in' }],
    views: [
        { id: 'places', name: 'Places', groupBy: 1, drawing: 'cards', chips: [{ kind: 1, target: 0, depth: 'anyDepth' }] },
        { id: 'board', name: 'Who', groupBy: null, columns: [{ kind: 1, is: { target: 1 } }, { kind: 1, is: 'none' }] },
        { id: 'Bad Id', name: 'Dropped' },
        { id: 'places', name: 'A second view of the same id is dropped' },
    ],
    entries: {
        0: { uid: 0, key: ['Saltmarrow'], content: 'A town.' },
        1: { uid: 1, key: ['Lantern House'], content: 'An inn.', extensions: { relations: [{ kind: 1, target: 0, position: 'a0' }] } },
    },
};

test('a world file\'s views are the world\'s, their targets the entries its keys name; the reader\'s layer is kept apart and never exported', async () => {
    const made = /** @type {{ book: string }} */ (await worlds.importWorld(who, upload('Coast.json', WORLD)));
    const [town, inn] = await lib.ids(TYPE.entry, [`${made.book}:0`, `${made.book}:1`]);
    const read = await views.readViews(uiUser, made.book);
    assert.deepEqual(read?.world.map(view => view.id), ['places', 'board']);
    assert.deepEqual(read?.world[0].chips, [{ kind: '1', target: String(town), depth: 'anyDepth' }]);
    assert.deepEqual(read?.world[1].columns, [{ kind: '1', is: { target: String(inn), depth: 'directly' } }, { kind: '1', is: 'none' }]);
    assert.deepEqual(read?.reader, { changed: {}, own: [] });

    const changed = { ...read?.world[0], drawing: /** @type {const} */ ('rows'), fields: /** @type {const} */ (['tokens']) };
    const own = { ...changed, id: 'own-1', name: 'Mine' };
    assert.equal(await views.writeReaderViews(who, made.book, { changed: { places: /** @type {any} */ (changed) }, own: [(own)] }), 'ok');
    const again = await views.readViews(uiUser, made.book);
    assert.deepEqual(again?.reader.changed.places?.drawing, 'rows');
    assert.deepEqual(again?.reader.own.map(view => view.name), ['Mine']);
    assert.equal(again?.world[0].drawing, 'cards', 'the reader\'s change leaves the world\'s view as it was');

    const exported = JSON.parse(/** @type {any} */ (await worlds.exportWorld(uiUser, made.book)).json);
    assert.deepEqual(exported.views.map((/** @type {any} */ view) => view.id), ['places', 'board', 'Bad Id', 'places'], 'the file carries the views as it brought them');
    assert.equal(exported.views[0].chips[0].target, 0, 'a view names its targets by key in a file');
    assert.ok(!JSON.stringify(exported).includes('Mine'), 'the reader\'s own views stay out of the file');

    assert.equal(await views.writeReaderViews(who, made.book, { changed: {}, own: [] }), 'ok');
    assert.deepEqual((await views.readViews(uiUser, made.book))?.reader, { changed: {}, own: [] });
    assert.equal(await views.readViews(uiUser, '999999'), null);
});

test('a world\'s view is renamed or deleted in the world, with the reader\'s layer, in one write; the file follows', async () => {
    const made = /** @type {{ book: string }} */ (await worlds.importWorld(who, upload('Shore.json', WORLD)));
    const read = await views.readViews(uiUser, made.book);
    const copy = { ...read?.world[0], drawing: /** @type {const} */ ('rows') };
    const reader = { changed: { places: /** @type {any} */ ({ ...copy, name: 'Towns' }) }, own: [] };
    assert.equal(await views.changeWorldView(who, made.book, 'places', { name: 'Towns' }, reader), 'ok');
    const renamed = await views.readViews(uiUser, made.book);
    assert.deepEqual(renamed?.world.map(view => view.name), ['Towns', 'Who']);
    assert.equal(renamed?.reader.changed.places?.name, 'Towns');
    assert.equal(renamed?.world[0].chips[0]?.target, read?.world[0].chips[0]?.target, 'its targets stay as they were');

    assert.equal(await views.changeWorldView(who, made.book, 'places', { deleted: true }, { changed: {}, own: [] }), 'ok');
    const left = await views.readViews(uiUser, made.book);
    assert.deepEqual(left?.world.map(view => view.id), ['board']);
    assert.deepEqual(left?.reader, { changed: {}, own: [] });
    const exported = JSON.parse(/** @type {any} */ (await worlds.exportWorld(uiUser, made.book)).json);
    assert.ok(!exported.views.some((/** @type {any} */ view) => view.id === 'places'), 'the deleted view leaves the file');

    assert.equal(await views.changeWorldView(who, made.book, 'gone', { deleted: true }, { changed: {}, own: [] }), 'no view');
    assert.equal(await views.changeWorldView(who, '999999', 'board', { deleted: true }, { changed: {}, own: [] }), 'missing');
});
