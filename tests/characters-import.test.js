import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { Buffer } from 'node:buffer';

const originalCwd = process.cwd();
afterAll(() => process.chdir(originalCwd));

/** @type {import('express').Router} */
let router;
/** @type {Awaited<ReturnType<typeof import('./converted-user.fixture.js').emptyUser>>} */
let user;
/** @type {typeof import('../src/character-avatars.js')} */
let avatars;
let TYPE;
let HASH;

async function characterCount() {
    const res = await fetch(`${baseUrl}/api/characters/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ want: ['total'] }) });
    return (await res.json()).total;
}
/** @type {import('node:http').Server} */
let server;
let baseUrl;

/** @type {import('../src/users.js').UserDirectoryList} */
let directories;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../src/util.js');
    setConfigFilePath(path.join(originalCwd, '..', 'default', 'config.yaml'));

    ({ router } = await import('../src/endpoints/characters.js'));
    avatars = await import('../src/character-avatars.js');
    ({ TYPE } = await import('../src/library-codes.js'));
    ({ HASH } = await import('../src/library-engine.js'));

    process.chdir(path.resolve(originalCwd, '..'));

    const express = (await import('express')).default;
    const multer = (await import('multer')).default;
    const app = express();

    const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-characters-import-test-uploads-'));
    app.use(multer({ dest: uploadsDir }).single('avatar'));
    app.use(express.json());
    app.use((req, res, next) => {
        req.user = user.user;
        next();
    });
    app.use('/api/characters', router);
    const { sendPngWithoutText } = await import('../src/png-text-strip.js');
    app.get('/avatar/:avatar', async (req, res) => sendPngWithoutText(req, res, /** @type {string} */ (await avatars.avatarPathOf(user.store.lib, directories, req.params.avatar))));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise(resolve => server.close(resolve)));

beforeEach(async () => {
    user = await (await import('./converted-user.fixture.js')).emptyUser('st-characters-import-test-');
    ({ directories } = user);
    globalThis.DATA_ROOT = user.dataRoot;
});

afterEach(() => user.close());

/**
 * @param {object} [overrides]
 * @returns {Promise<Response>}
 */
async function importJsonCharacter(overrides = {}) {
    const body = JSON.stringify({ name: 'Ghost', description: 'A test character', ...overrides });
    const formData = new FormData();
    formData.append('avatar', new Blob([body], { type: 'application/json' }), 'ghost.json');
    formData.append('file_type', 'json');

    return fetch(`${baseUrl}/api/characters/import`, {
        method: 'POST',
        body: formData,
    });
}

describe('POST /api/characters/import', () => {
    test('a successful import returns the character payload alongside file_name', async () => {
        const response = await importJsonCharacter();
        expect(response.status).toBe(200);
        const data = await response.json();

        expect(typeof data.file_name).toBe('string');
        expect(data.duplicate).toBeUndefined();
        expect(data.character).toBeDefined();
        expect(data.character.avatar).toBe(`${data.file_name}.png`);
        expect(data.character.name).toBe('Ghost');
    });

    test('records a content_hash for the imported character', async () => {
        const response = await importJsonCharacter();
        const data = await response.json();

        const e = await user.store.lib.entity(TYPE.character, `${data.file_name}.png`);
        const contentHash = e.hashes.find(h => h.which === HASH.content)?.hash.toString('hex');
        expect(contentHash).toEqual(expect.any(String));
        expect(contentHash.length).toBe(64);
    });

    test('exact byte-identical dedup: importing the same bytes twice skips the second one', async () => {
        const first = await importJsonCharacter();
        const firstData = await first.json();
        expect(firstData.duplicate).toBeUndefined();

        const second = await importJsonCharacter();
        const secondData = await second.json();

        expect(secondData.duplicate).toBe(true);
        expect(secondData.duplicate_of).toBe(`${firstData.file_name}.png`);
        expect(secondData.file_name).toBeUndefined();

        expect(await characterCount()).toBe(1);
    });

    test('different content is never treated as a duplicate', async () => {
        const first = await importJsonCharacter({ name: 'Ghost' });
        const firstData = await first.json();
        expect(firstData.duplicate).toBeUndefined();

        const second = await importJsonCharacter({ name: 'Different Ghost' });
        const secondData = await second.json();

        expect(secondData.duplicate).toBeUndefined();
        expect(secondData.file_name).not.toBe(firstData.file_name);

        expect(await characterCount()).toBe(2);
    });

    test('in-batch dedup: two identical files uploaded back to back while batch-import mode is active still dedupe (pending buffer, not yet flushed)', async () => {
        const beginResponse = await fetch(`${baseUrl}/api/characters/metadata/batch-import/begin`, { method: 'POST' });
        expect(beginResponse.status).toBe(204);

        try {
            const first = await importJsonCharacter();
            const firstData = await first.json();
            expect(firstData.duplicate).toBeUndefined();

            const second = await importJsonCharacter();
            const secondData = await second.json();
            expect(secondData.duplicate).toBe(true);
            expect(secondData.duplicate_of).toBe(`${firstData.file_name}.png`);
        } finally {
            const endResponse = await fetch(`${baseUrl}/api/characters/metadata/batch-import/end`, { method: 'POST' });
            expect(endResponse.status).toBe(204);
        }

        expect(await characterCount()).toBe(1);
    });

    test('a preserved_name replace bypasses dedup even if the bytes match another character', async () => {
        const first = await importJsonCharacter();
        const firstData = await first.json();

        const second = await importJsonCharacter({ name: 'Replace Target' });
        const secondData = await second.json();
        expect(secondData.file_name).not.toBe(firstData.file_name);

        const body = JSON.stringify({ name: 'Ghost', description: 'A test character' });
        const formData = new FormData();
        formData.append('avatar', new Blob([body], { type: 'application/json' }), 'ghost.json');
        formData.append('file_type', 'json');
        formData.append('preserved_name', `${secondData.file_name}.png`);

        const replaceResponse = await fetch(`${baseUrl}/api/characters/import`, { method: 'POST', body: formData });
        const replaceData = await replaceResponse.json();

        expect(replaceData.duplicate).toBeUndefined();
        expect(replaceData.file_name).toBe(secondData.file_name);
        expect(replaceData.character.name).toBe('Ghost');
    });

    test('a preserved_name replace still records the NEW content_hash, not the old one', async () => {
        const first = await importJsonCharacter({ name: 'Original' });
        const firstData = await first.json();

        const body = JSON.stringify({ name: 'Replaced', description: 'new bytes' });
        const formData = new FormData();
        formData.append('avatar', new Blob([body], { type: 'application/json' }), 'ghost.json');
        formData.append('file_type', 'json');
        formData.append('preserved_name', `${firstData.file_name}.png`);
        await fetch(`${baseUrl}/api/characters/import`, { method: 'POST', body: formData });

        const e = await user.store.lib.entity(TYPE.character, `${firstData.file_name}.png`);
        const originalRow = await user.store.lib.findByHash(HASH.content, e.hashes.find(h => h.which === HASH.content)?.hash.toString('hex') ?? null);
        expect(originalRow).toBe(`${firstData.file_name}.png`);

        const duplicateCheck = await importJsonCharacter({ name: 'Replaced', description: 'new bytes' });
        const duplicateCheckData = await duplicateCheck.json();
        expect(duplicateCheckData.duplicate).toBe(true);
        expect(duplicateCheckData.duplicate_of).toBe(`${firstData.file_name}.png`);
    });
});

describe('POST /api/characters/import - duplicate greetings', () => {
    test('a card repeating a greeting keeps the first of each and reports the copies dropped', async () => {
        const response = await importJsonCharacter({
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: { name: 'Ghost', first_mes: 'Hello there', alternate_greetings: ['Same', 'Same', 'Other', 'Same'] },
        });
        const data = await response.json();

        expect(data.dropped_greetings).toEqual(['Same', 'Same']);
        expect(data.character.data.first_mes).toBe('Hello there');
        const [card] = await user.store.lib.cards([`${data.file_name}.png`]);
        expect(card.data.alternate_greetings).toEqual(['Same', 'Other']);
    });

    test('the report shortens a long greeting to an excerpt', async () => {
        const long = 'A long greeting that goes on and on and on, well past the excerpt';
        const data = await (await importJsonCharacter({
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: { name: 'Ghost', first_mes: long, alternate_greetings: [long] },
        })).json();

        expect(data.dropped_greetings).toEqual(['A long greeting that goes on and on and…']);
    });

    test('a card without repeated greetings reports nothing', async () => {
        const data = await (await importJsonCharacter({
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: { name: 'Ghost', first_mes: 'Hi', alternate_greetings: ['Hey'] },
        })).json();

        expect(data.dropped_greetings).toBeUndefined();
    });
});

describe('POST /api/characters/import - fav/chat no longer written to the card (metadata store is authoritative)', () => {
    test('a v2-json import never writes fav/data.extensions.fav/chat into the stored card', async () => {
        const body = JSON.stringify({
            spec: 'chara_card_v2', spec_version: '2.0', name: 'Ghost',
            fav: true, chat: 'some incoming chat pointer',
            data: { name: 'Ghost', extensions: { fav: true } },
        });
        const formData = new FormData();
        formData.append('avatar', new Blob([body], { type: 'application/json' }), 'ghost.json');
        formData.append('file_type', 'json');
        const response = await fetch(`${baseUrl}/api/characters/import`, { method: 'POST', body: formData });
        const data = await response.json();

        const storedJson = (await user.store.lib.cards([`${data.file_name}.png`]))[0];

        expect('fav' in storedJson).toBe(false);
        expect('chat' in storedJson).toBe(false);
        expect(storedJson.data && 'fav' in storedJson.data.extensions).toBe(false);
    });

    test('a v1-json import never writes fav/chat into the stored card', async () => {
        const response = await importJsonCharacter({ name: 'V1 Ghost', fav: true });
        const data = await response.json();

        const storedJson = (await user.store.lib.cards([`${data.file_name}.png`]))[0];

        expect('fav' in storedJson).toBe(false);
        expect('chat' in storedJson).toBe(false);
        expect('fav' in storedJson.data.extensions).toBe(false);
    });
});

describe('POST /api/characters/import - PNG import no longer re-encodes the avatar image', () => {
    /** @type {typeof import('../src/character-card-parser.js').write} */
    let writeCard;

    const BLANK_PNG = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
    );

    beforeAll(async () => {
        ({ write: writeCard } = await import('../src/character-card-parser.js'));
    });

    test('importing a PNG with no crop keeps the uploaded file exactly; it is sent without its text chunks', async () => {
        const { default: extract } = await import('png-chunks-extract');
        const sourceCard = writeCard(BLANK_PNG, JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', name: 'Ghost', data: { name: 'Ghost' } }));

        const formData = new FormData();
        formData.append('avatar', new Blob([sourceCard], { type: 'image/png' }), 'ghost.png');
        formData.append('file_type', 'png');
        const response = await fetch(`${baseUrl}/api/characters/import`, { method: 'POST', body: formData });
        const data = await response.json();
        expect(data.file_name).toEqual(expect.any(String));

        const stored = fs.readFileSync(/** @type {string} */ (await avatars.avatarPathOf(user.store.lib, directories, `${data.file_name}.png`)));

        expect(stored.equals(sourceCard)).toBe(true);

        const answer = await fetch(`${baseUrl}/avatar/${data.file_name}.png`);
        expect(answer.headers.get('content-type')).toBe('image/png');
        const sent = Buffer.from(await answer.arrayBuffer());
        const sentChunks = extract(new Uint8Array(sent));
        expect(sentChunks.map(c => c.name)).not.toContain('tEXt');
        const imageChunks = extract(new Uint8Array(sourceCard)).filter(c => c.name !== 'tEXt');
        expect(sentChunks.map(c => c.name)).toEqual(imageChunks.map(c => c.name));
        const again = await fetch(`${baseUrl}/avatar/${data.file_name}.png`, { headers: { 'If-None-Match': String(answer.headers.get('etag')), 'Cache-Control': 'max-age=0' } });
        expect(again.status).toBe(304);
    });
});

describe('POST /api/characters/import - a failed import names the file', () => {
    const BLANK_PNG = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
    );

    /**
     * @param {Record<string, string>} [fields]
     * @returns {Promise<Response>}
     */
    function importBlankPng(fields = {}) {
        const formData = new FormData();
        formData.append('avatar', new Blob([BLANK_PNG], { type: 'image/png' }), 'not-a-card.png');
        formData.append('file_type', 'png');
        for (const [key, value] of Object.entries(fields)) formData.append(key, value);
        return fetch(`${baseUrl}/api/characters/import`, { method: 'POST', body: formData });
    }

    test('a plain PNG with no card chunk is a 400 whose error names the uploaded file', async () => {
        const response = await importBlankPng();
        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toBe('Failed to import "not-a-card.png": PNG metadata does not contain any text chunks.');
    });

    test('an upload downloaded from a URL names the URL as well as the file', async () => {
        const response = await importBlankPng({ source_url: 'https://example.com/cards/42' });
        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toBe('Failed to import "https://example.com/cards/42 (not-a-card.png)": PNG metadata does not contain any text chunks.');
    });

    test('an unrecognized JSON shape names the uploaded file', async () => {
        const formData = new FormData();
        formData.append('avatar', new Blob(['{"entries":{}}'], { type: 'application/json' }), 'lorebook.json');
        formData.append('file_type', 'json');
        const response = await fetch(`${baseUrl}/api/characters/import`, { method: 'POST', body: formData });
        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toBe('Failed to import "lorebook.json": not a recognized character card format');
    });
});

describe('unsetPrivateFields is applied on the real import/export routes', () => {
    test('importing a Spec V2 JSON character clears fav and chat even when the uploaded file sets them', async () => {
        const body = JSON.stringify({
            spec: 'chara_card_v2',
            spec_version: '2.0',
            name: 'Wraith',
            data: {
                name: 'Wraith',
                description: 'A test character',
                extensions: { fav: true },
            },
            fav: true,
            chat: 'Wraith - some previous session',
        });
        const formData = new FormData();
        formData.append('avatar', new Blob([body], { type: 'application/json' }), 'wraith.json');
        formData.append('file_type', 'json');

        const response = await fetch(`${baseUrl}/api/characters/import`, { method: 'POST', body: formData });
        expect(response.status).toBe(200);
        const data = await response.json();

        const exportResponse = await fetch(`${baseUrl}/api/characters/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ format: 'json', avatar_url: `${data.file_name}.png` }),
        });
        const exported = await exportResponse.json();

        expect(exported.fav).toBe(false);
        expect(exported.data.extensions.fav).toBe(false);
        expect(exported.chat).toBeUndefined();
        expect(exported.name).toBe('Wraith');
    });

    test('exporting as JSON clears fav and chat on the exported copy without mutating the stored file', async () => {
        const importResponse = await importJsonCharacter({ name: 'Specter', fav: true });
        const importData = await importResponse.json();
        const avatarUrl = `${importData.file_name}.png`;

        const exportResponse = await fetch(`${baseUrl}/api/characters/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ format: 'json', avatar_url: avatarUrl }),
        });
        expect(exportResponse.status).toBe(200);
        const exported = await exportResponse.json();

        expect(exported.fav).toBe(false);
        expect(exported.data.extensions.fav).toBe(false);
        expect(exported.chat).toBeUndefined();
    });
});

describe('POST /api/characters/import - a card whose name sanitizes to empty no longer crashes the import', () => {
    /** @type {typeof import('../src/character-card-parser.js').write} */
    let writeCard;

    const BLANK_PNG = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
    );

    beforeAll(async () => {
        ({ write: writeCard } = await import('../src/character-card-parser.js'));
    });

    test('a v2 PNG card whose data.name is "." (sanitizes to empty, no top-level name) imports instead of throwing', async () => {
        const sourceCard = writeCard(BLANK_PNG, JSON.stringify({
            spec: 'chara_card_v2', spec_version: '2.0',
            data: { name: '.', description: 'A test character' },
        }));

        const formData = new FormData();
        formData.append('avatar', new Blob([sourceCard], { type: 'image/png' }), 'main_-1990c43d7a8e_spec_v2.png');
        formData.append('file_type', 'png');
        const response = await fetch(`${baseUrl}/api/characters/import`, { method: 'POST', body: formData });

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.error).toBeUndefined();
        expect(data.file_name).toEqual(expect.any(String));
        expect(data.character.name).toBe('');
    });

    test('a v2 JSON card whose data.name is "." (sanitizes to empty, no top-level name) imports instead of throwing', async () => {
        const body = JSON.stringify({
            spec: 'chara_card_v2', spec_version: '2.0',
            data: { name: '.', description: 'A test character' },
        });
        const formData = new FormData();
        formData.append('avatar', new Blob([body], { type: 'application/json' }), 'dotname.json');
        formData.append('file_type', 'json');
        const response = await fetch(`${baseUrl}/api/characters/import`, { method: 'POST', body: formData });

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.error).toBeUndefined();
        expect(data.file_name).toEqual(expect.any(String));
        expect(data.character.name).toBe('');
    });

    test('a v2 card with no name field anywhere (data.name and top-level name both absent) imports instead of throwing', async () => {
        const body = JSON.stringify({
            spec: 'chara_card_v2', spec_version: '2.0',
            data: { description: 'No name field at all' },
        });
        const formData = new FormData();
        formData.append('avatar', new Blob([body], { type: 'application/json' }), 'noname.json');
        formData.append('file_type', 'json');
        const response = await fetch(`${baseUrl}/api/characters/import`, { method: 'POST', body: formData });

        expect(response.status).toBe(200);
        const data = await response.json();
        expect(data.error).toBeUndefined();
        expect(data.file_name).toEqual(expect.any(String));
        expect(data.character.name).toBe('');
    });
});

describe('POST /api/characters/import - replacing a stored character (preserved_name)', () => {
    /** @type {(image: Buffer, data: string) => Buffer} */
    let writeCard;

    beforeAll(async () => {
        ({ write: writeCard } = await import('../src/character-card-parser.js'));
    });

    /**
     * @param {number} red
     * @returns {Promise<Buffer>} a 1 by 1 PNG of that red
     */
    async function tinyPng(red) {
        const { deflateSync, crc32 } = await import('node:zlib');
        const chunk = (/** @type {string} */ type, /** @type {Buffer} */ data) => {
            const head = Buffer.alloc(4);
            head.writeUInt32BE(data.length);
            const body = Buffer.concat([Buffer.from(type), data]);
            const tail = Buffer.alloc(4);
            tail.writeUInt32BE(crc32(body));
            return Buffer.concat([head, body, tail]);
        };
        const header = Buffer.alloc(13);
        header.writeUInt32BE(1, 0);
        header.writeUInt32BE(1, 4);
        header.set([8, 2, 0, 0, 0], 8);
        return Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, red, 0, 0]))), chunk('IEND', Buffer.alloc(0)),
        ]);
    }

    /**
     * @param {string[]} greetings the first is the default
     * @returns {string}
     */
    function cardWith(greetings) {
        return JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', name: 'Ghost', data: { name: 'Ghost', first_mes: greetings[0] ?? '', alternate_greetings: greetings.slice(1) } });
    }

    /**
     * @param {{ file: Buffer | string, type: 'png' | 'json', name: string }} upload
     * @param {string | null} preserved
     * @returns {Promise<any>}
     */
    async function importCard({ file, type, name }, preserved) {
        const formData = new FormData();
        formData.append('avatar', new Blob([file], { type: type === 'png' ? 'image/png' : 'application/json' }), name);
        formData.append('file_type', type);
        if (preserved !== null) formData.append('preserved_name', preserved);
        const response = await fetch(`${baseUrl}/api/characters/import`, { method: 'POST', body: formData });
        expect(response.status).toBe(200);
        return response.json();
    }

    /** @param {string} avatar */
    const greetingsStored = async avatar => {
        const [card] = await user.store.lib.cards([avatar]);
        return [card.data.first_mes, ...card.data.alternate_greetings].filter(text => text !== '');
    };

    test.each([
        ['more', ['a', 'b', 'c', 'd', 'e']],
        ['different', ['x', 'y', 'z']],
        ['fewer', ['b']],
        ['none', []],
    ])('a card with %s greetings replaces the stored ones, and the character keeps its identity', async (_, greetings) => {
        const first = await importCard({ file: cardWith(['a', 'b', 'c']), type: 'json', name: 'first.json' }, null);
        const avatar = `${first.file_name}.png`;
        const was = await user.store.lib.entity(TYPE.character, avatar);

        const replaced = await importCard({ file: cardWith(greetings), type: 'json', name: 'second.json' }, avatar);

        expect(replaced.file_name).toBe(first.file_name);
        expect(await greetingsStored(avatar)).toEqual(greetings);
        expect(replaced.character.data.alternate_greetings).toEqual(greetings.slice(1));
        expect((await user.store.lib.entity(TYPE.character, avatar))?.id).toBe(was?.id);
        expect(await characterCount()).toBe(1);
    });

    test('a JSON card keeps the picture of the character; a PNG card brings its own', async () => {
        const original = writeCard(await tinyPng(10), cardWith(['a']));
        const first = await importCard({ file: original, type: 'png', name: 'first.png' }, null);
        const avatar = `${first.file_name}.png`;
        const pictureOf = async () => fs.readFileSync(/** @type {string} */ (await avatars.avatarPathOf(user.store.lib, directories, avatar)));
        expect((await pictureOf()).equals(original)).toBe(true);

        await importCard({ file: cardWith(['b']), type: 'json', name: 'second.json' }, avatar);
        expect((await pictureOf()).equals(original)).toBe(true);
        expect(await greetingsStored(avatar)).toEqual(['b']);

        const next = writeCard(await tinyPng(200), cardWith(['c']));
        await importCard({ file: next, type: 'png', name: 'third.png' }, avatar);
        expect((await pictureOf()).equals(next)).toBe(true);
        expect(await greetingsStored(avatar)).toEqual(['c']);
    });

    test('a JSON card for a character that is not stored gets the default picture', async () => {
        const made = await importCard({ file: cardWith(['a']), type: 'json', name: 'new.json' }, 'Missing.png');
        const stored = fs.readFileSync(/** @type {string} */ (await avatars.avatarPathOf(user.store.lib, directories, `${made.file_name}.png`)));
        expect(stored.equals(fs.readFileSync(path.resolve(originalCwd, '..', 'public/img/ai4.png')))).toBe(true);
    });
});
