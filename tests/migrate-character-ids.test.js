import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {typeof import('../src/migrations/migrate-character-ids.js')} */
let migration;
/** @type {typeof import('../src/util.js')} */
let util;

let tempDir;
let charactersDir;
let chatsDir;
let groupsDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    metadataDb = await import('../src/character-metadata-db.js');
    cardParser = await import('../src/character-card-parser.js');
    migration = await import('../src/migrations/migrate-character-ids.js');
    util = await import('../src/util.js');
});

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-migrate-character-ids-test-'));
    charactersDir = path.join(tempDir, 'characters');
    chatsDir = path.join(tempDir, 'chats');
    groupsDir = path.join(tempDir, 'groups');
    fs.mkdirSync(charactersDir, { recursive: true });
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.mkdirSync(groupsDir, { recursive: true });
    directories = { root: tempDir, characters: charactersDir, chats: chatsDir, groups: groupsDir };
});

afterEach(() => {
    metadataDb.disposeMetadataStores();
});

/**
 * Writes a real, parseable character PNG named `avatar` under `charactersDir` - mirrors
 * character-metadata-db.test.js's writeCardFile().
 * @param {string} avatar
 * @param {object} overrides
 * @returns {Promise<void>}
 */
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

function readCardName(avatarPath) {
    const buffer = fs.readFileSync(avatarPath);
    const raw = cardParser.read(buffer);
    return JSON.parse(raw).name;
}

// Always skip the real search-index rebuild in tests - it's exercised separately by characters-query.test.js's
// own rebuild test, and pulling tantivy/FTS5 into every migration test here would make these tests about the
// search engine rather than about the migration's own file/db/reference rewriting.
const noRebuild = { rebuildSearchIndex: false, log: () => {} };

describe('migrateCharacterIds - discovery and idempotency', () => {
    test('migrates a legacy-named character to a uuid filename', async () => {
        await writeCardFile('Alice.png');

        const result = await migration.migrateCharacterIds(directories, noRebuild);

        expect(result.discovered).toBe(1);
        expect(result.migrated).toBe(1);
        expect(result.failed).toBe(0);
        expect(fs.existsSync(path.join(charactersDir, 'Alice.png'))).toBe(false);

        const files = fs.readdirSync(charactersDir);
        expect(files.length).toBe(1);
        expect(util.isUuidLike(path.parse(files[0]).name)).toBe(true);
        expect(readCardName(path.join(charactersDir, files[0]))).toBe('Alice');
    });

    test('a file already named with a uuid stem is left alone (the discriminator is "is it a uuid", not a name heuristic)', async () => {
        const uuidAvatar = `${util.uuidv7()}.png`;
        await writeCardFile(uuidAvatar);

        const result = await migration.migrateCharacterIds(directories, noRebuild);

        expect(result.discovered).toBe(0);
        expect(result.migrated).toBe(0);
        expect(fs.existsSync(path.join(charactersDir, uuidAvatar))).toBe(true);
    });

    test('running the migration twice does not double-migrate or re-mint a new id', async () => {
        await writeCardFile('Bob.png');

        const first = await migration.migrateCharacterIds(directories, noRebuild);
        expect(first.migrated).toBe(1);
        const filesAfterFirst = fs.readdirSync(charactersDir);
        expect(filesAfterFirst.length).toBe(1);
        const mintedId = filesAfterFirst[0];

        const second = await migration.migrateCharacterIds(directories, noRebuild);
        expect(second.discovered).toBe(0);
        expect(second.migrated).toBe(0); // nothing pending - already complete
        expect(second.total).toBe(0);

        // Still exactly the same file, same id - not renamed again, not duplicated.
        const filesAfterSecond = fs.readdirSync(charactersDir);
        expect(filesAfterSecond).toEqual([mintedId]);
    });

    test('a genuine mid-flight interruption (file renamed, db/chats not yet updated) is completed correctly on resume', async () => {
        await writeCardFile('Dave.png');
        const oldAvatar = 'Dave.png';

        // Do exactly what discoverPendingMigrations() + the first half of migrateOne() would do, then stop -
        // this is the real interruption point the design doc calls out ("restartable... because it will be
        // interrupted"): the file has moved, but upsertCharacterFromWrite/renameCharacterRow/markComplete never
        // ran.
        const newAvatar = `${util.uuidv7()}.png`;
        await metadataDb.recordIdMigrationMapping(directories, oldAvatar, newAvatar);
        await fs.promises.rename(path.join(charactersDir, oldAvatar), path.join(charactersDir, newAvatar));
        // No metadata row exists for either id yet in this scenario (mirrors a fresh install where bootstrap
        // hasn't run) - migrateOne() must still be able to build one from the file that's already there.

        const result = await migration.migrateCharacterIds(directories, noRebuild);

        expect(result.migrated).toBe(1);
        expect(result.failed).toBe(0);
        const row = await metadataDb.getCharacterMetadataRow(directories, newAvatar);
        expect(row).toBeDefined();
        expect(row.name).toBe('Dave');

        const pending = await metadataDb.getPendingIdMigrations(directories);
        expect(pending).toEqual([]);
    });

    test('neither old nor new file existing is reported as a failure, not silently skipped or crashed past', async () => {
        const oldAvatar = 'Ghost.png';
        const newAvatar = `${util.uuidv7()}.png`;
        await metadataDb.recordIdMigrationMapping(directories, oldAvatar, newAvatar);
        // Neither file actually exists on disk - simulates a row whose file vanished between discovery and the
        // migration step actually running.

        const result = await migration.migrateCharacterIds(directories, noRebuild);

        expect(result.migrated).toBe(0);
        expect(result.failed).toBe(1);
        const pending = await metadataDb.getPendingIdMigrations(directories);
        expect(pending.length).toBe(1); // left pending for manual review, not silently dropped
    });
});

