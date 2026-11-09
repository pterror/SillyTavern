import assert from 'node:assert/strict';
import { test } from 'node:test';

import PNGtext from 'png-chunk-text';
import encode from '../png/encode.js';
import { worldFromFile } from './world-files.js';

const json = (/** @type {unknown} */ value) => Buffer.from(JSON.stringify(value));

/**
 * @param {Record<string, unknown>} result
 * @returns {Record<string, Record<string, any>>}
 */
function entriesOf(result) {
    if (!('world' in result)) throw new Error(`no world: ${JSON.stringify(result)}`);
    return /** @type {any} */ (result.world).entries;
}

const NOVEL = {
    lorebookVersion: 5,
    entries: [
        { displayName: 'Ilse Varro', text: 'Keeper of the lamp.', keys: ['Ilse', 'Varro'], enabled: true, forceActivation: false, contextConfig: { budgetPriority: 400 } },
        { displayName: 'The Pale Choir', text: 'A choir that sings at night.', keys: ['choir'], enabled: false, forceActivation: true, contextConfig: {} },
    ],
};

test('a NovelAI lorebook: titles, texts and keys, enabled, always in, and its priority as the order, in its own order', () => {
    const entries = entriesOf(worldFromFile(json(NOVEL)));
    assert.deepEqual(Object.keys(entries), ['0', '1']);
    assert.deepEqual(
        [entries[0].comment, entries[0].content, entries[0].key, entries[0].disable, entries[0].constant, entries[0].order, entries[0].displayIndex],
        ['Ilse Varro', 'Keeper of the lamp.', ['Ilse', 'Varro'], false, false, 400, 0],
    );
    assert.deepEqual([entries[1].disable, entries[1].constant, entries[1].order, entries[1].displayIndex], [true, true, 100, 1]);
    assert.equal(entries[1].depth, 4, 'fields the book has no word for stay at their defaults');
});

test('upstream\'s PNG with a world in it holds a NovelAI lorebook in its text chunk', () => {
    const text = PNGtext.encode('naidata', Buffer.from(JSON.stringify(NOVEL)).toString('base64'));
    const png = Buffer.from(encode([{ name: 'IHDR', data: new Uint8Array(13) }, text, { name: 'IEND', data: new Uint8Array(0) }]));
    assert.deepEqual(entriesOf(worldFromFile(png))[0].key, ['Ilse', 'Varro']);
    const plain = Buffer.from(encode([{ name: 'IHDR', data: new Uint8Array(13) }, { name: 'IEND', data: new Uint8Array(0) }]));
    assert.deepEqual(worldFromFile(plain), { refused: 'This picture has no world in it.' });
});

test('an Agnai memory book: names, entries, keywords, enabled, and its weight as the order', () => {
    const entries = entriesOf(worldFromFile(json({
        kind: 'memory',
        name: 'Saltmarrow',
        entries: [{ name: 'Lantern House', entry: 'An inn by the harbour.', keywords: ['lantern', 'inn'], priority: 5, weight: 30, enabled: false }],
    })));
    assert.deepEqual(
        [entries[0].comment, entries[0].content, entries[0].key, entries[0].disable, entries[0].order],
        ['Lantern House', 'An inn by the harbour.', ['lantern', 'inn'], true, 30],
    );
});

test('a Risu lorebook: comma-separated keys, a regular expression, always active, both keys, its order and chance; folders hold no lore', () => {
    const entries = entriesOf(worldFromFile(json({
        type: 'risu',
        ver: 1,
        data: [
            { key: 'Ilse, Varro ,', secondkey: 'lamp', comment: 'Ilse', content: 'Keeper.', mode: 'normal', insertorder: 120, alwaysActive: false, selective: true, useRegex: false, activationPercent: 40 },
            { key: 'folder-1', comment: 'People', content: '', mode: 'folder' },
            { key: 'cho(ir|rus)', secondkey: '', comment: 'Choir', content: 'Sings.', mode: 'normal', insertorder: 100, alwaysActive: true, selective: false, useRegex: true },
        ],
    })));
    assert.deepEqual(Object.keys(entries), ['0', '1']);
    assert.deepEqual(
        [entries[0].key, entries[0].keysecondary, entries[0].selective, entries[0].order, entries[0].probability, entries[0].useProbability],
        [['Ilse', 'Varro'], ['lamp'], true, 120, 40, true],
    );
    assert.deepEqual([entries[1].key, entries[1].keysecondary, entries[1].constant, entries[1].probability], [['/cho(ir|rus)/'], [], true, 100]);
});

test('upstream\'s world file is taken as it is; anything else is no world', () => {
    const file = { entries: { 3: { uid: 3, key: ['Ilse'], content: 'Keeper.' } }, relationKinds: [{ id: 1, name: 'in' }] };
    assert.deepEqual(worldFromFile(Buffer.concat([Buffer.from('﻿'), json(file)])), { world: file });
    const refused = { refused: 'This file isn\'t a world: it holds no entries SillyTavern, NovelAI, Agnai or Risu can make.' };
    assert.deepEqual(worldFromFile(Buffer.from('not json')), refused);
    assert.deepEqual(worldFromFile(json({ entries: [] })), refused);
    assert.deepEqual(worldFromFile(json([1, 2])), refused);
});
