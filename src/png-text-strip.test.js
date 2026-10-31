import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import encode from './png/encode.js';
import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';

import { stripPngText } from './png-text-strip.js';
import { linkWithAvatar } from './character-avatars.js';

const BLANK_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function cardPng() {
    const chunks = extract(new Uint8Array(BLANK_PNG));
    const text = (/** @type {string} */ keyword, /** @type {string} */ value) => PNGtext.encode(keyword, value);
    const iend = chunks.pop();
    const idat = chunks.pop();
    chunks.push(text('chara', Buffer.from('{"name":"Ghost"}').toString('base64')));
    chunks.push({ name: 'iTXt', data: new Uint8Array(Buffer.from('Comment\0\0\0\0\0an international comment')) });
    chunks.push(idat);
    chunks.push(text('ccv3', Buffer.from('{"name":"Ghost"}').toString('base64')));
    chunks.push({ name: 'zTXt', data: new Uint8Array(Buffer.from('Note\0\0compressed-ish')) });
    chunks.push(iend);
    return Buffer.from(encode(chunks));
}

/**
 * @param {Buffer} input
 * @param {number} size
 */
async function strip(input, size) {
    const pieces = [];
    for (let i = 0; i < input.length; i += size) pieces.push(input.subarray(i, i + size));
    /** @type {Buffer[]} */
    const out = [];
    await pipeline(Readable.from(pieces), stripPngText(), new Writable({ write(chunk, _e, done) { out.push(chunk); done(); } }));
    return Buffer.concat(out);
}

test('a PNG streams through without its text chunks, whatever pieces it arrives in', async () => {
    const card = cardPng();
    const expected = Buffer.from(encode(extract(new Uint8Array(card)).filter(c => !['tEXt', 'iTXt', 'zTXt'].includes(c.name))));
    for (const size of [1, 3, 7, 8, 13, 64, card.length]) {
        assert.ok((await strip(card, size)).equals(expected), `in pieces of ${size}`);
    }
});

test('anything that isn\'t a PNG passes through as it is', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const size of [1, 5, jpeg.length]) assert.ok((await strip(jpeg, size)).equals(jpeg));
});

test('linkWithAvatar: the image is the source\'s bytes in a file of its own; a source changed since it was read stores nothing; a file already in place stays', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-with-avatar-'));
    try {
        const directories = { characters: path.join(dir, 'characters') };
        const lib = /** @type {any} */ ({ serialized: (/** @type {number} */ _lane, /** @type {string} */ _key, /** @type {() => any} */ fn) => fn() });
        const source = path.join(dir, 'source.png');
        fs.writeFileSync(source, cardPng());
        const stat = fs.statSync(source);

        let writes = 0;
        const result = await linkWithAvatar(lib, directories, 'a.png', source, async () => ++writes, { size: stat.size, mtimeMs: stat.mtimeMs });
        assert.equal(result, 1);
        const file = path.join(directories.characters, 'a.png');
        assert.ok(fs.readFileSync(file).equals(fs.readFileSync(source)));
        assert.notEqual(fs.statSync(file).ino, stat.ino);
        assert.equal(fs.statSync(file).nlink, 1);

        assert.equal(await linkWithAvatar(lib, directories, 'b.png', source, async () => ++writes, { size: stat.size + 1, mtimeMs: stat.mtimeMs }), null);
        assert.equal(writes, 1);
        assert.deepEqual(fs.readdirSync(directories.characters), ['a.png']);

        const before = fs.statSync(file);
        assert.equal(await linkWithAvatar(lib, directories, 'a.png', file, async () => ++writes), 2);
        assert.equal(fs.statSync(file).ino, before.ino);
        assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