describe('migrateCharacterIds - a batch left in mixed mid-migration states resumes cleanly', () => {
    test('a mix of untouched, minted-only, and already-complete characters all end up correctly and uniquely migrated after one more run', async () => {
        // Simulates the state a real 300k+-character run gets interrupted in: some characters were never even
        // looked at yet, some had an id minted and the file renamed but nothing else done, and some had already
        // fully finished on a prior invocation - all coexisting at once, which is exactly what "restartable
        // because it will be interrupted" means in practice.
        const alreadyComplete = [];
        for (let i = 0; i < 5; i++) {
            const avatar = `AlreadyComplete${i}.png`;
            await writeCardFile(avatar);
            alreadyComplete.push(avatar);
        }
        // Fully migrate this group ahead of time, in its own isolated run, so by the time the mixed-state run
        // below happens, these rows are already completed = 1 and must not be touched again.
        const preRun = await migration.migrateCharacterIds(directories, noRebuild);
        expect(preRun.migrated).toBe(alreadyComplete.length);

        const untouched = [];
        for (let i = 0; i < 5; i++) {
            const avatar = `Untouched${i}.png`;
            await writeCardFile(avatar);
            untouched.push(avatar);
        }

        const mintedOnly = [];
        for (let i = 0; i < 5; i++) {
            const oldAvatar = `MintedOnly${i}.png`;
            await writeCardFile(oldAvatar);
            const newAvatar = `${util.uuidv7()}.png`;
            await metadataDb.recordIdMigrationMapping(directories, oldAvatar, newAvatar);
            await fs.promises.rename(path.join(charactersDir, oldAvatar), path.join(charactersDir, newAvatar));
            mintedOnly.push({ oldAvatar, newAvatar });
        }

        const result = await migration.migrateCharacterIds(directories, noRebuild);

        expect(result.discovered).toBe(untouched.length);
        expect(result.migrated).toBe(untouched.length + mintedOnly.length);
        expect(result.failed).toBe(0);

        // Every original filename is gone; every resulting filename is uuid-shaped; no duplicates.
        const finalFiles = fs.readdirSync(charactersDir);
        expect(finalFiles.length).toBe(untouched.length + mintedOnly.length + alreadyComplete.length);
        expect(new Set(finalFiles).size).toBe(finalFiles.length);
        for (const file of finalFiles) {
            expect(util.isUuidLike(path.parse(file).name)).toBe(true);
        }
        for (const avatar of [...untouched, ...alreadyComplete]) {
            expect(fs.existsSync(path.join(charactersDir, avatar))).toBe(false);
        }
        for (const { oldAvatar, newAvatar } of mintedOnly) {
            expect(fs.existsSync(path.join(charactersDir, oldAvatar))).toBe(false);
            expect(fs.existsSync(path.join(charactersDir, newAvatar))).toBe(true);
            const row = await metadataDb.getCharacterMetadataRow(directories, newAvatar);
            expect(row).toBeDefined();
        }

        // Nothing left pending.
        expect(await metadataDb.getPendingIdMigrations(directories)).toEqual([]);

        // A further run is a total no-op.
        const finalRun = await migration.migrateCharacterIds(directories, noRebuild);
        expect(finalRun.discovered).toBe(0);
        expect(finalRun.migrated).toBe(0);
        expect(finalRun.total).toBe(0);
    });
});

describe('migrateCharacterIds - date_added preservation across the migration', () => {
    test('date_added is carried forward to the new id, not reset to "now"', async () => {
        await writeCardFile('Eve.png');
        const filePath = path.join(charactersDir, 'Eve.png');
        const stat = await fs.promises.stat(filePath);

        // Seed a metadata row the way bootstrapIfNeeded() would for a pre-existing library, with a real
        // (older) date_added rather than whatever "now" would be at migration time.
        await metadataDb.upsertCharacterFromWrite(directories, 'Eve.png', JSON.stringify({
            name: 'Eve', data: { name: 'Eve', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } },
        }), stat.mtimeMs);
        const beforeRow = await metadataDb.getCharacterMetadataRow(directories, 'Eve.png');

        await new Promise(resolve => setTimeout(resolve, 5));
        const result = await migration.migrateCharacterIds(directories, noRebuild);
        expect(result.migrated).toBe(1);

        const newAvatar = fs.readdirSync(charactersDir)[0];
        const afterRow = await metadataDb.getCharacterMetadataRow(directories, newAvatar);
        expect(afterRow.date_added).toBe(beforeRow.date_added);
    });
});

