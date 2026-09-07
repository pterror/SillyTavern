/**
 * Character data residency (docs/design/character-data-residency-redesign.md).
 *
 * The property under test: a metadata-only edit - description, greetings, a rename, anything that is not
 * image pixels - must NOT rewrite the character's PNG. The new content is parked in the metadata db's
 * `card_json` column and becomes authoritative; the file keeps its old bytes AND its old mtime, which is what
 * stops the watcher and reconciler from reading the edit as external drift and rolling it back.
 *
 * The hard requirement it must not break: anything handed to a user as a standalone file (export, duplicate)
 * still carries a CURRENT embedded chunk, because that is all other tools can read.
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

        // A freshly created card was genuinely written to disk, so nothing should be parked yet.
        expect(await metadataDb.getCharacterCardJson(directories, 'Alice.png')).toBeNull();
        const before = fileStamp('Alice.png');

        expect((await post('edit', { avatar_url: 'Alice.png', ch_name: 'Alice', description: 'EDITED' })).status).toBe(200);

        // The file did not move at all - not its bytes, not its mtime. The mtime matters as much as the bytes:
        // the watcher treats a changed mtime as external drift and would re-derive the row from the stale chunk.
        expect(fileStamp('Alice.png')).toEqual(before);

        // The PNG still holds the pre-edit text...
        expect((await chunkOnDisk('Alice.png')).data.description).toBe('original');
        // ...and the db holds the real one.
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

        // Precondition: the stored file really is stale, so this test can't pass vacuously.
        expect((await chunkOnDisk('Alice.png')).data.description).toBe('original');

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

describe('duplicate produces a genuinely self-contained copy', () => {
    test('the duplicate\'s own PNG carries the edited content, and its row is not left stale', async () => {
        await post('create', { ch_name: 'Alice', description: 'original', file_name: 'Alice' });
        await post('edit', { avatar_url: 'Alice.png', ch_name: 'Alice', description: 'EDITED' });

        const response = await post('duplicate', { avatar_url: 'Alice.png' });
        expect(response.status).toBe(200);
        const newAvatar = (await response.json()).path;

        // A plain byte copy would have carried the SOURCE's stale chunk into the new file.
        expect((await chunkOnDisk(newAvatar)).data.description).toBe('EDITED');
        // And because its file is current, the duplicate starts life with nothing parked.
        expect(await metadataDb.getCharacterCardJson(directories, newAvatar)).toBeNull();
    });
});

describe('a real image write retires the parked copy', () => {
    test('card_json goes back to NULL once the PNG is rewritten with current content', async () => {
        await post('create', { ch_name: 'Alice', description: 'original', file_name: 'Alice' });
        await post('edit', { avatar_url: 'Alice.png', ch_name: 'Alice', description: 'EDITED' });
        expect(await metadataDb.getCharacterCardJson(directories, 'Alice.png')).not.toBeNull();

        // upsertCharacterFromWrite() with pngCardStale defaulting to false is what every image-touching write
        // path does. It must clear the column, not COALESCE around it - otherwise a card would keep serving
        // pre-replacement content forever with no way to retire it.
        const cardJson = await metadataDb.getCharacterCardJson(directories, 'Alice.png');
        const stat = fs.statSync(path.join(directories.characters, 'Alice.png'));
        await metadataDb.upsertCharacterFromWrite(directories, 'Alice.png', cardJson, stat.mtimeMs);

        expect(await metadataDb.getCharacterCardJson(directories, 'Alice.png')).toBeNull();
    });
});

describe('getStaleCardJsonMap', () => {
    test('holds only the cards whose file is actually stale', async () => {
        await post('create', { ch_name: 'Alice', description: 'a', file_name: 'Alice' });
        await post('create', { ch_name: 'Bob', description: 'b', file_name: 'Bob' });

        // Nothing edited yet - a library nobody has touched costs an empty map.
        expect((await metadataDb.getStaleCardJsonMap(directories)).size).toBe(0);

        await post('edit', { avatar_url: 'Alice.png', ch_name: 'Alice', description: 'a2' });

        const map = await metadataDb.getStaleCardJsonMap(directories);
        expect([...map.keys()]).toEqual(['Alice.png']);
        expect(JSON.parse(map.get('Alice.png')).data.description).toBe('a2');
    });
});
