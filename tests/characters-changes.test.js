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

    test('sinceSeq: 0 names every character as an upsert: every real write path logs a changes row', async () => {
        await seedCharacter('Alice.png');
        await seedCharacter('Bob.png');
        await seedCharacter('Carol.png');

        const response = await postJson('/api/characters/changes', { sinceSeq: 0 });
        expect(response.status).toBe(200);
        /** @type {{seq: number, changes: {id: string, op: string}[], truncated: boolean}} */
        const body = await response.json();
        expect(body.truncated).toBe(false);
        expect(body.seq).toBe(await user.store.lib.changesEnd());
        expect(body.changes.map(c => c.id).sort()).toEqual(['Alice.png', 'Bob.png', 'Carol.png']);
        expect(body.changes.every(c => c.op === 'upsert')).toBe(true);
    });

    test('a client caught up to the current seq gets an empty change list back', async () => {
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

    test('a group written or deleted comes back marked as a group, apart from a character', async () => {
        await seedCharacter('Alice.png');
        await user.store.lib.writeGroup({ id: '100', name: 'Party', members: ['Alice.png'] });
        await user.store.lib.writeGroup({ id: '200', name: 'Other', members: [] });
        const afterCreate = await (await postJson('/api/characters/changes', { sinceSeq: 0 })).json();
        expect(afterCreate.changes).toEqual([
            { id: 'Alice.png', op: 'upsert', fields: null },
            { id: '100', op: 'upsert', type: 'group' },
            { id: '200', op: 'upsert', type: 'group' },
        ]);

        await user.store.lib.updateGroup('100', group => { group.name = 'Renamed'; });
        await user.store.lib.deleteEntity(TYPE.group, '200');

        const body = await (await postJson('/api/characters/changes', { sinceSeq: afterCreate.seq })).json();
        expect(body.changes).toEqual([{ id: '100', op: 'upsert', type: 'group' }, { id: '200', op: 'delete', type: 'group' }]);
    });
});
