import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('../src/character-avatars.js')} */
let avatars;
/** @type {import('express').Router} */
let router;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

const originalCwd = process.cwd();

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    ({ router } = await import('../src/endpoints/characters.js'));
    cardParser = await import('../src/character-card-parser.js');
    avatars = await import('../src/character-avatars.js');

    process.chdir(path.resolve(originalCwd, '..'));

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/characters', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    process.chdir(originalCwd);
});

beforeEach(async () => {
    user = await (await import('./converted-user.fixture.js')).emptyUser('st-residency-test-');
    ({ directories } = user);
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(() => user.close());

const post = (route, body) => fetch(`${baseUrl}/api/characters/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

async function imageFile(avatar) {
    const file = avatars.avatarFile(directories, avatar);
    return fs.existsSync(file) ? file : null;
}

/** @returns {Promise<{ mtimeMs: number, size: number }>} */
async function fileStamp(avatar) {
    const s = fs.statSync(/** @type {string} */ (await imageFile(avatar)));
    return { mtimeMs: s.mtimeMs, size: s.size };
}

async function chunkOnDisk(avatar) {
    return JSON.parse(await cardParser.parse(/** @type {string} */ (await imageFile(avatar)), 'png'));
}

async function cardJsonOf(avatar) {
    const [card] = await user.store.lib.cards([avatar]);
    return card === null || card === undefined ? null : JSON.stringify(card);
}

const changeSeq = () => user.store.lib.changesEnd();

describe('metadata-only edits do not touch the PNG', () => {
    test('a field merge that changes only text leaves the file byte-identical and parks the content in the db', async () => {
        expect((await post('create', { ch_name: 'Alice', description: 'original', file_name: 'Alice' })).status).toBe(200);

        expect(JSON.parse(await cardJsonOf('Alice.png')).data.description).toBe('original');
        const before = await fileStamp('Alice.png');

        expect((await post('merge-attributes', { avatar: 'Alice.png', data: { description: 'EDITED' } })).status).toBe(200);

        expect(await fileStamp('Alice.png')).toEqual(before);

        await expect(chunkOnDisk('Alice.png')).rejects.toThrow('PNG metadata does not contain any');
        const parked = await cardJsonOf('Alice.png');
        expect(parked).not.toBeNull();
        expect(JSON.parse(parked).data.description).toBe('EDITED');
    });

    test('reads come back with the edited content, not the stale chunk', async () => {
        await post('create', { ch_name: 'Alice', description: 'original', file_name: 'Alice' });
        await post('merge-attributes', { avatar: 'Alice.png', data: { description: 'EDITED' } });

        const got = await (await post('get', { avatar_url: 'Alice.png' })).json();
        expect(got.data.description).toBe('EDITED');

        const [listRow] = await user.store.lib.cards(['Alice.png']);
        expect(listRow.name).toBe('Alice');
    });

    test('/batch resolves parked content for multiple characters in one request', async () => {
        await post('create', { ch_name: 'Alice', description: 'original', file_name: 'Alice' });
        await post('create', { ch_name: 'Bob', description: 'original', file_name: 'Bob' });
        await post('merge-attributes', { avatar: 'Alice.png', data: { description: 'EDITED-ALICE' } });
        await post('merge-attributes', { avatar: 'Bob.png', data: { description: 'EDITED-BOB' } });

        const batch = await (await post('batch', { avatars: ['Alice.png', 'Bob.png'] })).json();
        const byAvatar = Object.fromEntries(batch.map(c => [c.avatar, c]));
        expect(byAvatar['Alice.png'].data.description).toBe('EDITED-ALICE');
        expect(byAvatar['Bob.png'].data.description).toBe('EDITED-BOB');
    });

    test('successive edits keep replacing the parked copy', async () => {
        await post('create', { ch_name: 'Alice', description: 'v1', file_name: 'Alice' });
        const before = await fileStamp('Alice.png');

        await post('merge-attributes', { avatar: 'Alice.png', data: { description: 'v2' } });
        await post('merge-attributes', { avatar: 'Alice.png', data: { description: 'v3' } });

        expect(await fileStamp('Alice.png')).toEqual(before);
        const parked = JSON.parse(await cardJsonOf('Alice.png'));
        expect(parked.data.description).toBe('v3');
    });

    test('a rename is a metadata-only edit too', async () => {
        await post('create', { ch_name: 'Alice', description: 'desc', file_name: 'Alice' });
        const before = await fileStamp('Alice.png');

        expect((await post('rename', { avatar_url: 'Alice.png', new_name: 'Alicia' })).status).toBe(200);

        expect(await fileStamp('Alice.png')).toEqual(before);
        expect(JSON.parse(await cardJsonOf('Alice.png')).name).toBe('Alicia');
        const [row] = await user.store.lib.cards(['Alice.png']);
        expect(row.name).toBe('Alicia');
    });
});

describe('export still hands out a self-contained, current card', () => {
    test('PNG export carries the edited content even though the stored file does not', async () => {
        await post('create', { ch_name: 'Alice', description: 'original', file_name: 'Alice' });
        await post('merge-attributes', { avatar: 'Alice.png', data: { description: 'EDITED' } });

        await expect(chunkOnDisk('Alice.png')).rejects.toThrow('PNG metadata does not contain any');

        const response = await post('export', { avatar_url: 'Alice.png', format: 'png' });
        expect(response.status).toBe(200);
        const exported = Buffer.from(await response.arrayBuffer());

        const embedded = JSON.parse(cardParser.read(exported));
        expect(embedded.data.description).toBe('EDITED');
    });

    test('exporting does not mutate the stored file', async () => {
        await post('create', { ch_name: 'Alice', description: 'original', file_name: 'Alice' });
        await post('merge-attributes', { avatar: 'Alice.png', data: { description: 'EDITED' } });
        const before = await fileStamp('Alice.png');

        await post('export', { avatar_url: 'Alice.png', format: 'png' });
        await post('export', { avatar_url: 'Alice.png', format: 'png' });

        expect(await fileStamp('Alice.png')).toEqual(before);
        expect(await cardJsonOf('Alice.png')).not.toBeNull();
    });

    test('JSON export uses the edited content too', async () => {
        await post('create', { ch_name: 'Alice', description: 'original', file_name: 'Alice' });
        await post('merge-attributes', { avatar: 'Alice.png', data: { description: 'EDITED' } });

        const response = await post('export', { avatar_url: 'Alice.png', format: 'json' });
        expect(response.status).toBe(200);
        expect((await response.json()).data.description).toBe('EDITED');
    });
});

describe('duplicate copies the current content', () => {
    test('the duplicate is image-only and its row holds the edited content', async () => {
        await post('create', { ch_name: 'Alice', description: 'original', file_name: 'Alice' });
        await post('merge-attributes', { avatar: 'Alice.png', data: { description: 'EDITED' } });

        const response = await post('duplicate', { avatar_url: 'Alice.png' });
        expect(response.status).toBe(200);
        const newAvatar = (await response.json()).path;

        await expect(chunkOnDisk(newAvatar)).rejects.toThrow('PNG metadata does not contain any');
        expect(JSON.parse(await cardJsonOf(newAvatar)).data.description).toBe('EDITED');
    });
});

describe('an image write keeps the stored card set', () => {
    test('the stored card is the content writeCard() was given', async () => {
        await post('create', { ch_name: 'Alice', description: 'original', file_name: 'Alice' });
        await post('merge-attributes', { avatar: 'Alice.png', data: { description: 'EDITED' } });

        const cardJson = await cardJsonOf('Alice.png');
        await user.store.lib.writeCard(directories, 'Alice.png', /** @type {string} */ (cardJson));

        expect(await cardJsonOf('Alice.png')).toBe(cardJson);
    });
});

describe('greeting operations read and write the same place', () => {
    test('add -> edit -> delete chains through returned hashes without a 409', async () => {
        await post('create', { ch_name: 'Alice', description: 'd', first_mes: 'hello', file_name: 'Alice' });

        const add = await post('greetings/add', { avatar_url: 'Alice.png', position: 1, expected_length: 1, text: 'second' });
        expect(add.status).toBe(200);
        const addBody = await add.json();
        expect(addBody.hashes).toHaveLength(2);

        const edited = await post('greetings/edit', { avatar_url: 'Alice.png', position: 1, expected_hash: addBody.hashes[1], text: 'second-edited' });
        expect(edited.status).toBe(200);
        const editedBody = await edited.json();

        const deleted = await post('greetings/delete', { avatar_url: 'Alice.png', position: 1, expected_hash: editedBody.hashes[1] });
        expect(deleted.status).toBe(200);
        expect((await deleted.json()).hashes).toHaveLength(1);
    });

    test('a greeting op parks its result and leaves the PNG alone', async () => {
        await post('create', { ch_name: 'Alice', description: 'd', first_mes: 'hello', file_name: 'Alice' });
        const before = await fileStamp('Alice.png');

        expect((await post('greetings/add', { avatar_url: 'Alice.png', position: 1, expected_length: 1, text: 'second' })).status).toBe(200);

        expect(await fileStamp('Alice.png')).toEqual(before);
        await expect(chunkOnDisk('Alice.png')).rejects.toThrow('PNG metadata does not contain any');
        expect(JSON.parse(await cardJsonOf('Alice.png')).data.alternate_greetings).toEqual(['second']);
    });

    test('a greeting added through the op shows up in /get and in an export', async () => {
        await post('create', { ch_name: 'Alice', description: 'd', first_mes: 'hello', file_name: 'Alice' });
        await post('greetings/add', { avatar_url: 'Alice.png', position: 1, expected_length: 1, text: 'second' });

        const got = await (await post('get', { avatar_url: 'Alice.png' })).json();
        expect(got.data.alternate_greetings).toEqual(['second']);

        const exported = await post('export', { avatar_url: 'Alice.png', format: 'png' });
        const embedded = JSON.parse(cardParser.read(Buffer.from(await exported.arrayBuffer())));
        expect(embedded.data.alternate_greetings).toEqual(['second']);
    });
});

describe('add is conflict-checked too', () => {
    const storedCard = async () => JSON.parse(await cardJsonOf('Alice.png'));

    test('add with the current length appends', async () => {
        await post('create', { ch_name: 'Alice', description: 'd', first_mes: 'hello', file_name: 'Alice' });

        const add = await post('greetings/add', { avatar_url: 'Alice.png', position: 1, expected_length: 1, text: 'second' });
        expect(add.status).toBe(200);
        expect((await add.json()).hashes).toHaveLength(2);
        expect((await storedCard()).data.alternate_greetings).toEqual(['second']);
    });

    test('add with a stale length is a 409 and leaves the card unchanged', async () => {
        await post('create', { ch_name: 'Alice', description: 'd', first_mes: 'hello', file_name: 'Alice' });
        await post('greetings/add', { avatar_url: 'Alice.png', position: 1, expected_length: 1, text: 'second' });
        const before = await storedCard();

        const add = await post('greetings/add', { avatar_url: 'Alice.png', position: 1, expected_length: 1, text: 'third' });
        expect(add.status).toBe(409);
        expect(await storedCard()).toEqual(before);
    });

    test('add without expected_length is a 400', async () => {
        await post('create', { ch_name: 'Alice', description: 'd', first_mes: 'hello', file_name: 'Alice' });

        const add = await post('greetings/add', { avatar_url: 'Alice.png', position: 1, text: 'second' });
        expect(add.status).toBe(400);
        expect((await add.json()).reason).toBe('expected_length is required');
    });
});

describe('delete and set default find a greeting that moved by its hash, and answer with the positions they used', () => {
    const storedCard = async () => JSON.parse(await cardJsonOf('Alice.png'));

    async function aliceWithThreeGreetings() {
        await post('create', { ch_name: 'Alice', description: 'd', first_mes: 'hello', file_name: 'Alice' });
        await post('greetings/add', { avatar_url: 'Alice.png', position: 1, expected_length: 1, text: 'second' });
        const add = await post('greetings/add', { avatar_url: 'Alice.png', position: 2, expected_length: 2, text: 'third' });
        return (await add.json()).hashes;
    }

    test('delete at a stale position deletes the greeting with the hash and answers with its position', async () => {
        const hashes = await aliceWithThreeGreetings();

        const deleted = await post('greetings/delete', { avatar_url: 'Alice.png', position: 1, expected_hash: hashes[2] });
        expect(deleted.status).toBe(200);
        expect(await deleted.json()).toEqual({ ok: true, greetings: ['hello', 'second'], hashes: [hashes[0], hashes[1]], default_position: 0, position: 2 });
        expect((await storedCard()).data.alternate_greetings).toEqual(['second']);
    });

    test('set default at a stale position makes the greeting with the hash the default and answers with its position', async () => {
        const hashes = await aliceWithThreeGreetings();

        const set = await post('greetings/default/set', { avatar_url: 'Alice.png', position: 1, expected_hash: hashes[2] });
        expect(set.status).toBe(200);
        expect(await set.json()).toEqual({ ok: true, greetings: ['hello', 'second', 'third'], hashes, default_position: 2, position: 2 });
        expect((await storedCard()).first_mes).toBe('third');
    });

    test('a hash more than one greeting has is a 409 and leaves the card unchanged', async () => {
        await post('create', { ch_name: 'Alice', description: 'd', first_mes: 'hello', file_name: 'Alice' });
        await post('greetings/add', { avatar_url: 'Alice.png', position: 1, expected_length: 1, text: 'twin' });
        const add = await post('greetings/add', { avatar_url: 'Alice.png', position: 2, expected_length: 2, text: 'twin' });
        const hashes = (await add.json()).hashes;
        const before = await storedCard();

        const deleted = await post('greetings/delete', { avatar_url: 'Alice.png', position: 0, expected_hash: hashes[1] });
        expect(deleted.status).toBe(409);
        const set = await post('greetings/default/set', { avatar_url: 'Alice.png', position: 0, expected_hash: hashes[1] });
        expect(set.status).toBe(409);
        expect(await storedCard()).toEqual(before);
    });
});

describe('/greetings/add with append appends without a length check', () => {
    const storedCard = async () => JSON.parse(await cardJsonOf('Alice.png'));

    test('it lands after the last greeting whatever the length, and answers with its position', async () => {
        await post('create', { ch_name: 'Alice', description: 'd', first_mes: 'hello', file_name: 'Alice' });
        await post('greetings/add', { avatar_url: 'Alice.png', position: 1, expected_length: 1, text: 'second' });

        const appended = await post('greetings/add', { avatar_url: 'Alice.png', append: true, text: 'third' });
        expect(appended.status).toBe(200);
        const body = await appended.json();
        expect(body.greetings).toEqual(['hello', 'second', 'third']);
        expect(body.position).toBe(2);
        expect((await storedCard()).data.alternate_greetings).toEqual(['second', 'third']);
    });

    test('append with a position or expected_length is a 400 and leaves the card unchanged', async () => {
        await post('create', { ch_name: 'Alice', description: 'd', first_mes: 'hello', file_name: 'Alice' });
        const before = await storedCard();

        const withPosition = await post('greetings/add', { avatar_url: 'Alice.png', append: true, position: 0, text: 'x' });
        expect(withPosition.status).toBe(400);
        expect((await withPosition.json()).reason).toBe('append takes no position or expected_length');
        const withLength = await post('greetings/add', { avatar_url: 'Alice.png', append: true, expected_length: 1, text: 'x' });
        expect(withLength.status).toBe(400);
        expect(await storedCard()).toEqual(before);
    });

    test('append with empty text is refused', async () => {
        await post('create', { ch_name: 'Alice', description: 'd', first_mes: 'hello', file_name: 'Alice' });
        const appended = await post('greetings/add', { avatar_url: 'Alice.png', append: true, text: '' });
        expect(appended.status).toBe(400);
        expect((await appended.json()).reason).toBe('refused to add empty greeting text');
    });
});

describe('an op whose outcome is already in place answers 200 and writes nothing', () => {
    test('set default on text whose copies are ambiguous, when the default is one of them', async () => {
        await post('create', { ch_name: 'Alice', description: 'd', first_mes: 'twin', file_name: 'Alice' });
        await post('greetings/add', { avatar_url: 'Alice.png', position: 1, expected_length: 1, text: 'other' });
        const add = await post('greetings/add', { avatar_url: 'Alice.png', position: 2, expected_length: 2, text: 'twin' });
        const hashes = (await add.json()).hashes;
        const seqBefore = await changeSeq();

        const set = await post('greetings/default/set', { avatar_url: 'Alice.png', position: 1, expected_hash: hashes[0] });
        expect(set.status).toBe(200);
        const body = await set.json();
        expect(body.default_position).toBe(0);
        expect(body.position).toBe(0);
        expect(await changeSeq()).toBe(seqBefore);
    });

    test('edit when the greeting at the position already has the new text', async () => {
        await post('create', { ch_name: 'Alice', description: 'd', first_mes: 'hello', file_name: 'Alice' });
        const add = await post('greetings/add', { avatar_url: 'Alice.png', position: 1, expected_length: 1, text: 'second' });
        const hashes = (await add.json()).hashes;
        await post('greetings/edit', { avatar_url: 'Alice.png', position: 1, expected_hash: hashes[1], text: 'second-edited' });
        const seqBefore = await changeSeq();

        const again = await post('greetings/edit', { avatar_url: 'Alice.png', position: 1, expected_hash: hashes[1], text: 'second-edited' });
        expect(again.status).toBe(200);
        const body = await again.json();
        expect(body.position).toBe(1);
        expect(body.greetings).toEqual(['hello', 'second-edited']);
        expect(await changeSeq()).toBe(seqBefore);
    });
});

describe('every greeting op answers with the greeting list as stored', () => {
    test('add, edit, set default and delete each return the list after the op, other writers\' changes included', async () => {
        await post('create', { ch_name: 'Alice', description: 'd', first_mes: 'hello', file_name: 'Alice' });
        const body = async (response) => {
            expect(response.status).toBe(200);
            return response.json();
        };

        const add = await body(await post('greetings/add', { avatar_url: 'Alice.png', position: 1, expected_length: 1, text: 'second' }));
        expect(add.greetings).toEqual(['hello', 'second']);
        await body(await post('greetings/add', { avatar_url: 'Alice.png', position: 2, expected_length: 2, text: 'third' }));

        const edit = await body(await post('greetings/edit', { avatar_url: 'Alice.png', position: 1, expected_hash: add.hashes[1], text: 'second-edited' }));
        expect(edit.greetings).toEqual(['hello', 'second-edited', 'third']);
        expect(edit.hashes).toHaveLength(3);

        const set = await body(await post('greetings/default/set', { avatar_url: 'Alice.png', position: 2, expected_hash: edit.hashes[2] }));
        expect(set.greetings).toEqual(['hello', 'second-edited', 'third']);

        const deleted = await body(await post('greetings/delete', { avatar_url: 'Alice.png', position: 0, expected_hash: set.hashes[0] }));
        expect(deleted.greetings).toEqual(['second-edited', 'third']);
    });
});

describe('a character whose PNG is missing', () => {
    test('/batch still returns it from the stored card, never reading the PNG', async () => {
        await post('create', { ch_name: 'Alice', description: 'from-db', file_name: 'Alice' });
        fs.rmSync(/** @type {string} */ (await imageFile('Alice.png')), { force: true });

        const batch = await (await post('batch', { avatars: ['Alice.png'] })).json();
        expect(batch).toHaveLength(1);
        expect(batch[0].data.description).toBe('from-db');
    });

});

describe('/batch reads the stored rows', () => {
    test('returns the db\'s content for an edited character and the file\'s for an untouched one', async () => {
        await post('create', { ch_name: 'Alice', description: 'a', file_name: 'Alice' });
        await post('create', { ch_name: 'Bob', description: 'b', file_name: 'Bob' });
        await post('merge-attributes', { avatar: 'Alice.png', data: { description: 'a2' } });

        const all = await (await post('batch', { avatars: ['Alice.png', 'Bob.png'] })).json();
        const byAvatar = Object.fromEntries(all.map(c => [c.avatar, c]));
        expect(Object.keys(byAvatar).sort()).toEqual(['Alice.png', 'Bob.png']);
        expect(byAvatar['Alice.png'].data.description).toBe('a2');
        expect(byAvatar['Bob.png'].data.description).toBe('b');
    });
});
