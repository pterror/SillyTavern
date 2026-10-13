import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

/** @type {import('express').Router} */
let router;
/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {typeof import('../src/character-avatars.js')} */
let avatars;
let TYPE;
/** @type {typeof import('../src/character-card-parser.js')} */
let cardParser;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

/**
 * Mounts the real characters.js router behind a fake auth middleware, mirroring characters-query.test.js's setup.
 */
beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    ({ router } = await import('../src/endpoints/characters.js'));
    fixture = await import('./converted-user.fixture.js');
    avatars = await import('../src/character-avatars.js');
    ({ TYPE } = await import('../src/library-codes.js'));
    cardParser = await import('../src/character-card-parser.js');

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/characters', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(async () => {
    user = await fixture.emptyUser('st-characters-rename-test-');
    ({ directories } = user);
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
 * Writes a real (parseable) PNG card under `avatar` and seeds its metadata row, mirroring
 * characters-query.test.js's seedCharacterWithFile().
 * @param {string} avatar
 * @param {object} overrides
 */
async function seedCharacterWithFile(avatar, overrides = {}) {
    const baseImage = await fs.promises.readFile(path.join(process.cwd(), '..', 'public', 'img', 'ai4.png'));
    const name = avatar.replace(/\.png$/, '');
    const card = {
        name,
        fav: false,
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
    await fixture.writeCardWithImage(user, avatar, JSON.stringify(card), buffer);
}

describe('POST /api/characters/rename (design doc §9 phase 4d: collapses to a card-data edit)', () => {
    test('keeps the same avatar/id in the response - no file move', async () => {
        await seedCharacterWithFile('11ee9c30-3aaa-7000-8000-000000000001.png');
        const imageBefore = await avatars.avatarPathOf(user.store.lib, directories, '11ee9c30-3aaa-7000-8000-000000000001.png');

        const response = await postJson('/api/characters/rename', {
            avatar_url: '11ee9c30-3aaa-7000-8000-000000000001.png',
            new_name: 'New Display Name',
        });

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.avatar).toBe('11ee9c30-3aaa-7000-8000-000000000001.png');

        // The image is still the same file - no rename, no copy.
        expect(await avatars.avatarPathOf(user.store.lib, directories, '11ee9c30-3aaa-7000-8000-000000000001.png')).toBe(imageBefore);
    });

    test('updates the display name in the card payload', async () => {
        await seedCharacterWithFile('11ee9c30-3aaa-7000-8000-000000000002.png', { name: 'Old Name', data: { name: 'Old Name', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });

        await postJson('/api/characters/rename', {
            avatar_url: '11ee9c30-3aaa-7000-8000-000000000002.png',
            new_name: 'New Name',
        });

        const [card] = await user.store.lib.cards(['11ee9c30-3aaa-7000-8000-000000000002.png']);
        expect(card.name).toBe('New Name');
    });

    test('does not move or create a chats directory', async () => {
        const avatar = '11ee9c30-3aaa-7000-8000-000000000003.png';
        await seedCharacterWithFile(avatar);
        const chatsDir = path.join(directories.chats, avatar.replace(/\.png$/, ''));
        fs.mkdirSync(chatsDir, { recursive: true });
        fs.writeFileSync(path.join(chatsDir, 'a.jsonl'), '{}\n');

        await postJson('/api/characters/rename', { avatar_url: avatar, new_name: 'Renamed' });

        // Same directory, same content - never touched.
        expect(fs.existsSync(chatsDir)).toBe(true);
        expect(fs.existsSync(path.join(chatsDir, 'a.jsonl'))).toBe(true);
    });

    test('never changes date_added (id is immutable, so there is no old-row/new-row carry-forward to get wrong)', async () => {
        const avatar = '11ee9c30-3aaa-7000-8000-000000000004.png';
        await seedCharacterWithFile(avatar);
        const before = await user.store.lib.entity(TYPE.character, avatar);

        await new Promise(resolve => setTimeout(resolve, 5));
        await postJson('/api/characters/rename', { avatar_url: avatar, new_name: 'Renamed Again' });

        const after = await user.store.lib.entity(TYPE.character, avatar);
        expect(after.added).toBe(before.added);
    });

    test('400s when avatar_url or new_name is missing', async () => {
        const r1 = await postJson('/api/characters/rename', { new_name: 'X' });
        expect(r1.status).toBe(400);
        const r2 = await postJson('/api/characters/rename', { avatar_url: 'x.png' });
        expect(r2.status).toBe(400);
    });

    describe('past chats: "No" keeps the names messages were sent under', () => {
        const avatar = '11ee9c30-3aaa-7000-8000-000000000010.png';
        const wait = () => new Promise(resolve => setTimeout(resolve, 5));
        const rename = (name, pastChats) => postJson('/api/characters/rename', { avatar_url: avatar, new_name: name, rename_past_chats: pastChats });
        /** Appends a message by the character, at the real time now or at `time`. */
        const say = async (text, after, time) => {
            const chats = user.store.chats;
            if (time !== undefined) chats.now = () => time;
            try {
                const name = (await user.store.people.byAvatar([avatar])).get(avatar).name;
                const [id] = await fixture.seedMessages(user.store, { avatar }, after, [{ name, is_user: false, is_system: false, mes: text, original_avatar: avatar, extra: {} }]);
                return id;
            } finally {
                chats.now = () => Date.now();
            }
        };
        /** The names the whole branch down to `at` shows. */
        const shown = async at => {
            const tree = await fixture.treeOf(user.store, { avatar });
            return (await user.store.chats.load({ tree, at })).messages.map(m => m.name);
        };

        beforeEach(async () => {
            await seedCharacterWithFile(avatar, { name: 'First', data: { name: 'First', tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: false, world: '' } } });
        });

        test('No: older messages keep the old name, newer ones show the new', async () => {
            const a = await say('a', null, Date.now() - 10000);
            const response = await rename('Second', false);
            expect(await response.json()).toEqual({ avatar });
            await wait();
            const b = await say('b', a);
            expect(await shown(b)).toEqual(['First', 'Second']);
            const [card] = await user.store.lib.cards([avatar]);
            expect(card.name).toBe('Second');
            expect(JSON.stringify(card)).not.toContain('history:name');
        });

        test('Yes: every message shows the new name, and answers past_chats_renamed', async () => {
            const a = await say('a', null, Date.now() - 10000);
            const response = await rename('Second', true);
            expect(await response.json()).toEqual({ avatar, past_chats_renamed: 0 });
            await wait();
            const b = await say('b', a);
            expect(await shown(b)).toEqual(['Second', 'Second']);
        });

        test('renames chain, and a Yes after No renames shows the newest name everywhere', async () => {
            const a = await say('a', null, Date.now() - 10000);
            await rename('Second', false);
            await wait();
            const b = await say('b', a);
            await wait();
            await rename('Third', false);
            await wait();
            const c = await say('c', b);
            expect(await shown(c)).toEqual(['First', 'Second', 'Third']);
            await wait();
            await rename('Fourth', true);
            expect(await shown(c)).toEqual(['Fourth', 'Fourth', 'Fourth']);
        });

        test('survives a card edit and a reopen', async () => {
            const a = await say('a', null, Date.now() - 10000);
            await rename('Second', false);
            await wait();
            const b = await say('b', a);
            // A card write (the editor's save) keeps the history.
            const [card] = await user.store.lib.cards([avatar]);
            card.data.description = 'edited';
            await user.store.lib.writeCard(directories, avatar, JSON.stringify(card));
            const stores = await import('../src/user-stores.js');
            await stores.closeUserStores();
            user.store = await stores.userStore(directories, 'u');
            expect(await shown(b)).toEqual(['First', 'Second']);
        });

        test('the history is stored as one item per entry and reads back as the same list through a reopen', async () => {
            const { NAME_HISTORY, renamesOf } = await import('../src/library-codes.js');
            const { storedValues } = await import('../src/entity-values.js');
            const stored = async () => storedValues(await user.store.lib.entity(TYPE.character, avatar));
            await rename('Second', false);
            await wait();
            await rename('Third', false);
            const stores = await import('../src/user-stores.js');
            await stores.closeUserStores();
            user.store = await stores.userStore(directories, 'u');
            const { values, lists } = await stored();
            expect([...values.keys()].filter(k => typeof k === 'string' && k.startsWith('history'))).toEqual([]);
            expect(lists.get(NAME_HISTORY)).toHaveLength(2);
            const entries = renamesOf(lists.get(NAME_HISTORY));
            expect(entries.map(e => e.name)).toEqual(['First', 'Second']);
            expect(entries[0].until).toBeLessThanOrEqual(entries[1].until);
        });
    });
});
