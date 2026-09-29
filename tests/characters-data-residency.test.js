/**
 * Character data residency (docs/design/character-data-residency-redesign.md).
 *
 * The property under test: a metadata-only edit - description, greetings, a rename, anything that is not
 * image pixels - must NOT rewrite the character's PNG. The new content is parked in the metadata db's
 * `card_json` column and becomes authoritative; the file keeps its old bytes AND its old mtime.
 *
 * The hard requirement it must not break: an export still carries a CURRENT embedded chunk, because that is all
 * other tools can read. A duplicate is a library entry like any other - image-only, its content in its db row.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {import('express').Router} */
let router;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

// writeCharacterData()'s DEFAULT_AVATAR_PATH fallback is repo-root-relative - same chdir as the sibling suites.
const originalCwd = process.cwd();

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    ({ router } = await import('../src/endpoints/characters.js'));
    cardParser = await import('../src/character-card-parser.js');
    metadataDb = await import('../src/character-metadata-db.js');

    process.chdir(path.resolve(originalCwd, '..'));

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: 'test-user' } };
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

beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-residency-test-'));
    const charactersDir = path.join(tempDir, 'characters');
    const chatsDir = path.join(tempDir, 'chats');
    fs.mkdirSync(charactersDir, { recursive: true });
    fs.mkdirSync(chatsDir, { recursive: true });
    directories = { characters: charactersDir, chats: chatsDir, root: tempDir };
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
    fs.rmSync(directories.root, { recursive: true, force: true });
});