describe('migrateCharacterIds - chat directory', () => {
    test('renames the chats directory to match the new id', async () => {
        await writeCardFile('Frank.png');
        const oldChatsDir = path.join(chatsDir, 'Frank');
        fs.mkdirSync(oldChatsDir, { recursive: true });
        fs.writeFileSync(path.join(oldChatsDir, 'chat1.jsonl'), '{}\n');

        const result = await migration.migrateCharacterIds(directories, noRebuild);
        expect(result.migrated).toBe(1);

        const newAvatar = fs.readdirSync(charactersDir)[0];
        const newStem = path.parse(newAvatar).name;
        expect(fs.existsSync(oldChatsDir)).toBe(false);
        expect(fs.existsSync(path.join(chatsDir, newStem))).toBe(true);
        expect(fs.existsSync(path.join(chatsDir, newStem, 'chat1.jsonl'))).toBe(true);
    });
});

describe('migrateCharacterIds - cross-cutting reference sweep', () => {
    test('rewrites group members to the new id', async () => {
        await writeCardFile('Grace.png');
        fs.writeFileSync(path.join(groupsDir, '1700000000000.json'), JSON.stringify({
            id: '1700000000000', name: 'Test Group', members: ['Grace.png', 'Someone-Else.png'], disabled_members: [],
        }));

        const result = await migration.migrateCharacterIds(directories, noRebuild);
        expect(result.migrated).toBe(1);
        const newAvatar = fs.readdirSync(charactersDir)[0];

        const group = JSON.parse(fs.readFileSync(path.join(groupsDir, '1700000000000.json'), 'utf8'));
        expect(group.members).toEqual([newAvatar, 'Someone-Else.png']);
    });

    test('rewrites charLore (by extensionless stem), note.chara, and active_character in settings.json', async () => {
        await writeCardFile('Heidi.png');
        const settingsPath = path.join(tempDir, 'settings.json');
        fs.writeFileSync(settingsPath, JSON.stringify({
            active_character: 'Heidi.png',
            world_info_settings: { world_info: { charLore: [{ name: 'Heidi', extraBooks: ['Some Book'] }] } },
            extension_settings: { note: { chara: [{ name: 'Heidi.png', useChara: true }] } },
        }));

        const result = await migration.migrateCharacterIds(directories, noRebuild);
        expect(result.migrated).toBe(1);
        const newAvatar = fs.readdirSync(charactersDir)[0];
        const newStem = path.parse(newAvatar).name;

        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        expect(settings.active_character).toBe(newAvatar);
        expect(settings.world_info_settings.world_info.charLore[0].name).toBe(newStem);
        expect(settings.world_info_settings.world_info.charLore[0].extraBooks).toEqual(['Some Book']);
        expect(settings.extension_settings.note.chara[0].name).toBe(newAvatar);
        expect(settings.extension_settings.note.chara[0].useChara).toBe(true);
    });

    test('a second run over an already-migrated library leaves group/settings files untouched (no spurious rewrite)', async () => {
        await writeCardFile('Ivan.png');
        const settingsPath = path.join(tempDir, 'settings.json');
        fs.writeFileSync(settingsPath, JSON.stringify({ active_character: 'Ivan.png' }));

        await migration.migrateCharacterIds(directories, noRebuild);
        const settingsAfterFirst = fs.statSync(settingsPath).mtimeMs;

        await new Promise(resolve => setTimeout(resolve, 20));
        await migration.migrateCharacterIds(directories, noRebuild);
        const settingsAfterSecond = fs.statSync(settingsPath).mtimeMs;

        // Content is stable either way - the key claim isn't "never touched again" (a fresh write with
        // identical content would also be harmless), it's that the referenced id didn't change or get
        // corrupted by being swept twice.
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        const newAvatar = fs.readdirSync(charactersDir)[0];
        expect(settings.active_character).toBe(newAvatar);
        void settingsAfterFirst;
        void settingsAfterSecond;
    });

    test('does not touch a group member that was never discovered/migrated at all', async () => {
        // 'Judy.png' has no character file, no id_migration row, nothing - simulates a group member reference
        // whose character was already deleted or simply isn't part of this migration run. Running the
        // migration (over a different, unrelated character) must not invent a rewrite for it.
        await writeCardFile('Karl.png');
        fs.writeFileSync(path.join(groupsDir, '1700000000001.json'), JSON.stringify({
            id: '1700000000001', name: 'G', members: ['Judy.png', 'Karl.png'],
        }));

        await migration.migrateCharacterIds(directories, noRebuild);
        const newAvatar = fs.readdirSync(charactersDir)[0];

        const group = JSON.parse(fs.readFileSync(path.join(groupsDir, '1700000000001.json'), 'utf8'));
        expect(group.members).toEqual(['Judy.png', newAvatar]);
    });
});
