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

/**
 * Populates the metadata store's indexed `world` column from whatever character PNGs are currently on
 * disk (mirrors what bootstrapIfNeeded() does for real at boot) - findCandidates()/run() read candidates
 * exclusively through that index now (getCharactersWithLinkedWorld()), never by walking the characters
 * directory themselves, so every test has to seed the index the same way a real install's boot would
 * before the migration can see anything.
 */
async function indexCharacters() {
    await metadataDb.bootstrapIfNeeded(directories);
}

const noLog = { log: () => {} };

describe('unimport-embedded-lore - detection', () => {
    test('a world with no originalData marker (manually created/linked) is never touched', async () => {
        const book = makeBook();
        writeWorldFile('SharedWorld', { entries: {} }); // no originalData - a real hand-made/linked world
        await writeCardFile('Alice.png', { data: { extensions: { world: 'SharedWorld' }, character_book: book } });
        await indexCharacters();

        const { safe, ambiguous } = await migration.findCandidates(directories, noLog.log);
        expect(safe).toEqual([]);
        expect(ambiguous).toEqual([]);
    });

    test('an auto-imported world whose content still matches the embedded book is unlink-only', async () => {
        const book = makeBook();
        writeWorldFile("Alice's Lorebook", autoImportedWorldFile(book));
        await writeCardFile('Alice.png', { data: { extensions: { world: "Alice's Lorebook" }, character_book: book } });
        await indexCharacters();

        const { safe, ambiguous } = await migration.findCandidates(directories, noLog.log);
        expect(ambiguous).toEqual([]);
        expect(safe).toEqual([{ avatar: 'Alice.png', worldName: "Alice's Lorebook", action: 'unlink-only' }]);
    });

    test('a character with no embedded book left (destroyed by the old delete-on-unlink bug) gets restore-and-unlink', async () => {
        const book = makeBook();
        writeWorldFile("Bob's Lorebook", autoImportedWorldFile(book));
        await writeCardFile('Bob.png', { data: { extensions: { world: "Bob's Lorebook" } } }); // no character_book at all
        await indexCharacters();

        const { safe, ambiguous } = await migration.findCandidates(directories, noLog.log);
        expect(ambiguous).toEqual([]);
        expect(safe).toEqual([{ avatar: 'Bob.png', worldName: "Bob's Lorebook", action: 'restore-and-unlink' }]);
    });

    test('a character whose embedded book has diverged from the imported World is left ambiguous, not guessed', async () => {
        const importedBook = makeBook('original content');
        const editedBook = makeBook('this got edited after import');
        writeWorldFile("Carol's Lorebook", autoImportedWorldFile(importedBook));
        await writeCardFile('Carol.png', { data: { extensions: { world: "Carol's Lorebook" }, character_book: editedBook } });
        await indexCharacters();

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
        await indexCharacters();

        const { safe, ambiguous } = await migration.findCandidates(directories, noLog.log);
        expect(safe).toEqual([]);
        expect(ambiguous.map(a => a.avatar).sort()).toEqual(['Dave.png', 'Eve.png']);
    });

    test('a character with no linked world at all is simply ignored', async () => {
        await writeCardFile('Frank.png');
        await indexCharacters();

        const { safe, ambiguous } = await migration.findCandidates(directories, noLog.log);
        expect(safe).toEqual([]);
        expect(ambiguous).toEqual([]);
    });

    test('a huge number of un-linked characters never gets read off disk - only the indexed candidate does', async () => {
        // Stand-in for "999,999,950+ characters that don't have a linked world at all": these are indexed
        // (so getCharactersWithLinkedWorld()'s WHERE excludes them) but their PNGs are deleted right after -
        // if findCandidates() ever tried to open one of them, this test would fail on a missing file, not
        // just on a wrong count.
        for (let i = 0; i < 25; i++) {
            await writeCardFile(`NoWorld${i}.png`);
        }
        const book = makeBook();
        writeWorldFile("Alice's Lorebook", autoImportedWorldFile(book));
        await writeCardFile('Alice.png', { data: { extensions: { world: "Alice's Lorebook" }, character_book: book } });
        await indexCharacters();

        for (let i = 0; i < 25; i++) {
            fs.unlinkSync(path.join(charactersDir, `NoWorld${i}.png`));
        }

        const { safe, ambiguous } = await migration.findCandidates(directories, noLog.log);
        expect(ambiguous).toEqual([]);
        expect(safe).toEqual([{ avatar: 'Alice.png', worldName: "Alice's Lorebook", action: 'unlink-only' }]);
    });

});