const post = (route, body) => fetch(`${baseUrl}/api/characters/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

/** @returns {{ mtimeMs: number, size: number }} */
function fileStamp(avatar) {
    const s = fs.statSync(path.join(directories.characters, avatar));
    return { mtimeMs: s.mtimeMs, size: s.size };
}

/** The card JSON actually embedded in the PNG on disk, ignoring the db entirely. */
async function chunkOnDisk(avatar) {
    return JSON.parse(await cardParser.parse(path.join(directories.characters, avatar), 'png'));
}

describe('metadata-only edits do not touch the PNG', () => {
    test('an /edit that changes only text leaves the file byte-identical and parks the content in the db', async () => {
        expect((await post('create', { ch_name: 'Alice', description: 'original', file_name: 'Alice' })).status).toBe(200);

        expect(JSON.parse(await metadataDb.getCharacterCardJson(directories, 'Alice.png')).data.description).toBe('original');
        const before = fileStamp('Alice.png');

        expect((await post('edit', { avatar_url: 'Alice.png', ch_name: 'Alice', description: 'EDITED' })).status).toBe(200);

        // The file did not move at all - not its bytes, not its mtime.
        expect(fileStamp('Alice.png')).toEqual(before);

        await expect(chunkOnDisk('Alice.png')).rejects.toThrow('PNG metadata does not contain any');
        const parked = await metadataDb.getCharacterCardJson(directories, 'Alice.png');
        expect(parked).not.toBeNull();
        expect(JSON.parse(parked).data.description).toBe('EDITED');
    });

    test('reads come back with the edited content, not the stale chunk', async () => {
        await post('create', { ch_name: 'Alice', description: 'original', file_name: 'Alice' });
        await post('edit', { avatar_url: 'Alice.png', ch_name: 'Alice', description: 'EDITED' });

        const got = await (await post('get', { avatar_url: 'Alice.png' })).json();
        expect(got.data.description).toBe('EDITED');

        const row = await metadataDb.getCharacterMetadataRow(directories, 'Alice.png');
        expect(JSON.parse(row.shallow_json).name).toBe('Alice');
    });

    test('/batch resolves parked content for multiple characters in one request', async () => {
        // /batch is the route fetchCharactersDelta() (script.js) calls to catch up on changed characters - it
        // has its own getCharacterIndexRowsByIds() prefetch (mirroring /all's per-batch one), so this exercises that it still
        // resolves each avatar's parked content correctly when several ids in the same request are stale.
        await post('create', { ch_name: 'Alice', description: 'original', file_name: 'Alice' });
        await post('create', { ch_name: 'Bob', description: 'original', file_name: 'Bob' });
        await post('edit', { avatar_url: 'Alice.png', ch_name: 'Alice', description: 'EDITED-ALICE' });
        await post('edit', { avatar_url: 'Bob.png', ch_name: 'Bob', description: 'EDITED-BOB' });

        const batch = await (await post('batch', { avatars: ['Alice.png', 'Bob.png'] })).json();
        const byAvatar = Object.fromEntries(batch.map(c => [c.avatar, c]));
        expect(byAvatar['Alice.png'].data.description).toBe('EDITED-ALICE');
        expect(byAvatar['Bob.png'].data.description).toBe('EDITED-BOB');
    });

    test('successive edits keep replacing the parked copy', async () => {
        await post('create', { ch_name: 'Alice', description: 'v1', file_name: 'Alice' });
        const before = fileStamp('Alice.png');

        await post('edit', { avatar_url: 'Alice.png', ch_name: 'Alice', description: 'v2' });
        await post('edit', { avatar_url: 'Alice.png', ch_name: 'Alice', description: 'v3' });

        expect(fileStamp('Alice.png')).toEqual(before);
        const parked = JSON.parse(await metadataDb.getCharacterCardJson(directories, 'Alice.png'));
        expect(parked.data.description).toBe('v3');
    });

    test('a rename is a metadata-only edit too', async () => {
        await post('create', { ch_name: 'Alice', description: 'desc', file_name: 'Alice' });
        const before = fileStamp('Alice.png');

        expect((await post('rename', { avatar_url: 'Alice.png', new_name: 'Alicia' })).status).toBe(200);

        expect(fileStamp('Alice.png')).toEqual(before);
        expect(JSON.parse(await metadataDb.getCharacterCardJson(directories, 'Alice.png')).name).toBe('Alicia');
        const row = await metadataDb.getCharacterMetadataRow(directories, 'Alice.png');
        expect(row.name).toBe('Alicia');
    });
});

describe('export still hands out a self-contained, current card', () => {
    test('PNG export carries the edited content even though the stored file does not', async () => {
        await post('create', { ch_name: 'Alice', description: 'original', file_name: 'Alice' });
        await post('edit', { avatar_url: 'Alice.png', ch_name: 'Alice', description: 'EDITED' });

        // Precondition: the stored file carries no character data at all (image-only since creation - see
        // writeCharacterData()'s imageOnly write path), so this test can't pass vacuously by reading it.
        await expect(chunkOnDisk('Alice.png')).rejects.toThrow('PNG metadata does not contain any');

        const response = await post('export', { avatar_url: 'Alice.png', format: 'png' });
        expect(response.status).toBe(200);
        const exported = Buffer.from(await response.arrayBuffer());

        const embedded = JSON.parse(cardParser.read(exported));
        expect(embedded.data.description).toBe('EDITED');
    });

    test('exporting does not mutate the stored file', async () => {
        await post('create', { ch_name: 'Alice', description: 'original', file_name: 'Alice' });
        await post('edit', { avatar_url: 'Alice.png', ch_name: 'Alice', description: 'EDITED' });
        const before = fileStamp('Alice.png');

        await post('export', { avatar_url: 'Alice.png', format: 'png' });
        await post('export', { avatar_url: 'Alice.png', format: 'png' });

        // Export is a read-shaped action a user can trigger in bulk; it must not write to the library.
        expect(fileStamp('Alice.png')).toEqual(before);
        expect(await metadataDb.getCharacterCardJson(directories, 'Alice.png')).not.toBeNull();
    });

    test('JSON export uses the edited content too', async () => {
        await post('create', { ch_name: 'Alice', description: 'original', file_name: 'Alice' });
        await post('edit', { avatar_url: 'Alice.png', ch_name: 'Alice', description: 'EDITED' });

        const response = await post('export', { avatar_url: 'Alice.png', format: 'json' });
        expect(response.status).toBe(200);
        expect((await response.json()).data.description).toBe('EDITED');
    });
});

describe('duplicate copies the current content', () => {
    test('the duplicate is image-only and its row holds the edited content', async () => {
        await post('create', { ch_name: 'Alice', description: 'original', file_name: 'Alice' });
        await post('edit', { avatar_url: 'Alice.png', ch_name: 'Alice', description: 'EDITED' });

        const response = await post('duplicate', { avatar_url: 'Alice.png' });
        expect(response.status).toBe(200);
        const newAvatar = (await response.json()).path;

        await expect(chunkOnDisk(newAvatar)).rejects.toThrow('PNG metadata does not contain any');
        expect(JSON.parse(await metadataDb.getCharacterCardJson(directories, newAvatar)).data.description).toBe('EDITED');
    });
});

describe('an image write keeps card_json set', () => {
    test('card_json equals the content upsertCharacterFromWrite() was given', async () => {
        await post('create', { ch_name: 'Alice', description: 'original', file_name: 'Alice' });
        await post('edit', { avatar_url: 'Alice.png', ch_name: 'Alice', description: 'EDITED' });

        const cardJson = await metadataDb.getCharacterCardJson(directories, 'Alice.png');
        await metadataDb.upsertCharacterFromWrite(directories, 'Alice.png', cardJson);

        expect(await metadataDb.getCharacterCardJson(directories, 'Alice.png')).toBe(cardJson);
    });
});

describe('greeting operations read and write the same place', () => {
    // These ops carry a precondition hash over the text the caller believes is at a position, and refuse with
    // 409 on a mismatch. That makes them the sharpest possible detector of a read/write residency split: if
    // applyGreetingOperation() read through the db seam but its write landed somewhere the next read didn't
    // look, the SECOND op in a chain would fail its precondition every time.
    test('add -> edit -> delete chains through returned hashes without a 409', async () => {
        await post('create', { ch_name: 'Alice', description: 'd', first_mes: 'hello', file_name: 'Alice' });

        const add = await post('greetings/add', { avatar_url: 'Alice.png', position: 1, expected_length: 1, text: 'second' });
        expect(add.status).toBe(200);
        const addBody = await add.json();
        expect(addBody.hashes).toHaveLength(2);

        // The hash this op asserts came from the PREVIOUS op's response, so it only matches if the write
        // actually landed where the next read looks.
        const edited = await post('greetings/edit', { avatar_url: 'Alice.png', position: 1, expected_hash: addBody.hashes[1], text: 'second-edited' });
        expect(edited.status).toBe(200);
        const editedBody = await edited.json();

        const deleted = await post('greetings/delete', { avatar_url: 'Alice.png', position: 1, expected_hash: editedBody.hashes[1] });
        expect(deleted.status).toBe(200);
        expect((await deleted.json()).hashes).toHaveLength(1);
    });

    test('a greeting op parks its result and leaves the PNG alone', async () => {
        await post('create', { ch_name: 'Alice', description: 'd', first_mes: 'hello', file_name: 'Alice' });
        const before = fileStamp('Alice.png');

        expect((await post('greetings/add', { avatar_url: 'Alice.png', position: 1, expected_length: 1, text: 'second' })).status).toBe(200);

        expect(fileStamp('Alice.png')).toEqual(before);
        // Stored file carries no character data at all (image-only since creation), so there's nothing there for
        // the greeting op to have touched - see the create/export test above for the same invariant.
        await expect(chunkOnDisk('Alice.png')).rejects.toThrow('PNG metadata does not contain any');
        expect(JSON.parse(await metadataDb.getCharacterCardJson(directories, 'Alice.png')).data.alternate_greetings).toEqual(['second']);
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

describe('add and unset-default are conflict-checked too', () => {
    const storedCard = async () => JSON.parse(await metadataDb.getCharacterCardJson(directories, 'Alice.png'));

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

    test('unset with the current default position clears the default', async () => {
        await post('create', { ch_name: 'Alice', description: 'd', first_mes: 'hello', file_name: 'Alice' });

        const unset = await post('greetings/default/unset', { avatar_url: 'Alice.png', expected_default_position: 0 });
        expect(unset.status).toBe(200);
        expect((await unset.json()).default_position).toBeNull();
        expect((await storedCard()).first_mes).toBe('');
    });

    test('unset with a stale default position is a 409 and leaves the card unchanged', async () => {
        await post('create', { ch_name: 'Alice', description: 'd', first_mes: 'hello', file_name: 'Alice' });
        await post('greetings/default/unset', { avatar_url: 'Alice.png', expected_default_position: 0 });
        const before = await storedCard();

        const unset = await post('greetings/default/unset', { avatar_url: 'Alice.png', expected_default_position: 0 });
        expect(unset.status).toBe(409);
        expect(await storedCard()).toEqual(before);
    });

    test('unset without expected_default_position is a 400', async () => {
        await post('create', { ch_name: 'Alice', description: 'd', first_mes: 'hello', file_name: 'Alice' });

        const unset = await post('greetings/default/unset', { avatar_url: 'Alice.png' });
        expect(unset.status).toBe(400);
        expect((await unset.json()).reason).toBe('expected_default_position is required (an integer, or null)');
    });
});

describe('/greetings/move places next to a hash-checked target', () => {
    const storedCard = async () => JSON.parse(await metadataDb.getCharacterCardJson(directories, 'Alice.png'));
    const changeSeq = async () => (await metadataDb.getCharacterMetadataRow(directories, 'Alice.png')).change_seq;

    /** Alice with greetings ['hello', 'second', 'third'], 'hello' the default. Resolves to their hashes. */
    async function aliceWithThreeGreetings() {
        await post('create', { ch_name: 'Alice', description: 'd', first_mes: 'hello', file_name: 'Alice' });
        await post('greetings/add', { avatar_url: 'Alice.png', position: 1, expected_length: 1, text: 'second' });
        const add = await post('greetings/add', { avatar_url: 'Alice.png', position: 2, expected_length: 2, text: 'third' });
        return (await add.json()).hashes;
    }

    test('a move lands and returns the new hashes', async () => {
        const hashes = await aliceWithThreeGreetings();

        const moved = await post('greetings/move', {
            avatar_url: 'Alice.png', source_position: 2, expected_hash: hashes[2], side: 'before', target_position: 1, target_expected_hash: hashes[1],
        });
        expect(moved.status).toBe(200);
        const body = await moved.json();
        expect(body.hashes).toEqual([hashes[0], hashes[2], hashes[1]]);
        expect(body.default_position).toBe(0);
        expect((await storedCard()).data.alternate_greetings).toEqual(['third', 'second']);
    });

    test('a stale target_expected_hash is a 409 and leaves the card unchanged', async () => {
        const hashes = await aliceWithThreeGreetings();
        const before = await storedCard();

        const moved = await post('greetings/move', {
            avatar_url: 'Alice.png', source_position: 2, expected_hash: hashes[2], side: 'before', target_position: 1, target_expected_hash: hashes[0],
        });
        expect(moved.status).toBe(409);
        expect((await moved.json()).reason).toBe('target greeting changed since it was loaded');
        expect(await storedCard()).toEqual(before);
    });

    test('a missing target_expected_hash, a bad side and the same position are 400s', async () => {
        const hashes = await aliceWithThreeGreetings();
        const body = { avatar_url: 'Alice.png', source_position: 2, expected_hash: hashes[2], side: 'before', target_position: 1, target_expected_hash: hashes[1] };

        const noTargetHash = await post('greetings/move', { ...body, target_expected_hash: undefined });
        expect(noTargetHash.status).toBe(400);
        expect((await noTargetHash.json()).reason).toBe('target_expected_hash is required');

        const badSide = await post('greetings/move', { ...body, side: 'between' });
        expect(badSide.status).toBe(400);
        expect((await badSide.json()).reason).toBe('side must be "before" or "after"');

        const samePosition = await post('greetings/move', { ...body, target_position: 2, target_expected_hash: hashes[2] });
        expect(samePosition.status).toBe(400);
        expect((await samePosition.json()).reason).toBe('target_position must differ from source_position');
    });

    test('a no-op move returns 200 and writes nothing', async () => {
        const hashes = await aliceWithThreeGreetings();
        const seqBefore = await changeSeq();

        // 'second' already sits right before 'third'.
        const moved = await post('greetings/move', {
            avatar_url: 'Alice.png', source_position: 1, expected_hash: hashes[1], side: 'before', target_position: 2, target_expected_hash: hashes[2],
        });
        expect(moved.status).toBe(200);
        const body = await moved.json();
        expect(body.hashes).toEqual(hashes);
        expect(body.default_position).toBe(0);
        expect(await changeSeq()).toBe(seqBefore);
    });
});

describe('/edit\'s content-hash conflict check survives the residency split', () => {
    // The other 409 in this area: /edit compares client-supplied hashes against freshly computed ones. The
    // client's come from /get (which reads the parked copy and stamps db-authoritative fields); the server's
    // come from its own read. If those two ever resolved content differently, every save after the first
    // would 409.
    test('repeated load-then-save cycles keep matching, including after content is parked', async () => {
        await post('create', { ch_name: 'Alice', description: 'v1', file_name: 'Alice' });

        for (const description of ['v2', 'v3', 'v4']) {
            const got = await (await post('get', { avatar_url: 'Alice.png' })).json();
            const response = await fetch(`${baseUrl}/api/characters/edit`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-content-hashes': JSON.stringify({ fields: got._fieldsHash, body: got._bodyHash }),
                },
                body: JSON.stringify({ avatar_url: 'Alice.png', ch_name: 'Alice', description }),
            });
            expect(response.status).toBe(200);
        }

        expect(JSON.parse(await metadataDb.getCharacterCardJson(directories, 'Alice.png')).data.description).toBe('v4');
    });
});

describe('a character whose PNG is missing', () => {
    test('/batch still returns it from card_json, never reading the PNG', async () => {
        await post('create', { ch_name: 'Alice', description: 'from-db', file_name: 'Alice' });
        fs.rmSync(path.join(directories.characters, 'Alice.png'));

        const batch = await (await post('batch', { avatars: ['Alice.png'] })).json();
        expect(batch).toHaveLength(1);
        expect(batch[0].data.description).toBe('from-db');
    });

    test('/all without search still lists it, from its row', async () => {
        await post('create', { ch_name: 'Alice', description: 'from-db', file_name: 'Alice' });
        await post('create', { ch_name: 'Bob', description: 'b', file_name: 'Bob' });
        fs.rmSync(path.join(directories.characters, 'Alice.png'));

        const all = await (await post('all', {})).json();
        const byAvatar = Object.fromEntries(all.map(c => [c.avatar, c]));
        expect(Object.keys(byAvatar).sort()).toEqual(['Alice.png', 'Bob.png']);
        expect(byAvatar['Alice.png'].data.description).toBe('from-db');
    });
});

describe('/all without search streams the characters rows', () => {
    test('returns the db\'s content for an edited character and the file\'s for an untouched one', async () => {
        await post('create', { ch_name: 'Alice', description: 'a', file_name: 'Alice' });
        await post('create', { ch_name: 'Bob', description: 'b', file_name: 'Bob' });
        await post('edit', { avatar_url: 'Alice.png', ch_name: 'Alice', description: 'a2' });

        const all = await (await post('all', {})).json();
        const byAvatar = Object.fromEntries(all.map(c => [c.avatar, c]));
        expect(Object.keys(byAvatar).sort()).toEqual(['Alice.png', 'Bob.png']);
        expect(byAvatar['Alice.png'].data.description).toBe('a2');
        expect(byAvatar['Bob.png'].data.description).toBe('b');
    });
});
