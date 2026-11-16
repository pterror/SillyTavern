import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { setConfigFilePath } from '../util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
setConfigFilePath(path.join(__dirname, '..', '..', 'config.yaml'));

const { serializeQueryHashesBinary } = await import('./characters.js');
const { deserializeQueryHashesBinary } = await import('../../public/scripts/query-hashes-binary.js');

const row = { id: 'Ilse.png', isGroup: false, version: 3, tagIdsHash: 7, date_added: 1, create_date: null, date_last_chat: 0, chat_size: 0, data_size: 0, chat: 'Ilse - 1' };
const looks = { styles: { a1: { layers: { rest: [{ property: 'color', value: 'teal' }] }, picture: { before: false, after: false, crop: null, image: null }, note: 'the "heir" ✦', fonts: [] } }, things: { 41: 'a1' } };

/** @param {Buffer} buffer */
const read = buffer => deserializeQueryHashesBinary(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));

test('a list page\'s hashes carry its names\' looks after everything else, and a page asked without them carries none', () => {
    const base = { seq: 5, token: 'l9', total: 1, approxTotal: false, hashRows: [row], hidden: 2, cursor: 'c', favHashRows: [row] };
    const withLooks = read(serializeQueryHashesBinary({ ...base, looks }));
    assert.deepEqual(withLooks.looks, looks);
    assert.equal(withLooks.hashRows[0].id, 'Ilse.png');
    assert.equal(withLooks.favHashRows?.[0].chat, 'Ilse - 1');
    assert.equal(withLooks.hidden, 2);
    assert.equal(read(serializeQueryHashesBinary(base)).looks, undefined);
});

test('a folder list\'s page carries its folder rows, the page\'s first, beside its hash rows', () => {
    const leadRows = [{ id: 'f1', name: 'Vault ✦', thing: '12', count: 3, countApprox: true }, { id: 'none' }];
    const base = { seq: 5, token: 'l9', total: 3, approxTotal: false, hashRows: [row], cursor: 'c' };
    const page = read(serializeQueryHashesBinary({ ...base, looks, leadRows }));
    assert.deepEqual(page.leadRows, leadRows);
    assert.deepEqual(page.looks, looks);
    assert.equal(page.hashRows[0].id, 'Ilse.png');
    assert.deepEqual(read(serializeQueryHashesBinary(base)).leadRows, []);
});
