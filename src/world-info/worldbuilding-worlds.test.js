import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { TYPE } from '../library-codes.js';
import { CHOICE, readChoices, takeUpstreamLastOpened } from '../settings-model/book-choices.js';
import { EMBEDDED_NAME_REFUSAL, LENGTH_REFUSAL, NAME_REFUSAL, worldbuildingWorldPorts } from './worldbuilding-worlds.js';

const { emptyUser } = await import('../../tests/converted-user.fixture.js');
const user = await emptyUser('st-worldbuilding-worlds-test-');
after(() => user.close());
const lib = user.store.lib;
const uiUser = /** @type {import('@st/server-ui').User} */ ({ handle: 'u', directories: user.directories });
const who = { user: uiUser, session: 's' };

/** @type {import('../settings-documents.js').BookChooser[][]} */
const changes = [];
const ports = worldbuildingWorldPorts({
    libOf: async () => lib,
    async booksChanged(_user, change) {
        const done = await change();
        changes.push(done.choosers);
        return done;
    },
});

const holder = lib.nextId++;
await lib.store.commit([{ kind: 'entityCreate', entity: holder, type: TYPE.user, key: 'u', added: 0 }]);

/**
 * @param {import('@st/worldbuilding/server').NewWorld | 'missing'} made
 */
function bookOf(made) {
    if (typeof made === 'string' || 'refused' in made) throw new Error(`nothing made: ${JSON.stringify(made)}`);
    return made.book;
}

/**
 * @param {string} name
 * @param {unknown} contents
 */
function upload(name, contents) {
    const file = path.join(user.dataRoot, `upload-${name}`);
    fs.writeFileSync(file, JSON.stringify(contents));
    return { path: file, name, type: 'application/json', size: 0 };
}

const names = async () => (await ports.readWorlds(uiUser)).map(w => w.name);

test('a world is made under the name asked for, refused when taken, reserved or no name a world can have', async () => {
    const lantern = bookOf(await ports.createWorld(who, 'Lantern'));
    assert.deepEqual(await ports.readWorld(uiUser, lantern), { id: lantern, name: 'Lantern', entries: 0, usedInEveryChat: false });
    assert.deepEqual(await ports.createWorld(who, 'Lantern'), { refused: 'A world named "Lantern" already exists.' });
    assert.deepEqual(await ports.createWorld(who, '__embedded__'), { refused: EMBEDDED_NAME_REFUSAL });
    assert.deepEqual(await ports.createWorld(who, 'a/b'), { refused: NAME_REFUSAL });
    assert.deepEqual(await ports.createWorld(who, 'con'), { refused: NAME_REFUSAL });
    assert.deepEqual(await ports.createWorld(who, 'é'.repeat(126)), { refused: LENGTH_REFUSAL });
    assert.equal(await ports.readWorld(uiUser, '999999'), null);
});

test('a file is imported under its own name, made free when taken, and counted from the kept counts', async () => {
    const book = { entries: { 0: { uid: 0, key: ['Ilse'], content: 'Keeper.' }, 1: { uid: 1, key: ['lamp'], content: 'A lamp.' } } };
    const ashfall = bookOf(await ports.importWorld(who, upload('Ashfall.json', book)));
    assert.deepEqual(await ports.readWorld(uiUser, ashfall), { id: ashfall, name: 'Ashfall', entries: 2, usedInEveryChat: false });
    const again = bookOf(await ports.importWorld(who, upload('Ashfall.json', { kind: 'memory', entries: [{ name: 'Inn', entry: 'An inn.', keywords: ['inn'], weight: 1, enabled: true }] })));
    assert.deepEqual(await ports.readWorld(uiUser, again), { id: again, name: 'Ashfall (1)', entries: 1, usedInEveryChat: false });
    assert.deepEqual(await ports.importWorld(who, upload('notes.json', { notes: [] })), { refused: 'This file isn\'t a world: it holds no entries SillyTavern, NovelAI, Agnai or Risu can make.' });
    assert.deepEqual(await names(), ['Ashfall (1)', 'Ashfall', 'Lantern']);
});