describe('unimport-embedded-lore - apply', () => {
    test('dry run (default) writes nothing', async () => {
        const book = makeBook();
        writeWorldFile("Alice's Lorebook", autoImportedWorldFile(book));
        await writeCardFile('Alice.png', { data: { extensions: { world: "Alice's Lorebook" }, character_book: book } });
        await indexCharacters();

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
        await indexCharacters();

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
        await indexCharacters();

        const result = await migration.run(directories, { apply: true, log: () => {} });
        expect(result.migrated).toBe(1);

        const card = readCard(path.join(charactersDir, 'Bob.png'));
        expect(card.data.extensions.world).toBeFalsy();
        expect(card.data.character_book.entries[0].content).toBe('the only surviving copy');
    });

    test('running apply twice is a no-op the second time (idempotent by construction at the run() level - the index itself reflects the unlink)', async () => {
        const book = makeBook();
        writeWorldFile("Alice's Lorebook", autoImportedWorldFile(book));
        await writeCardFile('Alice.png', { data: { extensions: { world: "Alice's Lorebook" }, character_book: book } });
        await indexCharacters();

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
        await indexCharacters();

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
        await indexCharacters();

        const result = await migration.run(directories, { apply: true, log: () => {} });
        expect(result.orphanedWorlds).toEqual(["Alice's Lorebook"]);
        expect(fs.existsSync(path.join(worldsDir, "Alice's Lorebook.json"))).toBe(true);
    });
});

describe('unimport-embedded-lore - runOnceAtBoot', () => {
    test('runs and marks complete when bootstrap is already done', async () => {
        const book = makeBook();
        writeWorldFile("Alice's Lorebook", autoImportedWorldFile(book));
        await writeCardFile('Alice.png', { data: { extensions: { world: "Alice's Lorebook" }, character_book: book } });
        await indexCharacters(); // also sets bootstrap_completed

        const result = await migration.runOnceAtBoot(directories, { log: () => {} });
        expect(result.status).toBe('ran');
        expect(result.result.migrated).toBe(1);

        const card = readCard(path.join(charactersDir, 'Alice.png'));
        expect(card.data.extensions.world).toBeFalsy();
    });

    test('a second boot call is a no-op point-lookup, not a re-run', async () => {
        const book = makeBook();
        writeWorldFile("Alice's Lorebook", autoImportedWorldFile(book));
        await writeCardFile('Alice.png', { data: { extensions: { world: "Alice's Lorebook" }, character_book: book } });
        await indexCharacters();

        const first = await migration.runOnceAtBoot(directories, { log: () => {} });
        expect(first.status).toBe('ran');

        // Re-link the character to the same World by hand (simulating something that would otherwise look
        // like a fresh candidate) and re-index it - a real re-run would still find and act on it again if
        // the marker weren't respected.
        await writeCardFile('Alice.png', { data: { extensions: { world: "Alice's Lorebook" }, character_book: book } });
        await indexCharacters();

        const second = await migration.runOnceAtBoot(directories, { log: () => {} });
        expect(second.status).toBe('already-complete');

        const card = readCard(path.join(charactersDir, 'Alice.png'));
        expect(card.data.extensions.world).toBe("Alice's Lorebook"); // untouched by the second call
    });

    test('waits for bootstrap to finish before running, then runs once it does', async () => {
        const book = makeBook();
        writeWorldFile("Alice's Lorebook", autoImportedWorldFile(book));
        await writeCardFile('Alice.png', { data: { extensions: { world: "Alice's Lorebook" }, character_book: book } });
        // Deliberately NOT bootstrapped yet - the metadata store exists (getEntry() will create it) but
        // bootstrap_completed isn't set, so runOnceAtBoot() must poll rather than trust the (empty) index.
        const boot = migration.runOnceAtBoot(directories, { log: () => {}, bootstrapPollIntervalMs: 20 });

        await new Promise(resolve => setTimeout(resolve, 60));
        await indexCharacters(); // completes bootstrap partway through the wait

        const result = await boot;
        expect(result.status).toBe('ran');
        expect(result.result.migrated).toBe(1);
    });

    test('gives up without marking complete if bootstrap never finishes in time', async () => {
        await writeCardFile('Alice.png');
        // Never call indexCharacters() - bootstrap_completed is never set.
        const result = await migration.runOnceAtBoot(directories, { log: () => {}, bootstrapWaitTimeoutMs: 30, bootstrapPollIntervalMs: 10 });
        expect(result.status).toBe('bootstrap-timeout');

        const marked = await metadataDb.isMigrationMarkedComplete(directories, 'unimport_embedded_lore_completed');
        expect(marked).toBe(false);
    });
});
