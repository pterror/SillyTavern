import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {typeof import('../src/migrations/unimport-embedded-lore.js')} */
let migration;

let tempDir;
let charactersDir;
let worldsDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    cardParser = await import('../src/character-card-parser.js');
    migration = await import('../src/migrations/unimport-embedded-lore.js');
});

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-unimport-embedded-lore-test-'));
    charactersDir = path.join(tempDir, 'characters');
    worldsDir = path.join(tempDir, 'worlds');
    fs.mkdirSync(charactersDir, { recursive: true });
    fs.mkdirSync(worldsDir, { recursive: true });
    directories = { root: tempDir, characters: charactersDir, worlds: worldsDir, chats: path.join(tempDir, 'chats'), groups: path.join(tempDir, 'groups') };
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
});

/** A minimal but real v2 character_book, shared by tests. */
function makeBook(content = 'Some lore about the character.') {
    return {
        name: "Test's Lorebook",
        entries: [
            { id: 0, keys: ['test'], secondary_keys: [], comment: '', content, constant: false, selective: false, insertion_order: 100, enabled: true, position: 'after_char', extensions: {} },
        ],
    };
}

/** Writes a real, parseable character PNG - mirrors migrate-character-ids.test.js's writeCardFile(). */
async function writeCardFile(avatar, overrides = {}) {
    const baseImage = await fs.promises.readFile(path.join(process.cwd(), '..', 'public', 'img', 'ai4.png'));
    const name = avatar.replace(/\.png$/, '');
    const card = {
        name,
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name,
            description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
            tags: [], creator: '', character_version: '', creator_notes: '',
            extensions: { fav: false, world: '' },
        },
        ...overrides,
    };
    const buffer = cardParser.write(baseImage, JSON.stringify(card));
    await fs.promises.writeFile(path.join(charactersDir, avatar), buffer);
}

function readCard(avatarPath) {
    const buffer = fs.readFileSync(avatarPath);
    return JSON.parse(cardParser.read(buffer));
}

function writeWorldFile(name, data) {
    fs.writeFileSync(path.join(worldsDir, `${name}.json`), JSON.stringify(data));
}

/** What convertCharacterBook()+saveWorldInfo() actually produce and persist for a given character_book. */
function autoImportedWorldFile(characterBook) {
    const entries = {};
    characterBook.entries.forEach((entry, i) => {
        entries[entry.id ?? i] = { uid: entry.id ?? i, key: entry.keys, content: entry.content, disable: !entry.enabled };
    });
    return { entries, originalData: characterBook };
}

const noLog = { log: () => {} };

describe('unimport-embedded-lore - detection', () => {
    test('a world with no originalData marker (manually created/linked) is never touched', async () => {
        const book = makeBook();
        writeWorldFile('SharedWorld', { entries: {} }); // no originalData - a real hand-made/linked world
        await writeCardFile('Alice.png', { data: { extensions: { world: 'SharedWorld' }, character_book: book } });

        const { safe, ambiguous } = await migration.findCandidates(directories, noLog.log);
        expect(safe).toEqual([]);
        expect(ambiguous).toEqual([]);
    });

    test('an auto-imported world whose content still matches the embedded book is unlink-only', async () => {
        const book = makeBook();
        writeWorldFile("Alice's Lorebook", autoImportedWorldFile(book));
        await writeCardFile('Alice.png', { data: { extensions: { world: "Alice's Lorebook" }, character_book: book } });

        const { safe, ambiguous } = await migration.findCandidates(directories, noLog.log);
        expect(ambiguous).toEqual([]);
        expect(safe).toEqual([{ avatar: 'Alice.png', worldName: "Alice's Lorebook", action: 'unlink-only' }]);
    });

    test('a character with no embedded book left (destroyed by the old delete-on-unlink bug) gets restore-and-unlink', async () => {
        const book = makeBook();
        writeWorldFile("Bob's Lorebook", autoImportedWorldFile(book));
        await writeCardFile('Bob.png', { data: { extensions: { world: "Bob's Lorebook" } } }); // no character_book at all

        const { safe, ambiguous } = await migration.findCandidates(directories, noLog.log);
        expect(ambiguous).toEqual([]);
        expect(safe).toEqual([{ avatar: 'Bob.png', worldName: "Bob's Lorebook", action: 'restore-and-unlink' }]);
    });

    test('a character whose embedded book has diverged from the imported World is left ambiguous, not guessed', async () => {
        const importedBook = makeBook('original content');
        const editedBook = makeBook('this got edited after import');
        writeWorldFile("Carol's Lorebook", autoImportedWorldFile(importedBook));
        await writeCardFile('Carol.png', { data: { extensions: { world: "Carol's Lorebook" }, character_book: editedBook } });

        const { safe, ambiguous } = await migration.findCandidates(directories, noLog.log);
        expect(safe).toEqual([]);
        expect(ambiguous).toHaveLength(1);
        expect(ambiguous[0].avatar).toBe('Carol.png');
    });

    test('a world shared by two characters is treated as deliberate sharing and left alone for both', async () => {
        const book = makeBook();
        writeWorldFile('SharedLore', autoImportedWorldFile(book));
        await writeCardFile('Dave.png', { data: { extensions: { world: 'SharedLore' }, character_book: book } });
        await writeCardFile('Eve.png', { data: { extensions: { world: 'SharedLore' }, character_book: book } });

        const { safe, ambiguous } = await migration.findCandidates(directories, noLog.log);
        expect(safe).toEqual([]);
        expect(ambiguous.map(a => a.avatar).sort()).toEqual(['Dave.png', 'Eve.png']);
    });

    test('a character with no linked world at all is simply ignored', async () => {
        await writeCardFile('Frank.png');

        const { safe, ambiguous } = await migration.findCandidates(directories, noLog.log);
        expect(safe).toEqual([]);
        expect(ambiguous).toEqual([]);
    });
});

