import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;

let tempDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    metadataDb = await import('../src/character-metadata-db.js');
    cardParser = await import('../src/character-card-parser.js');
});

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-bootstrap-rerun-test-'));
    directories = {
        root: tempDir,
        characters: path.join(tempDir, 'characters'),
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
    };
    for (const dir of [directories.characters, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

/**
 * @param {string} avatar
 * @param {string} description
 */
async function writeCardFile(avatar, description) {
    const baseImage = await fs.promises.readFile(path.join(process.cwd(), '..', 'public', 'img', 'ai4.png'));
    const card = {
        name: avatar.replace('.png', ''),
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: avatar.replace('.png', ''), description, personality: '', scenario: '', first_mes: '', mes_example: '',
            tags: [], creator: '', character_version: '', creator_notes: '', extensions: { world: '' },
        },
    };
    await fs.promises.writeFile(path.join(directories.characters, avatar), cardParser.write(baseImage, JSON.stringify(card)));
    return card;
}

function rawDb() {
    return new Database(path.join(tempDir, 'character-metadata.sqlite'));
}

/** @param {Database.Database} db */
function snapshot(db) {
    return {
        characters: db.prepare('SELECT * FROM characters ORDER BY id').all(),
        characterTags: db.prepare('SELECT character_id, tag_id FROM character_tags ORDER BY character_id, tag_id').all(),
        groups: db.prepare('SELECT * FROM groups ORDER BY id').all(),
        groupTags: db.prepare('SELECT group_id, tag_id FROM group_tags ORDER BY group_id, tag_id').all(),
    };
}

/** @param {Database.Database} db */
function walFrames(db) {
    db.pragma('wal_checkpoint(PASSIVE)');
    return fs.statSync(path.join(tempDir, 'character-metadata.sqlite-wal'), { throwIfNoEntry: false })?.size ?? 0;
}

describe('bootstrap rerun on an existing library', () => {
    test('keeps every card edit, tag assignment and group row, and writes nothing', async () => {
        const avatars = ['Alice.png', 'Bob.png', 'Cara.png'];
        const cards = {};
        for (const avatar of avatars) cards[avatar] = await writeCardFile(avatar, 'as written in the png');
        fs.writeFileSync(path.join(directories.groups, 'g1.json'), JSON.stringify({ id: 'g1', name: 'Group one', members: ['Alice.png'], fav: false }));

        await metadataDb.bootstrapIfNeeded(directories);
        await metadataDb.bootstrapGroupsIfNeeded(directories);

        // The db is the only complete copy: an edit that never reaches the png, and tags that live only in the db.
        const edited = structuredClone(cards['Alice.png']);
        edited.data.description = 'edited after import';
        await metadataDb.upsertCharacterFromWrite(directories, 'Alice.png', JSON.stringify(edited));
        for (const id of ['red', 'blue']) {
            expect((await metadataDb.createTagDefinition(directories, { id, name: id })).refused).toEqual([]);
        }
        for (const avatar of avatars) expect(await metadataDb.assignEntityTag(directories, avatar, 'red')).toBe('ok');
        expect(await metadataDb.assignEntityTag(directories, 'Bob.png', 'blue')).toBe('ok');
        expect(await metadataDb.assignEntityTag(directories, 'g1', 'blue')).toBe('ok');

        const db = rawDb();
        try {
            const before = snapshot(db);
            expect(before.characterTags).toHaveLength(4);
            db.prepare('DELETE FROM meta WHERE key IN (\'bootstrap_completed\', \'groups_bootstrap_completed\')').run();
            const walBefore = walFrames(db);
            const changesBefore = db.prepare('SELECT COUNT(*) AS n FROM changes').get();

            await metadataDb.bootstrapIfNeeded(directories);
            await metadataDb.bootstrapGroupsIfNeeded(directories);

            const after = snapshot(db);
            expect(after).toEqual(before);
            expect(JSON.parse(after.characters.find(r => r.id === 'Alice.png').card_json).data.description).toBe('edited after import');
            expect(db.prepare('SELECT COUNT(*) AS n FROM changes').get()).toEqual(changesBefore);
            // Only the two done markers are written.
            expect(walFrames(db) - walBefore).toBeLessThan(4 * 4096 * 4);
        } finally {
            db.close();
        }
    });

    test('still adds a card file that has no row', async () => {
        await writeCardFile('Alice.png', 'first');
        await metadataDb.bootstrapIfNeeded(directories);
        await writeCardFile('Dana.png', 'new file');

        const db = rawDb();
        try {
            db.prepare('DELETE FROM meta WHERE key = \'bootstrap_completed\'').run();
            await metadataDb.bootstrapIfNeeded(directories);
            expect(db.prepare('SELECT id FROM characters ORDER BY id').all().map(r => r.id)).toEqual(['Alice.png', 'Dana.png']);
        } finally {
            db.close();
        }
    });
});
