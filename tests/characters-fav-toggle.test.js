import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import path from 'node:path';

// /api/characters/fav with `toggle: true`: the server flips what it has stored, so the page needs no copy of the
// character (bulk fav on characters the page doesn't hold).

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;
let TYPE;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));

    ({ TYPE } = await import('../src/library-codes.js'));
    const { router } = await import('../src/endpoints/characters.js');

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
    user = await (await import('./converted-user.fixture.js')).emptyUser('st-characters-fav-toggle-test-');
    ({ directories } = user);
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(() => user.close());

/** @returns {Promise<{ status: number, body: any }>} */
async function fav(body) {
    const response = await fetch(`${baseUrl}/api/characters/fav`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body: parsed };
}

/** @param {string} avatar @param {boolean} isFav */
async function seedCharacter(avatar, isFav) {
    const name = avatar.replace(/\.png$/, '');
    const cardJson = JSON.stringify({
        name,
        fav: isFav,
        data: { name, tags: [], creator: '', character_version: '', creator_notes: '', extensions: { fav: isFav, world: '' } },
    });
    await user.store.lib.writeCard(directories, avatar, cardJson);
}

/** @param {string} avatar */
async function storedFav(avatar) {
    return (await user.store.lib.entity(TYPE.character, avatar))?.fav;
}

describe('POST /api/characters/fav toggle', () => {
    test('single toggle flips the stored value and answers it', async () => {
        await seedCharacter('A.png', false);

        const first = await fav({ avatar: 'A.png', toggle: true });
        expect(first).toEqual({ status: 200, body: { fav: true } });
        expect(await storedFav('A.png')).toBeTruthy();

        const second = await fav({ avatar: 'A.png', toggle: true });
        expect(second).toEqual({ status: 200, body: { fav: false } });
        expect(await storedFav('A.png')).toBeFalsy();
    });

    test('single toggle of an unknown avatar is a 404 and writes nothing', async () => {
        const result = await fav({ avatar: 'Nobody.png', toggle: true });
        expect(result.status).toBe(404);
    });

    test('bulk toggle flips each from its own stored value, mixed states included', async () => {
        await seedCharacter('A.png', false);
        await seedCharacter('B.png', true);

        const result = await fav({ bulk: [{ avatar: 'A.png', toggle: true }, { avatar: 'B.png', toggle: true }, { avatar: 'Nobody.png', toggle: true }] });
        expect(result.status).toBe(200);
        expect(result.body.results).toEqual([
            { avatar: 'A.png', ok: true, fav: true },
            { avatar: 'B.png', ok: true, fav: false },
            { avatar: 'Nobody.png', ok: false },
        ]);
        expect(await storedFav('A.png')).toBeTruthy();
        expect(await storedFav('B.png')).toBeFalsy();
    });

    test('an explicit fav value still sets it, as before', async () => {
        await seedCharacter('A.png', false);
        const result = await fav({ bulk: [{ avatar: 'A.png', fav: true }] });
        expect(result.body.results).toEqual([{ avatar: 'A.png', ok: true }]);
        expect(await storedFav('A.png')).toBeTruthy();
    });
});