test('a copy takes the next free name and every entry; an export is the world file under its name', async () => {
    const [ashfall] = (await ports.readWorlds(uiUser)).filter(w => w.name === 'Ashfall');
    const copy = bookOf(await ports.duplicateWorld(who, ashfall.id));
    assert.deepEqual(await ports.readWorld(uiUser, copy), { id: copy, name: 'Ashfall (2)', entries: 2, usedInEveryChat: false });
    const exported = await ports.exportWorld(uiUser, copy);
    assert.equal(exported?.fileName, 'Ashfall (2).json');
    assert.deepEqual(Object.values(JSON.parse(exported?.json ?? '{}').entries).map((/** @type {any} */ e) => e.key), [['Ilse'], ['lamp']]);
    assert.equal(await ports.duplicateWorld(who, '999999'), 'missing');
    assert.equal(await ports.exportWorld(uiUser, '999999'), null);
});

test('the world opened is the one asked for, else the last opened, else the first; it is kept by id through a rename and gone with its world', async () => {
    const [first, , , lantern] = await ports.readWorlds(uiUser);
    assert.equal(lantern.name, 'Lantern');
    assert.equal(await ports.openWorld(who, null), first.id);
    assert.equal(await ports.openWorld(who, lantern.id), lantern.id);
    assert.equal(await ports.openWorld(who, null), lantern.id);
    assert.equal(await ports.openWorld(who, '999999'), null);
    assert.equal(await ports.openWorld(who, null), lantern.id);

    assert.equal(await ports.renameWorld(who, lantern.id, 'Lantern House'), 'ok');
    assert.equal((await ports.readWorld(uiUser, lantern.id))?.name, 'Lantern House');
    assert.equal(await ports.openWorld(who, null), lantern.id);
    assert.deepEqual(await ports.renameWorld(who, lantern.id, 'Ashfall'), { refused: 'A world named "Ashfall" already exists.' });
    assert.deepEqual(await ports.renameWorld(who, lantern.id, 'a:b'), { refused: NAME_REFUSAL });
    assert.equal(await ports.renameWorld(who, '999999', 'x'), 'missing');

    assert.equal(await ports.deleteWorld(who, lantern.id), 'ok');
    assert.equal(await ports.readWorld(uiUser, lantern.id), null);
    assert.equal(await ports.openWorld(who, null), first.id);
    assert.equal(await ports.deleteWorld(who, lantern.id), 'missing');
});

test('being used in every chat is the global selection, written by id and gone with its world', async () => {
    const [one, two] = await ports.readWorlds(uiUser);
    changes.length = 0;
    assert.equal(await ports.setUsedInEveryChat(who, one.id, true), 'ok');
    assert.equal(await ports.setUsedInEveryChat(who, two.id, true), 'ok');
    assert.equal(await ports.setUsedInEveryChat(who, two.id, true), 'ok');
    assert.deepEqual((await ports.readWorlds(uiUser)).map(w => w.usedInEveryChat), [true, true, false]);
    assert.deepEqual(changes.map(c => c.length), [1, 1, 0]);
    assert.deepEqual(changes[0], [{ holder, slot: CHOICE.selected, type: TYPE.user, key: 'u' }]);
    assert.equal(await ports.setUsedInEveryChat(who, one.id, false), 'ok');
    assert.deepEqual((await readChoices(lib, [holder])).get(holder)?.get(CHOICE.selected), [two.name]);
    changes.length = 0;
    assert.equal(await ports.deleteWorld(who, two.id), 'ok');
    assert.ok(changes[0].some(c => c.holder === holder && c.slot === CHOICE.selected), 'the delete names the user as a chooser');
    assert.deepEqual((await readChoices(lib, [holder])).get(holder)?.get(CHOICE.selected) ?? [], []);
    assert.equal(await ports.setUsedInEveryChat(who, two.id, true), 'missing');
});

test('upstream\'s last edited world, read when upstream\'s settings are converted, is the last opened', async () => {
    const [world] = await ports.readWorlds(uiUser);
    await takeUpstreamLastOpened(lib, 'u', { power_user: { wi_last_editor_book: world.name } });
    assert.deepEqual((await readChoices(lib, [holder])).get(holder)?.get(CHOICE.lastOpened), [world.name]);
    await takeUpstreamLastOpened(lib, 'u', { power_user: { wi_last_editor_book: 'No such world' } });
    assert.deepEqual((await readChoices(lib, [holder])).get(holder)?.get(CHOICE.lastOpened) ?? [], []);
    await takeUpstreamLastOpened(lib, 'nobody', { power_user: { wi_last_editor_book: world.name } });
});
