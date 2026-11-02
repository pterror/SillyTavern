import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('./converted-user.fixture.js')} */
let fixture;
/** @type {import('node:http').Server} */
let server;
let baseUrl;
/** @type {typeof import('../src/image-identity.js')} */
let identity;
/** @type {typeof import('../src/thumbnail-urls.js')} */
let urls;
/** @type {typeof import('../src/image-entities.js')} */
let images;
/** @type {typeof import('../src/library-codes.js')} */
let codes;
/** @type {typeof import('../src/endpoints/thumbnails.js')} */
let thumbnails;
/** @type {typeof import('../src/avatar-refs.js')} */
let refs;
/** @type {Buffer} */
let png;

const originalCwd = process.cwd();

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {number} [w]
 * @param {number} [h]
 */
async function solidPng(r, g, b, w = 300, h = 300) {
    const { Jimp } = await import('../src/jimp.js');
    const image = new Jimp({ width: w, height: h, color: ((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0 });
    return Buffer.from(await image.getBuffer('image/png'));
}

/**
 * @param {Buffer} still
 * @param {number} secondFrame
 */
async function apng(still, secondFrame) {
    const extract = (await import('png-chunks-extract')).default;
    const encode = (await import('../src/png/encode.js')).default;
    const chunks = extract(new Uint8Array(still));
    const be = (/** @type {number[]} */ ...values) => {
        const out = Buffer.alloc(values.length * 4);
        values.forEach((v, i) => out.writeUInt32BE(v, i * 4));
        return out;
    };
    const fctl = (/** @type {number} */ seq) => ({ name: 'fcTL', data: new Uint8Array(Buffer.concat([be(seq, 300, 300, 0, 0), Buffer.from([0, 1, 0, 10, 0, 0])])) });
    const ihdr = chunks.findIndex(c => c.name === 'IHDR');
    const idat = chunks.findIndex(c => c.name === 'IDAT');
    const frames = [
        ...chunks.slice(0, ihdr + 1),
        { name: 'acTL', data: new Uint8Array(be(2, 0)) },
        ...chunks.slice(ihdr + 1, idat),
        fctl(0),
        ...chunks.filter(c => c.name === 'IDAT'),
        fctl(1),
        { name: 'fdAT', data: new Uint8Array(Buffer.concat([be(2), zlib.deflateSync(Buffer.alloc(16, secondFrame))])) },
        ...chunks.filter(c => c.name === 'IEND'),
    ];
    return Buffer.from(encode(frames));
}

/**
 * @param {string} url
 */
async function get(url) {
    const response = await fetch(`${baseUrl}${url}`, { redirect: 'manual' });
    return { status: response.status, type: response.headers.get('content-type'), cache: response.headers.get('cache-control'), bytes: Buffer.from(await response.arrayBuffer()) };
}

/**
 * @param {string} url
 * @param {object} [body]
 */
async function post(url, body = {}) {
    return fetch(`${baseUrl}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
    await import('../src/fetch-patch.js');
    process.chdir(path.resolve(originalCwd, '..'));
    fixture = await import('./converted-user.fixture.js');
    identity = await import('../src/image-identity.js');
    urls = await import('../src/thumbnail-urls.js');
    images = await import('../src/image-entities.js');
    codes = await import('../src/library-codes.js');
    thumbnails = await import('../src/endpoints/thumbnails.js');
    refs = await import('../src/avatar-refs.js');
    png = await solidPng(200, 40, 40);

    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/chats', (await import('../src/endpoints/chats.js')).router);
    app.use('/thumbnail', thumbnails.router);
    app.use('/api/avatars', (await import('../src/endpoints/avatars.js')).router);
    app.use('/api/characters', (await import('../src/endpoints/characters.js')).router);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    process.chdir(originalCwd);
});

beforeEach(async () => {
    user = await fixture.emptyUser('st-thumbnails-test-');
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(() => user.close());

/**
 * @param {string} avatar
 * @param {Buffer} image
 */
async function seedCharacter(avatar, image) {
    const name = avatar.replace(/\.png$/, '');
    fs.writeFileSync(path.join(user.directories.characters, avatar), image);
    await user.store.lib.writeCard(user.directories, avatar, JSON.stringify({ name, data: { name, extensions: {} } }), { avatarIdentityHash: identity.stillHash(image) });
}

describe('an image\'s identity', () => {
    test('two APNGs with the same first frame have the same still and different animations', async () => {
        const a = await apng(png, 1);
        const b = await apng(png, 2);
        expect(identity.isAnimatedImage(a)).toBe(true);
        expect(identity.stillHash(a)).toBe(identity.stillHash(b));
        expect(identity.stillHash(a)).toBe(identity.stillHash(png));
        expect(identity.animatedHash(a)).not.toBe(identity.animatedHash(b));
        expect(identity.animatedHash(png)).toBeNull();
    });

    test('a card\'s text in a PNG doesn\'t change its still', async () => {
        const { write } = await import('../src/character-card-parser.js');
        expect(identity.stillHash(write(png, JSON.stringify({ name: 'x' })))).toBe(identity.stillHash(png));
    });

    test('a thumbnail name parses back to its hash and spec, and an unknown spec names nothing', () => {
        const hex = 'a'.repeat(64);
        expect(urls.parseThumbnailUrl(urls.stillUrl(hex, 'avatar'))).toEqual({ hex, which: codes.HASH.avatarIdentity, spec: urls.THUMBNAIL_SPECS.avatar });
        expect(urls.parseThumbnailUrl(urls.animatedUrl(hex))).toEqual({ hex, which: codes.HASH.animated, spec: null });
        expect(urls.parseThumbnailName(`${hex}.c1x1.webp`)).toBeNull();
        expect(urls.parseThumbnailName('../x.webp')).toBeNull();
    });
});

describe('GET /thumbnail/<hash>.<spec>.webp', () => {
    test('a character\'s thumbnail is its image at the avatar spec, WebP, cached for good, with no redirect', async () => {
        await seedCharacter('Alice.png', png);
        const character = await (await post('/api/characters/get', { avatar_url: 'Alice.png' })).json();
        expect(character.thumbnail).toBe(urls.stillUrl(identity.stillHash(png), 'avatar'));

        const first = await get(character.thumbnail);
        expect(first.status).toBe(200);
        expect(first.type).toBe('image/webp');
        expect(first.cache).toBe('public, max-age=31536000, immutable');
        const { Jimp } = await import('../src/jimp.js');
        const shown = await Jimp.read(first.bytes);
        expect([shown.bitmap.width, shown.bitmap.height]).toEqual([120, 180]);
        const name = path.basename(character.thumbnail);
        expect(fs.existsSync(path.join(user.directories.thumbnails, name))).toBe(true);
        expect((await get(character.thumbnail)).bytes.equals(first.bytes)).toBe(true);
    });

    test('an APNG character\'s thumbnail is a still of its first frame', async () => {
        await seedCharacter('Moving.png', await apng(png, 3));
        const character = await (await post('/api/characters/get', { avatar_url: 'Moving.png' })).json();
        expect(character.thumbnail).toBe(urls.stillUrl(identity.stillHash(png), 'avatar'));
        const shown = await get(character.thumbnail);
        expect([shown.status, shown.type]).toEqual([200, 'image/webp']);
    });

    test('a background\'s thumbnail keeps its aspect within 200px', async () => {
        const wide = await solidPng(10, 10, 200, 1600, 900);
        fs.writeFileSync(path.join(user.directories.backgrounds, 'wide.png'), wide);
        await images.writeBackground(user.store.lib, 'wide.png', wide);
        const [bg] = (await images.imagesOf(user.store.lib, codes.TYPE.background)).map(images.backgroundOf);
        expect(bg.aspect).toBeCloseTo(16 / 9, 3);
        const { Jimp } = await import('../src/jimp.js');
        const shown = await Jimp.read((await get(/** @type {string} */ (bg.thumbnail))).bytes);
        expect([shown.bitmap.width, shown.bitmap.height]).toEqual([200, 113]);
    });

    test('a hash no image has now is a 404, and nothing is cached for it', async () => {
        await seedCharacter('Alice.png', png);
        const changed = await solidPng(1, 2, 3);
        fs.writeFileSync(path.join(user.directories.characters, 'Alice.png'), changed);
        const url = urls.stillUrl(identity.stillHash(png), 'avatar');
        expect((await get(url)).status).toBe(404);
        expect(fs.existsSync(path.join(user.directories.thumbnails, path.basename(url)))).toBe(false);
        expect((await get('/thumbnail?type=avatar&file=Alice.png')).status).toBe(404);
    });

    test('an animated background\'s still is its first frame, and its animation is its own bytes at a URL of every frame', async () => {
        const a = await apng(png, 1);
        const b = await apng(png, 2);
        for (const [file, image] of /** @type {[string, Buffer][]} */ ([['a.png', a], ['b.png', b]])) {
            fs.writeFileSync(path.join(user.directories.backgrounds, file), image);
            await images.writeBackground(user.store.lib, file, image);
        }
        const [bgA, bgB] = (await images.imagesOf(user.store.lib, codes.TYPE.background)).map(images.backgroundOf);
        expect(bgA.animated && bgB.animated).toBe(true);
        expect(bgA.thumbnail).toBe(bgB.thumbnail);
        expect(bgA.original).not.toBe(bgB.original);
        const original = await get(/** @type {string} */ (bgB.original));
        expect(original.status).toBe(200);
        expect(original.bytes.equals(b)).toBe(true);
        expect((await get(/** @type {string} */ (bgA.thumbnail))).type).toBe('image/webp');
    });
});

describe('the thumbnail folder', () => {
    test('past its size, the least recently shown thumbnails go first', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-thumbnail-cache-'));
        try {
            const at = Date.now() / 1000;
            for (const [i, name] of ['old', 'mid', 'new'].entries()) {
                fs.writeFileSync(path.join(dir, name), Buffer.alloc(100));
                fs.utimesSync(path.join(dir, name), at + i, at + i);
            }
            expect(await thumbnails.accountCache(dir, 100, 250)).toBe(200);
            expect(fs.readdirSync(dir).sort()).toEqual(['mid', 'new']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('persona images', () => {
    test('are listed from the store with their thumbnails, and leave it when deleted', async () => {
        fs.writeFileSync(path.join(user.directories.avatars, 'me.png'), png);
        await images.writePersonaImage(user.store.lib, 'me.png', png);
        const listed = await (await post('/api/avatars/get')).json();
        expect(listed).toEqual({ avatars: ['me.png'], thumbnails: { 'me.png': urls.stillUrl(identity.stillHash(png), 'avatar') }, refs: { 'me.png': '/thumbnail?type=persona&file=me.png' } });
        expect((await get(listed.thumbnails['me.png'])).status).toBe(200);
        expect((await post('/api/avatars/delete', { avatar: 'me.png' })).status).toBe(200);
        expect(await (await post('/api/avatars/get')).json()).toEqual({ avatars: [], thumbnails: {}, refs: {} });
    });
});

describe('an upstream data directory\'s images', () => {
    test('come into the store, backgrounds with the folders upstream kept them in', async () => {
        fs.writeFileSync(path.join(user.directories.backgrounds, 'room.png'), png);
        fs.writeFileSync(path.join(user.directories.avatars, 'user-default.png'), png);
        fs.writeFileSync(path.join(user.directories.backgrounds, 'notes.txt'), 'not an image');
        const meta = path.join(user.root, 'image-metadata', 'images', 'backgrounds');
        fs.mkdirSync(meta, { recursive: true });
        fs.writeFileSync(path.join(meta, 'room.png.json'), JSON.stringify({ folderIds: ['f1'] }));

        const report = await images.importImageFiles(user.store.lib, user.directories);
        expect(report).toEqual({ backgrounds: 1, personas: 1, failed: [] });
        const [room] = (await images.imagesOf(user.store.lib, codes.TYPE.background)).map(images.backgroundOf);
        expect(room).toMatchObject({ file: 'room.png', folders: ['f1'], animated: false, thumbnail: urls.stillUrl(identity.stillHash(png), 'bg') });
        expect(await images.importImageFiles(user.store.lib, user.directories)).toEqual({ backgrounds: 0, personas: 0, failed: [] });
    });
});

describe('a message\'s avatar', () => {
    const ref = '/thumbnail?type=avatar&file=Bob%20B.png';

    /** @param {Record<string, any>} message */
    async function importOne(message) {
        await seedCharacter('Alice.png', png);
        const [tree] = await user.store.people.trees([{ avatar: 'Alice.png' }]);
        const speaker = (await user.store.people.byAvatar(['Alice.png'])).get('Alice.png') ?? null;
        const imported = await user.store.chats.importChat({
            tree, treeSpeaker: speaker, name: 'upstream', messages: [message],
            actor: { user: 'u', session: (await import('../src/chat-engine.js')).newSessionKey() },
        });
        expect(imported.ok).toBe(true);
        const raw = async () => {
            const all = [];
            for await (const batch of user.store.chats.treeMessages(/** @type {bigint} */ (tree), 64)) all.push(...batch);
            return [...(await user.store.chats.stored(all)).values()];
        };
        const readBack = async () => {
            const [stored] = await raw();
            const [message] = await user.store.chats.decoded([stored]);
            return { ...message, node_id: (await user.store.chats.externalIds([stored.id]))[0] };
        };
        const rawText = async () => JSON.stringify(await raw(), (_k, v) => (typeof v === 'bigint' ? String(v) : v));
        return { tree, speaker, readBack, rawText };
    }

    test('stays the reference it was given, and the thumbnail it shows comes beside it and follows the image', async () => {
        await seedCharacter('Bob B.png', png);
        const { readBack } = await importOne({ name: 'Bob', is_user: false, mes: 'hi', send_date: 1, force_avatar: ref, extra: {} });
        expect(await readBack()).toMatchObject({ force_avatar: ref, force_avatar_url: urls.stillUrl(identity.stillHash(png), 'avatar') });
        const next = await solidPng(5, 200, 5);
        await seedCharacter('Bob B.png', next);
        expect(await readBack()).toMatchObject({ force_avatar: ref, force_avatar_url: urls.stillUrl(identity.stillHash(next), 'avatar') });
    });

    test('a reference to nothing shows the default image', async () => {
        const shown = await refs.resolveAvatars(user.store.lib.store, [{ force_avatar: '/thumbnail?type=avatar&file=Gone.png' }, { force_avatar: '/thumbnail?type=persona&file=gone.png' }, { force_avatar: 'img/five.png' }]);
        expect(shown.map(m => [m.force_avatar, m.force_avatar_url])).toEqual([
            ['/thumbnail?type=avatar&file=Gone.png', 'img/ai4.png'],
            ['/thumbnail?type=persona&file=gone.png', 'img/user-default.png'],
            ['img/five.png', undefined],
        ]);
    });

    test('edited and saved as read back, it keeps its reference byte for byte', async () => {
        await seedCharacter('Bob B.png', png);
        const { tree, speaker, readBack, rawText } = await importOne({ name: 'Bob', is_user: false, mes: 'hi', send_date: 1, force_avatar: ref, extra: {} });
        const shown = await readBack();
        const edited = await user.store.chats.editMessages({
            tree, treeSpeaker: speaker, edits: [{ node_id: shown.node_id, content: { ...shown, mes: 'hello' } }],
            actor: { user: 'u', session: (await import('../src/chat-engine.js')).newSessionKey() },
        });
        expect(edited).toMatchObject({ ok: true, applied: 1, refused: [] });
        const after = await readBack();
        expect(after.mes).toBe('hello');
        expect(after.force_avatar).toBe(ref);
        const stored = await rawText();
        expect(stored.includes(ref)).toBe(true);
        expect(stored.includes('force_avatar_url')).toBe(false);
        expect(stored.includes('/thumbnail/')).toBe(false);
    });

    test('a thumbnail URL sent as force_avatar is refused when it would be stored, never mapped back', async () => {
        await seedCharacter('Bob B.png', png);
        const { readBack, rawText } = await importOne({ name: 'Bob', is_user: false, mes: 'hi', send_date: 1, force_avatar: ref, extra: {} });
        const shown = await readBack();
        const edit = (/** @type {Record<string, any>} */ content) => post('/api/chats/message/edit', { avatar_url: 'Alice.png', node_id: shown.node_id, content });
        expect((await edit({ ...shown, mes: 'changed', force_avatar: shown.force_avatar_url })).ok).toBe(false);
        expect((await edit({ ...shown, mes: 'changed', force_avatar: urls.animatedUrl('b'.repeat(64)) })).ok).toBe(false);
        expect((await readBack()).mes).toBe('hi');
        expect((await edit({ ...shown, mes: 'changed' })).status).toBe(200);
        expect(await readBack()).toMatchObject({ mes: 'changed', force_avatar: ref });
        expect((await rawText()).includes('/thumbnail/')).toBe(false);
        expect(() => refs.withoutShownAvatar({ force_avatar: shown.force_avatar_url })).toThrow(refs.ShownAvatarError);
    });
});

describe('the cutover', () => {
    test('gives every image its entity and hash, then drops the thumbnails kept by file name; the store refuses to open before', async () => {
        const stores = await import('../src/user-stores.js');
        fs.writeFileSync(path.join(user.directories.characters, 'Old.png'), png);
        await user.store.lib.writeCard(user.directories, 'Old.png', JSON.stringify({ name: 'Old', data: { name: 'Old', extensions: {} } }));
        fs.writeFileSync(path.join(user.directories.backgrounds, 'room.png'), png);
        fs.writeFileSync(path.join(user.directories.avatars, 'me.png'), png);
        for (const d of stores.NAMED_THUMBNAILS) fs.mkdirSync(path.join(user.root, d), { recursive: true });
        await stores.closeUserStores();
        await expect(stores.userStore(user.directories, 'u')).rejects.toThrow(/image-entities\.js --apply/);

        const { runMigration } = await import('../src/migrations/image-entities.js');
        const engine = (await import('../engine/load.js')).loadEngine().binding;
        const lines = [];
        const run = (/** @type {boolean} */ apply) => runMigration({ dataRoot: user.dataRoot, handle: 'u', apply, engine: async () => engine, probeServer: async () => ({ running: false, lines: [] }), log: l => lines.push(l), warn: l => lines.push(l) });
        expect(await run(false)).toBe(0);
        expect(stores.NAMED_THUMBNAILS.every(d => fs.existsSync(path.join(user.root, d)))).toBe(true);
        expect(await run(true)).toBe(0);
        expect(stores.NAMED_THUMBNAILS.some(d => fs.existsSync(path.join(user.root, d)))).toBe(false);

        user.store = await stores.userStore(user.directories, 'u');
        const old = await user.store.lib.entity(codes.TYPE.character, 'Old.png');
        expect(urls.thumbnailOf(old, 'avatar')).toBe(urls.stillUrl(identity.stillHash(png), 'avatar'));
        expect((await user.store.lib.ids(codes.TYPE.background, ['room.png']))[0]).not.toBeNull();
        expect((await user.store.lib.ids(codes.TYPE.personaImage, ['me.png']))[0]).not.toBeNull();
        expect(await run(true)).toBe(0);
    });
});