describe('unimport-embedded-lore - apply', () => {
    test('dry run (default) writes nothing', async () => {
        const book = makeBook();
        writeWorldFile("Alice's Lorebook", autoImportedWorldFile(book));
        await writeCardFile('Alice.png', { data: { extensions: { world: "Alice's Lorebook" }, character_book: book } });

        const result = await migration.run(directories, { log: () => {} });
        expect(result.migrated).toBe(0);
        expect(result.safe).toBe(1);

        const card = readCard(path.join(charactersDir, 'Alice.png'));
        expect(card.data.extensions.world).toBe("Alice's Lorebook");
        expect(fs.existsSync(path.join(worldsDir, "Alice's Lorebook.json"))).toBe(true);
    });

    test('apply unlinks a matching character and leaves character_book intact, World file untouched', async () => {
        const book = makeBook();
        writeWorldFile("Alice's Lorebook", autoImportedWorldFile(book));
        await writeCardFile('Alice.png', { data: { extensions: { world: "Alice's Lorebook" }, character_book: book } });

        const result = await migration.run(directories, { apply: true, log: () => {} });
        expect(result.migrated).toBe(1);
        expect(result.failed).toBe(0);

        const card = readCard(path.join(charactersDir, 'Alice.png'));
        expect(card.data.extensions.world).toBeFalsy();
        expect(card.data.character_book.entries[0].content).toBe(book.entries[0].content);
        // World file is left in place, never deleted.
        expect(fs.existsSync(path.join(worldsDir, "Alice's Lorebook.json"))).toBe(true);
    });

    test('apply restores character_book from the World snapshot when the character has none', async () => {
        const book = makeBook('the only surviving copy');
        writeWorldFile("Bob's Lorebook", autoImportedWorldFile(book));
        await writeCardFile('Bob.png', { data: { extensions: { world: "Bob's Lorebook" } } });

        const result = await migration.run(directories, { apply: true, log: () => {} });
        expect(result.migrated).toBe(1);

        const card = readCard(path.join(charactersDir, 'Bob.png'));
        expect(card.data.extensions.world).toBeFalsy();
        expect(card.data.character_book.entries[0].content).toBe('the only surviving copy');
    });

    test('running apply twice is a no-op the second time (idempotent by construction, no marker needed)', async () => {
        const book = makeBook();
        writeWorldFile("Alice's Lorebook", autoImportedWorldFile(book));
        await writeCardFile('Alice.png', { data: { extensions: { world: "Alice's Lorebook" }, character_book: book } });

        const first = await migration.run(directories, { apply: true, log: () => {} });
        expect(first.migrated).toBe(1);

        const second = await migration.run(directories, { apply: true, log: () => {} });
        expect(second.safe).toBe(0);
        expect(second.migrated).toBe(0);
    });

    test('ambiguous candidates are never written even with apply: true', async () => {
        const importedBook = makeBook('original content');
        const editedBook = makeBook('this got edited after import');
        writeWorldFile("Carol's Lorebook", autoImportedWorldFile(importedBook));
        await writeCardFile('Carol.png', { data: { extensions: { world: "Carol's Lorebook" }, character_book: editedBook } });

        const result = await migration.run(directories, { apply: true, log: () => {} });
        expect(result.migrated).toBe(0);
        expect(result.ambiguous).toHaveLength(1);

        const card = readCard(path.join(charactersDir, 'Carol.png'));
        expect(card.data.extensions.world).toBe("Carol's Lorebook");
        expect(card.data.character_book.entries[0].content).toBe('this got edited after import');
    });

    test('reports World files that end up with no remaining linker, without deleting them', async () => {
        const book = makeBook();
        writeWorldFile("Alice's Lorebook", autoImportedWorldFile(book));
        await writeCardFile('Alice.png', { data: { extensions: { world: "Alice's Lorebook" }, character_book: book } });

        const result = await migration.run(directories, { apply: true, log: () => {} });
        expect(result.orphanedWorlds).toEqual(["Alice's Lorebook"]);
        expect(fs.existsSync(path.join(worldsDir, "Alice's Lorebook.json"))).toBe(true);
    });
});
