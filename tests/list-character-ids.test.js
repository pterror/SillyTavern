import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/tools/list-character-ids.js')} */
let listTool;

let tempDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    listTool = await import('../src/tools/list-character-ids.js');
});

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-list-character-ids-test-'));
    const charactersDir = path.join(tempDir, 'characters');
    const chatsDir = path.join(tempDir, 'chats');
    fs.mkdirSync(charactersDir, { recursive: true });
    fs.mkdirSync(chatsDir, { recursive: true });
    directories = { root: tempDir, characters: charactersDir, chats: chatsDir };
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
});

async function seed(avatar, name) {
    await metadataDb.upsertCharacterFromWrite(directories, avatar, JSON.stringify({
        name, data: { name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } },
    }), 1000);
}

describe('listCharacterIds', () => {
    test('yields every character as {id, name}', async () => {
        await seed('11ee9c30-0000-7000-8000-000000000001.png', 'Alice');
        await seed('11ee9c30-0000-7000-8000-000000000002.png', 'Bob');

        const rows = [];
        for await (const row of listTool.listCharacterIds(directories)) {
            rows.push(row);
        }

        expect(rows.length).toBe(2);
        expect(rows).toEqual(expect.arrayContaining([
            { id: '11ee9c30-0000-7000-8000-000000000001.png', name: 'Alice' },
            { id: '11ee9c30-0000-7000-8000-000000000002.png', name: 'Bob' },
        ]));
    });

    test('returns nothing for an empty library, not an error', async () => {
        const rows = [];
        for await (const row of listTool.listCharacterIds(directories)) {
            rows.push(row);
        }
        expect(rows).toEqual([]);
    });

    test('paginates across multiple pages without gaps or duplicates when pageSize is small', async () => {
        for (let i = 0; i < 25; i++) {
            const id = `11ee9c30-0000-7000-8000-${String(i).padStart(12, '0')}.png`;
            await seed(id, `Character ${i}`);
        }

        const rows = [];
        for await (const row of listTool.listCharacterIds(directories, { pageSize: 7 })) {
            rows.push(row);
        }

        expect(rows.length).toBe(25);
        expect(new Set(rows.map(r => r.id)).size).toBe(25);
    });
});
