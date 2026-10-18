import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

/** @type {import('express').Router} */
let router;
/** @type {typeof import('../src/library-codes.js').TYPE} */
let TYPE;
/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

/**
 * Mounts the real characters.js router, mirroring characters-query.test.js's setup - `/changes` is a read over
 * the same store `/query` reads, so the same seeding approach applies.
 */
beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    ({ router } = await import('../src/endpoints/characters.js'));
    fixture = await import('./converted-user.fixture.js');
    ({ TYPE } = await import('../src/library-codes.js'));
    cardParser = await import('../src/character-card-parser.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = { directories, profile: { handle: `test-user-${path.basename(directories.root)}` } };
        next();
    });
    app.use('/api/characters', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(async () => {
    user = await fixture.emptyUser('st-characters-changes-test-');
    directories = user.directories;
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(() => user.close());

async function postJson(urlPath, body) {
    const response = await fetch(`${baseUrl}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return response;
}

/**
 * Same seeding shape as characters-query.test.js's seedCharacter() - writes a row through the real
 * upsertCharacterFromWrite() write-path hook (the one characters.js's real create/edit routes call), which is
 * also the path that records a change.
 * @param {string} avatar
 * @param {object} overrides
 */
async function seedCharacter(avatar, overrides = {}) {
    const card = {
        name: avatar.replace(/\.png$/, ''),
        fav: false,
        data: {
            name: avatar.replace(/\.png$/, ''),
            tags: [],
            creator: '',
            character_version: '',
            creator_notes: '',
            extensions: { fav: false, world: '' },
        },
        ...overrides,
    };
    await user.store.lib.writeCard(directories, avatar, JSON.stringify(card));
}

describe('POST /api/characters/changes', () => {
    test('rejects a missing/invalid sinceSeq with 400', async () => {
        expect((await postJson('/api/characters/changes', {})).status).toBe(400);
        expect((await postJson('/api/characters/changes', { sinceSeq: -1 })).status).toBe(400);
        expect((await postJson('/api/characters/changes', { sinceSeq: 'nope' })).status).toBe(400);
    });

    test('sinceSeq: 0 on an empty library returns an empty change list at seq 0', async () => {
        const response = await postJson('/api/characters/changes', { sinceSeq: 0 });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ seq: 0, changes: [], truncated: false, hasMore: false });
    });

    test('sinceSeq: 0 on a genuinely cold sync returns the whole library as upsert entries - the correctness ' +
        'property fetchCharactersDelta() (script.js) relies on to replace /manifest entirely: every real write ' +
        'path logs a changes row, so there is no separate ground-truth listing needed to know the full current ' +
        'id set', async () => {
        await seedCharacter('Alice.png');
        await seedCharacter('Bob.png');
        await seedCharacter('Carol.png');

        const response = await postJson('/api/characters/changes', { sinceSeq: 0 });
        expect(response.status).toBe(200);
        /** @type {{seq: number, changes: {id: string, op: string}[], truncated: boolean}} */
        const body = await response.json();
        expect(body.truncated).toBe(false);
        // A position in the store's change feed, read to its end.
        expect(body.seq).toBe(await user.store.lib.changesEnd());
        expect(body.changes.map(c => c.id).sort()).toEqual(['Alice.png', 'Bob.png', 'Carol.png']);
        expect(body.changes.every(c => c.op === 'upsert')).toBe(true);
    });

    test('a client caught up to the current seq gets an empty change list back - the cheap steady-state case ' +
        '/manifest could never offer (its response is always O(library size), even when nothing changed)', async () => {
        await seedCharacter('Alice.png');
        const first = await (await postJson('/api/characters/changes', { sinceSeq: 0 })).json();

        const second = await postJson('/api/characters/changes', { sinceSeq: first.seq });
        expect(second.status).toBe(200);
        expect(await second.json()).toEqual({ seq: first.seq, changes: [], truncated: false, hasMore: false });
    });

    test('only the ids that actually changed since sinceSeq come back, not the whole library', async () => {
        await seedCharacter('Alice.png');
        await seedCharacter('Bob.png');
        const afterFirstTwo = await (await postJson('/api/characters/changes', { sinceSeq: 0 })).json();

        await seedCharacter('Carol.png');

        const response = await postJson('/api/characters/changes', { sinceSeq: afterFirstTwo.seq });
        const body = await response.json();
        expect(body.changes).toEqual([{ id: 'Carol.png', op: 'upsert', fields: null }]);
    });

    test('a deleted character comes back as an explicit op: \'delete\' entry, not merely absent from a listing', async () => {
        await seedCharacter('Alice.png');
        const afterCreate = await (await postJson('/api/characters/changes', { sinceSeq: 0 })).json();

        await user.store.lib.deleteEntity(TYPE.character, 'Alice.png');

        const response = await postJson('/api/characters/changes', { sinceSeq: afterCreate.seq });
        const body = await response.json();
        expect(body.changes).toEqual([{ id: 'Alice.png', op: 'delete' }]);
    });

    test('an edit followed by a delete in the same window collapses to a single delete entry, not two rows', async () => {
        await seedCharacter('Alice.png');
        const afterCreate = await (await postJson('/api/characters/changes', { sinceSeq: 0 })).json();

        await seedCharacter('Alice.png', { data: { name: 'Alice', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        await user.store.lib.deleteEntity(TYPE.character, 'Alice.png');

        const response = await postJson('/api/characters/changes', { sinceSeq: afterCreate.seq });
        const body = await response.json();
        expect(body.changes).toEqual([{ id: 'Alice.png', op: 'delete' }]);
    });

    test('a card imported by the rescan of the characters folder also logs a real change', async () => {
        // A real parseable card, not just a file that ends in .png - the rescan skips (and only logs a warning for)
        // anything it can't read.
        const baseImage = await fs.promises.readFile(path.join(process.cwd(), '..', 'public', 'img', 'ai4.png'));
        const card = {
            name: 'Legacy', fav: false, spec: 'chara_card_v2', spec_version: '2.0',
            data: {
                name: 'Legacy', description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
                tags: [], creator: '', character_version: '', creator_notes: '',
                extensions: { fav: false, world: '' },
            },
        };
        const buffer = cardParser.write(baseImage, JSON.stringify(card));
        await fs.promises.writeFile(path.join(directories.characters, 'Legacy.png'), buffer);

        expect((await postJson('/api/characters/metadata/rescan', {})).status).toBe(200);

        const response = await postJson('/api/characters/changes', { sinceSeq: 0 });
        const body = await response.json();
        expect(body.changes).toEqual([{ id: 'Legacy.png', op: 'upsert', fields: null }]);
    });
});
