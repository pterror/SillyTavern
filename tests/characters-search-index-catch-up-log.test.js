import { describe, test, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @type {typeof import('../src/endpoints/characters-search-index.js')} */
let searchIndex;
/** @type {typeof import('../src/character-metadata-db.js')} */
let metadataDb;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {typeof import('../src/endpoints/tantivy-engine.js')} */
let tantivyEngine;
/** @type {typeof import('../src/endpoints/search-index-coordinator.js')} */
let searchCoordinator;

let tempDir;
let charactersDir;
/** @type {import('../src/users.js').UserDirectoryList} */
let directories;
let maintainer;

/** @param {string} name */
async function writeCard(name) {
    const baseImage = await fs.promises.readFile(path.join(process.cwd(), '..', 'public', 'img', 'ai4.png'));
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
    };
    await fs.promises.writeFile(path.join(charactersDir, `${name}.png`), cardParser.write(baseImage, JSON.stringify(card)));
}

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    searchIndex = await import('../src/endpoints/characters-search-index.js');
    metadataDb = await import('../src/character-metadata-db.js');
    cardParser = await import('../src/character-card-parser.js');
    tantivyEngine = await import('../src/endpoints/tantivy-engine.js');
    searchCoordinator = await import('../src/endpoints/search-index-coordinator.js');
});

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-search-catch-up-log-test-'));
    charactersDir = path.join(tempDir, 'characters');
    directories = {
        root: tempDir,
        characters: charactersDir,
        chats: path.join(tempDir, 'chats'),
        groups: path.join(tempDir, 'groups'),
        groupChats: path.join(tempDir, 'groupChats'),
    };
    for (const dir of [charactersDir, directories.chats, directories.groups, directories.groupChats]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    maintainer = null;
});

afterEach(async () => {
    maintainer?.close();
    await searchCoordinator.disposeSearchWorkers();
    metadataDb.disposeMetadataStores();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('characters-search-index.js: catch-up log line', () => {
    test('a tick reports its seq range, writer mix, backlog and per-phase times', async () => {
        const tantivy = await tantivyEngine.getTantivyModule();
        if (!tantivy) {
            return;
        }

        await writeCard('FavChar');
        await writeCard('PlainChar');
        await metadataDb.bootstrapIfNeeded(directories);

        maintainer = searchIndex.createCharacterIndexMaintainer(directories, tantivy);
        expect(await maintainer.rebuild()).not.toBeNull();
        const seqBefore = maintainer.seq();

        await metadataDb.setCharacterFav(directories, 'FavChar.png', true);

        const result = await maintainer.tick();
        expect(result).not.toBeNull();
        expect(result).not.toHaveProperty('swapped');
        const r = /** @type {import('../src/endpoints/characters-search-index.js').TickResult} */ (result);

        expect(r.changed).toBe(true);
        expect(r.seqFrom).toBe(seqBefore);
        expect(r.seq).toBeGreaterThan(seqBefore);
        expect(r.backlog).toBe(0);
        expect(r.writers).toEqual({ fav: 1 });
        expect(r.upserts).toBe(1);
        expect(r.tagRenames).toBe(0);
        expect(r.tagNameSeq).toBe(r.tagNameSeqFrom);
        expect(Object.keys(r.phases).sort()).toEqual(['add', 'build', 'commit', 'deletes', 'load', 'persist', 'read', 'tags']);
        expect(r.lockWaitMs).toBe(0);

        const line = searchIndex.formatCatchUpLine(r);
        expect(line).toMatch(new RegExp(`^\\[search\\] catch-up: seq=${seqBefore}\\.\\.${r.seq} backlog=0 writers=fav:1 tagrenames=0 deletes=0 upserts=1 total_ms=\\d+ read_ms=\\d+ deletes_ms=\\d+ tags_ms=\\d+ load_ms=\\d+ build_ms=\\d+ add_ms=\\d+ commit_ms=\\d+ persist_ms=\\d+ lockwait_ms=0$`));
        expect(line).not.toContain('\n');
    }, 20000);

    test('the line names the tag-rename cursor only when it moved, and counts an id under each of its fields', () => {
        const phases = { read: 1, deletes: 2, tags: 3, load: 4, build: 5, add: 6, commit: 7, persist: 8 };
        const base = {
            changed: true, deletes: 0, upserts: 3, ms: 40, seq: 20, seqFrom: 10, tagNameSeqFrom: 5, tagNameSeq: 5,
            backlog: 4, writers: { fav: 2, tag_ids: 1, null: 1 }, tagRenames: 0, phases, lockWaitMs: 9,
        };
        expect(searchIndex.formatCatchUpLine(base)).toBe(
            '[search] catch-up: seq=10..20 backlog=4 writers=fav:2,tag_ids:1,null:1 tagrenames=0 deletes=0 upserts=3 total_ms=40'
            + ' read_ms=1 deletes_ms=2 tags_ms=3 load_ms=4 build_ms=5 add_ms=6 commit_ms=7 persist_ms=8 lockwait_ms=9');
        expect(searchIndex.formatCatchUpLine({ ...base, tagNameSeq: 7, tagRenames: 2 }))
            .toContain('seq=10..20 tagseq=5..7 backlog=4 writers=fav:2,tag_ids:1,null:1 tagrenames=2 ');
    });
});
