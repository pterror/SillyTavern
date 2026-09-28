import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import Database from 'better-sqlite3';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {typeof import('../src/migrations/unimport-embedded-lore.js')} */
let migration;
/** @type {typeof import('../src/migrations/migration-notices.js')} */
let notices;

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
    notices = await import('../src/migrations/migration-notices.js');
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
        name: 'Test\'s Lorebook',
        entries: [
            { id: 0, keys: ['test'], secondary_keys: [], comment: '', content, constant: false, selective: false, insertion_order: 100, enabled: true, position: 'after_char', extensions: {} },
        ],
    };
}

/** Writes a real, parseable character PNG - mirrors migrate-character-ids.test.js's writeCardFile(). */
async function writeCardFile(avatar, overrides = {}) {
    const baseImage = await fs.promises.readFile(path.join(process.cwd(), '..', 'public', 'img', 'ai4.png'));
    const buffer = cardParser.write(baseImage, JSON.stringify(makeCard(avatar, overrides)));
    await fs.promises.writeFile(path.join(charactersDir, avatar), buffer);
}

function makeCard(avatar, overrides = {}) {
    const name = avatar.replace(/\.png$/, '');
    return {
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
}

async function readDbCard(avatar) {
    return JSON.parse(await metadataDb.getCharacterCardJson(directories, avatar));
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
 * exclusively through that index now (streamLinkedWorlds()), never by walking the characters
 * directory themselves, so every test has to seed the index the same way a real install's boot would
 * before the migration can see anything.
 */
async function indexCharacters() {
    await metadataDb.bootstrapIfNeeded(directories);
}

const NOTICE_ID = 'unimport-embedded-lore';
const COMPLETED_KEY = 'unimport_embedded_lore_completed';
const PASS_COMPLETED_KEY = 'unimport_embedded_lore_pass_completed';
const SKIPPED_REPORTED_KEY = 'unimport_embedded_lore_skipped_reported';

/** The write every indexed card takes (each one is parked in the metadata store). */
const realWrite = (dirs, avatar, updated) => metadataDb.upsertCharacterFromWrite(dirs, avatar, updated, null, null);
/** A card write that fails for `name` only. */
const failFor = (name) => async (dirs, avatar, updated, parked) => {
    if (avatar === name) throw new Error('disk full');
    return realWrite(dirs, avatar, updated);
};

/** @param {string} key */
async function isMarked(key) {
    return metadataDb.isMigrationMarkedComplete(directories, key);
}

/** Every pending row of this migration, gathered - only ever a test's handful. */
async function pendingRows() {
    const rows = [];
    for await (const page of await metadataDb.streamMigrationPending(directories, NOTICE_ID)) {
        rows.push(...page);
    }
    return rows;
}

describe('unimport-embedded-lore - skipped cards', () => {
    test('a card linked to a lorebook with no file is listed as skipped, on the console and in the notice, and the migration finishes', async () => {
        await writeCardFile('Ghost.png', { data: { extensions: { world: 'Missing Lore' } } });
        await indexCharacters();

        const lines = [];
        const boot = await migration.runOnceAtBoot(directories, { log: line => lines.push(line) });
        expect(boot.status).toBe('ran');
        expect(boot.result).toMatchObject({ skipped: 1, failed: 0, migrated: 0 });
        expect(lines).toContainEqual(expect.stringContaining('SKIPPED, not touched: Ghost.png (linked to "Missing Lore") - its World file doesn\'t exist'));
        expect(await notices.readNotice(directories, NOTICE_ID)).toMatchObject({
            skipped: { total: 1, entries: [{ avatar: 'Ghost.png', world: 'Missing Lore', reason: 'world-missing' }] },
            failing: { total: 0, entries: [] },
        });
        expect(await isMarked(COMPLETED_KEY)).toBe(true);
        expect((await readDbCard('Ghost.png')).data.extensions.world).toBe('Missing Lore');
    });

    test('a World file that does not parse lists its linkers as world-unreadable', async () => {
        fs.writeFileSync(path.join(worldsDir, 'Broken.json'), '{not json');
        await writeCardFile('Broken.png', { data: { extensions: { world: 'Broken' } } });
        await indexCharacters();

        const lines = [];
        await migration.runOnceAtBoot(directories, { log: line => lines.push(line) });
        const notice = await notices.readNotice(directories, NOTICE_ID);
        expect(notice.skipped.entries).toEqual([{ avatar: 'Broken.png', world: 'Broken', reason: 'world-unreadable' }]);
        expect(lines).toContainEqual(expect.stringContaining('SKIPPED, not touched: Broken.png (linked to "Broken") - its World file couldn\'t be read ('));
    });

    test('a World whose originalData has no entries list lists its linkers as world-snapshot-unusable', async () => {
        writeWorldFile('Hollow', { entries: {}, originalData: { name: 'Hollow' } });
        await writeCardFile('Hollow.png', { data: { extensions: { world: 'Hollow' } } });
        await indexCharacters();

        const lines = [];
        await migration.runOnceAtBoot(directories, { log: line => lines.push(line) });
        const notice = await notices.readNotice(directories, NOTICE_ID);
        expect(notice.skipped.entries).toEqual([{ avatar: 'Hollow.png', world: 'Hollow', reason: 'world-snapshot-unusable' }]);
    });

    test('a sole linker whose card cannot be read is listed as card-unreadable', async () => {
        const book = makeBook();
        writeWorldFile('Alice\'s Lorebook', autoImportedWorldFile(book));
        await writeCardFile('Alice.png', { data: { extensions: { world: 'Alice\'s Lorebook' }, character_book: book } });
        await indexCharacters();
        const db = new Database(path.join(tempDir, 'character-metadata.sqlite'));
        try {
            db.prepare('UPDATE characters SET card_json = \'not json\' WHERE id = \'Alice.png\'').run();
        } finally {
            db.close();
        }

        const lines = [];
        await migration.runOnceAtBoot(directories, { log: line => lines.push(line) });
        const notice = await notices.readNotice(directories, NOTICE_ID);
        expect(notice.skipped.entries).toEqual([{ avatar: 'Alice.png', world: 'Alice\'s Lorebook', reason: 'card-unreadable' }]);
    });

    test('hand-made links, ambiguous cards and cards whose own data does not link the World are not listed', async () => {
        const book = makeBook();
        writeWorldFile('Hand', { entries: {} });
        await writeCardFile('Hand.png', { data: { extensions: { world: 'Hand' } } });
        const importedBook = makeBook('original content');
        const editedBook = makeBook('this got edited after import');
        writeWorldFile('Carol\'s Lorebook', autoImportedWorldFile(importedBook));
        await writeCardFile('Carol.png', { data: { extensions: { world: 'Carol\'s Lorebook' }, character_book: editedBook } });
        writeWorldFile('Dora\'s Lorebook', autoImportedWorldFile(book));
        await writeCardFile('Dora.png');
        await indexCharacters();
        const db = new Database(path.join(tempDir, 'character-metadata.sqlite'));
        try {
            db.prepare('UPDATE characters SET world = ? WHERE id = \'Dora.png\'').run('Dora\'s Lorebook');
        } finally {
            db.close();
        }

        const lines = [];
        const boot = await migration.runOnceAtBoot(directories, { log: line => lines.push(line) });
        expect(boot.result).toMatchObject({ skipped: 0, ambiguous: 1, notLinked: 1 });
        expect(lines).toContainEqual(expect.stringContaining('Dora.png: the character index lists it as linked to "Dora\'s Lorebook" but its card doesn\'t link it - nothing to unlink.'));
        expect(await notices.readNotice(directories, NOTICE_ID)).toBeNull();
    });

    test('the notice names the first 20 skipped cards and counts the rest; the console lists every one', async () => {
        for (let i = 0; i < 25; i++) {
            await writeCardFile(`Ghost${String(i).padStart(2, '0')}.png`, { data: { extensions: { world: `Missing ${i}` } } });
        }
        await indexCharacters();

        const lines = [];
        await migration.runOnceAtBoot(directories, { log: line => lines.push(line) });
        const notice = await notices.readNotice(directories, NOTICE_ID);
        expect(notice.skipped.total).toBe(25);
        expect(notice.skipped.entries).toHaveLength(20);
        expect(lines.filter(line => line.includes('SKIPPED, not touched: Ghost'))).toHaveLength(25);
    });
});

describe('unimport-embedded-lore - failed writes', () => {
    const book = makeBook();

    beforeEach(async () => {
        writeWorldFile('Alice\'s Lorebook', autoImportedWorldFile(book));
        writeWorldFile('Bob\'s Lorebook', autoImportedWorldFile(book));
        await writeCardFile('Alice.png', { data: { extensions: { world: 'Alice\'s Lorebook' }, character_book: book } });
        await writeCardFile('Bob.png', { data: { extensions: { world: 'Bob\'s Lorebook' }, character_book: book } });
    });

    test('a failed write is listed and kept for a retry, and the next boot retries only that card', async () => {
        await indexCharacters();

        const lines = [];
        const log = line => lines.push(line);
        const first = await migration.runOnceAtBoot(directories, { log, writeCard: failFor('Bob.png') });
        expect(first.status).toBe('ran');
        expect(first.result).toMatchObject({ migrated: 1, failed: 1 });
        expect((await readDbCard('Alice.png')).data.extensions.world).toBeFalsy();
        expect((await readDbCard('Bob.png')).data.extensions.world).toBe('Bob\'s Lorebook');
        expect(await isMarked(COMPLETED_KEY)).toBe(false);
        expect(await isMarked(PASS_COMPLETED_KEY)).toBe(true);
        expect(await isMarked(SKIPPED_REPORTED_KEY)).toBe(true);
        expect(lines).toContainEqual(expect.stringContaining('1 card(s) couldn\'t be written; the migration stays unfinished and retries them on the next boot.'));
        expect(await pendingRows()).toEqual([{ id: 'Bob.png', settled: 0 }]);
        expect(await notices.readNotice(directories, NOTICE_ID)).toMatchObject({
            failing: { total: 1, entries: [{ avatar: 'Bob.png', world: 'Bob\'s Lorebook' }] },
            skipped: { total: 0, entries: [] },
        });

        await metadataDb.upsertCharacterFromWrite(directories, 'Alice.png', JSON.stringify(makeCard('Alice.png', { data: { extensions: { world: 'Alice\'s Lorebook' }, character_book: book } })), null, null);

        const second = await migration.runOnceAtBoot(directories, { log });
        expect(second.status).toBe('retried');
        expect(second.result).toMatchObject({ retried: 1, migrated: 1, failed: 0 });
        expect((await readDbCard('Bob.png')).data.extensions.world).toBeFalsy();
        expect((await readDbCard('Alice.png')).data.extensions.world).toBe('Alice\'s Lorebook');
        expect(await isMarked(COMPLETED_KEY)).toBe(true);
        expect(await pendingRows()).toEqual([]);
        expect(await notices.readNotice(directories, NOTICE_ID)).toBeNull();

        const third = await migration.runOnceAtBoot(directories, { log });
        expect(third.status).toBe('already-complete');
    });

    test('a card that keeps failing is listed again after its notice was seen', async () => {
        await indexCharacters();

        const lines = [];
        const log = line => lines.push(line);
        await migration.runOnceAtBoot(directories, { log, writeCard: failFor('Bob.png') });
        const notice = await notices.readNotice(directories, NOTICE_ID);
        expect(await notices.markNoticeSeen(directories, NOTICE_ID, notice.version)).toBe(true);
        expect(await notices.readNotice(directories, NOTICE_ID)).toBeNull();

        const second = await migration.runOnceAtBoot(directories, { log, writeCard: failFor('Bob.png') });
        expect(second.status).toBe('retried');
        expect(await isMarked(COMPLETED_KEY)).toBe(false);
        expect((await notices.readNotice(directories, NOTICE_ID)).failing).toEqual({ total: 1, entries: [{ avatar: 'Bob.png', world: 'Bob\'s Lorebook' }] });
    });

    test('an unseen notice keeps its skipped cards while retries update its failing list', async () => {
        await writeCardFile('Ghost.png', { data: { extensions: { world: 'Missing Lore' } } });
        await indexCharacters();

        const lines = [];
        const log = line => lines.push(line);
        await migration.runOnceAtBoot(directories, { log, writeCard: failFor('Bob.png') });
        const raw1 = await notices.readNoticeRaw(directories, NOTICE_ID);

        await migration.runOnceAtBoot(directories, { log, writeCard: failFor('Bob.png') });
        expect(await notices.readNoticeRaw(directories, NOTICE_ID)).toBe(raw1);

        await migration.runOnceAtBoot(directories, { log });
        const notice = await notices.readNotice(directories, NOTICE_ID);
        expect(notice).toMatchObject({
            skipped: { total: 1, entries: [{ avatar: 'Ghost.png', world: 'Missing Lore', reason: 'world-missing' }] },
            failing: { total: 0, entries: [] },
        });
        expect(notice.version).toBeGreaterThan(JSON.parse(raw1).version);
    });

    test('a pending card whose World has gone missing is listed as skipped and no longer retried', async () => {
        await indexCharacters();

        const lines = [];
        const log = line => lines.push(line);
        await migration.runOnceAtBoot(directories, { log, writeCard: failFor('Bob.png') });
        fs.unlinkSync(path.join(worldsDir, 'Bob\'s Lorebook.json'));

        const second = await migration.runOnceAtBoot(directories, { log });
        expect(second.status).toBe('retried');
        expect(second.result).toMatchObject({ skipped: 1, failed: 0 });
        expect(await pendingRows()).toEqual([]);
        expect(await isMarked(COMPLETED_KEY)).toBe(true);
        const notice = await notices.readNotice(directories, NOTICE_ID);
        expect(notice.skipped.entries).toContainEqual({ avatar: 'Bob.png', world: 'Bob\'s Lorebook', reason: 'world-missing' });
        expect(notice.failing.total).toBe(0);
    });

    test('a pending row a crashed retry pass had settled is looked at again', async () => {
        await indexCharacters();
        await metadataDb.markMigrationComplete(directories, PASS_COMPLETED_KEY);
        await metadataDb.markMigrationComplete(directories, SKIPPED_REPORTED_KEY);
        await metadataDb.addMigrationPending(directories, NOTICE_ID, 'Bob.png');
        await metadataDb.setMigrationPendingSettled(directories, NOTICE_ID, 'Bob.png', true);

        const lines = [];
        const boot = await migration.runOnceAtBoot(directories, { log: line => lines.push(line) });
        expect(boot.status).toBe('retried');
        expect(boot.result).toMatchObject({ retried: 1, migrated: 1 });
        expect((await readDbCard('Bob.png')).data.extensions.world).toBeFalsy();
        expect((await readDbCard('Alice.png')).data.extensions.world).toBe('Alice\'s Lorebook');
        expect(await pendingRows()).toEqual([]);
        expect(await isMarked(COMPLETED_KEY)).toBe(true);
    });
});

describe('unimport-embedded-lore - report-only pass on an install the migration already finished', () => {
    test('lists skipped cards without writing anything, once', async () => {
        const book = makeBook();
        await writeCardFile('Ghost.png', { data: { extensions: { world: 'Missing Lore' } } });
        writeWorldFile('Alice\'s Lorebook', autoImportedWorldFile(book));
        await writeCardFile('Alice.png', { data: { extensions: { world: 'Alice\'s Lorebook' }, character_book: book } });
        await indexCharacters();
        await metadataDb.markMigrationComplete(directories, COMPLETED_KEY);
        const pngBefore = fs.readFileSync(path.join(charactersDir, 'Alice.png'));
        const cardJsonBefore = await metadataDb.getCharacterCardJson(directories, 'Alice.png');

        const lines = [];
        const log = line => lines.push(line);
        const boot = await migration.runOnceAtBoot(directories, { log });
        expect(boot.status).toBe('reported');
        expect(boot.result).toMatchObject({ skipped: 1, safe: 1, migrated: 0 });
        expect(fs.readFileSync(path.join(charactersDir, 'Alice.png')).equals(pngBefore)).toBe(true);
        expect(await metadataDb.getCharacterCardJson(directories, 'Alice.png')).toBe(cardJsonBefore);
        expect(await notices.readNotice(directories, NOTICE_ID)).toMatchObject({
            skipped: { total: 1, entries: [{ avatar: 'Ghost.png', world: 'Missing Lore', reason: 'world-missing' }] },
            failing: { total: 0, entries: [] },
        });
        expect(await isMarked(SKIPPED_REPORTED_KEY)).toBe(true);
        expect(lines).toContainEqual(expect.stringContaining('Done (report only, nothing written):'));
        expect(lines).not.toContainEqual(expect.stringContaining('DRY RUN'));

        const second = await migration.runOnceAtBoot(directories, { log });
        expect(second.status).toBe('already-complete');
    });

    test('with nothing skipped it stores no notice', async () => {
        const book = makeBook();
        writeWorldFile('Alice\'s Lorebook', autoImportedWorldFile(book));
        await writeCardFile('Alice.png', { data: { extensions: { world: 'Alice\'s Lorebook' }, character_book: book } });
        await indexCharacters();
        await metadataDb.markMigrationComplete(directories, COMPLETED_KEY);

        const lines = [];
        const boot = await migration.runOnceAtBoot(directories, { log: line => lines.push(line) });
        expect(boot.status).toBe('reported');
        expect(await notices.readNotice(directories, NOTICE_ID)).toBeNull();
        expect(await isMarked(SKIPPED_REPORTED_KEY)).toBe(true);
    });
});

describe('unimport-embedded-lore - orphan report', () => {
    test('a World file the orphan report cannot parse does not keep the migration from being marked done', async () => {
        const book = makeBook();
        writeWorldFile('Alice\'s Lorebook', autoImportedWorldFile(book));
        await writeCardFile('Alice.png', { data: { extensions: { world: 'Alice\'s Lorebook' }, character_book: book } });
        fs.writeFileSync(path.join(worldsDir, 'Junk.json'), '{not json');
        await indexCharacters();

        const lines = [];
        const boot = await migration.runOnceAtBoot(directories, { log: line => lines.push(line) });
        expect(boot.status).toBe('ran');
        expect(await isMarked(COMPLETED_KEY)).toBe(true);
        expect(lines).toContainEqual(expect.stringContaining('Listing orphaned World files failed:'));
        expect(boot.result.orphanedWorlds).toBeNull();
    });
});
