import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadEngine } from '../../engine/load.js';
import { LibraryEngine, cardParts } from '../library-engine.js';
import { STATEMENT_PREFIX, TYPE } from '../library-codes.js';
import { readCatalog, readDraft, writeDrafts } from './model-store.js';
import { presetFromUpstream } from './sampler-presets.js';
import { profilesFromUpstream } from './connection-catalogs.js';
import { regexPresetsFromUpstream } from './regex.js';
import { quickReplySetFromUpstream } from './quick-replies.js';
import { draft } from './entity-draft.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-store-test-'));
const CONTENT = path.join(import.meta.dirname, '../../default/content');
/** @type {LibraryEngine[]} */
const opened = [];
after(async () => {
    for (const lib of opened) await lib.close();
    fs.rmSync(root, { recursive: true, force: true });
});

/**
 * @param {string} name
 */
async function open(name) {
    const lib = await LibraryEngine.open(loadEngine().binding, path.join(root, name));
    opened.push(lib);
    return lib;
}

const json = value => JSON.parse(JSON.stringify(value));

test('a chat completion preset with its prompts and orders comes back as it was written', async () => {
    const lib = await open('preset');
    const file = JSON.parse(fs.readFileSync(path.join(CONTENT, 'presets/openai/Default.json'), 'utf8'));
    const { preset } = presetFromUpstream('openai', 'Default', file);
    await writeDrafts(lib, [preset]);
    assert.deepEqual(await readDraft(lib, TYPE.samplerPreset, 'openai:Default'), json(preset));
    const main = await readDraft(lib, TYPE.chatPrompt, 'openai:Default:main');
    assert.ok(main && typeof main.values.content === 'string');
});

test('text and JSON values stay apart; scalar lists keep their order', async () => {
    const lib = await open('values');
    const d = draft(TYPE.samplerPreset, 'textgenerationwebui:T', { a: 'text', b: '"quoted"', c: 1, d: true, e: null, f: { x: [1] } }, { 0: ['6', '0', '1'] });
    await writeDrafts(lib, [d]);
    assert.deepEqual(await readDraft(lib, TYPE.samplerPreset, 'textgenerationwebui:T'), d);
});

test('rewriting replaces what changed: a value, a list, a part gone', async () => {
    const lib = await open('rewrite');
    const prompts = [{ identifier: 'a', content: 'A' }, { identifier: 'b', content: 'B' }, { identifier: 'c', content: 'C' }];
    const first = presetFromUpstream('openai', 'P', { temperature: 1, prompts }).preset;
    await writeDrafts(lib, [first]);
    const second = presetFromUpstream('openai', 'P', { temperature: 0.5, prompts: [prompts[2], { identifier: 'a', content: 'A2' }] }).preset;
    await writeDrafts(lib, [second]);
    assert.deepEqual(await readDraft(lib, TYPE.samplerPreset, 'openai:P'), json(second));
    assert.equal(await readDraft(lib, TYPE.chatPrompt, 'openai:P:b'), null);
});

test('refs are stored as ids: a profile names its connection and bundles, a name naming nothing a placeholder', async () => {
    const lib = await open('refs');
    const connection = draft(TYPE.connection, 'c1', { type: 'openai:claude', model: 'claude-x' });
    const { profiles } = profilesFromUpstream({ profiles: [{ id: 'p1', mode: 'cc', name: 'Claude', api: 'claude', preset: 'Default', proxy: 'Mine', exclude: [] }] }, () => 'c1');
    const ids = await writeDrafts(lib, [connection, ...profiles]);
    const [stored] = await lib.entities([ids.get(`${TYPE.connectionProfile}:p1`)]);
    const connectionValue = stored.values.find(v => v.field === 'connection');
    assert.equal(connectionValue.text, String(ids.get(`${TYPE.connection}:c1`)));
    assert.notEqual((await lib.ids(TYPE.samplerPreset, ['openai:Default']))[0], null);
    assert.notEqual((await lib.ids(TYPE.proxy, ['Mine']))[0], null);
    assert.deepEqual(await readDraft(lib, TYPE.connectionProfile, 'p1'), json(profiles[0]));
});

test('ref lists, and part lists of parts with lists', async () => {
    const lib = await open('lists');
    const { presets } = regexPresetsFromUpstream([{ id: 'rp', name: 'Mine', isSelected: false, global: [{ id: 'r1' }, { id: 'r2' }], scoped: [], preset: [] }], () => 'x');
    const { set } = quickReplySetFromUpstream('Tools', { version: 2, name: 'Tools', qrList: [{ id: 1, label: 'Go', contextList: [{ set: 'Other', isChained: true }] }] });
    await writeDrafts(lib, [...presets, set]);
    assert.deepEqual(await readDraft(lib, TYPE.regexPreset, 'rp'), json(presets[0]));
    assert.deepEqual(await readDraft(lib, TYPE.quickReplySet, 'Tools'), json(set));
});

test('every write keeps its history', async () => {
    const lib = await open('history');
    const d = draft(TYPE.proxy, 'P', { url: 'http://a', password: '' });
    const ids = await writeDrafts(lib, [d]);
    await writeDrafts(lib, [draft(TYPE.proxy, 'P', { url: 'http://b', password: '' })]);
    const id = ids.get(`${TYPE.proxy}:P`);
    const history = await lib.store.worldRead('history', { entity: id, field: 'url', limit: 10 });
    assert.deepEqual(history.changes.map(c => c.kind), ['set', 'set']);
});

test('a catalog reads a page at a time in key order, parts with their holders, a deleted one gone', async () => {
    const lib = await open('catalog');
    const proxies = ['b', 'a', 'c', 'd'].map(name => draft(TYPE.proxy, name, { url: `http://${name}`, password: '' }));
    await writeDrafts(lib, proxies);
    const first = await readCatalog(lib, TYPE.proxy, { limit: 3 });
    assert.deepEqual(first.drafts.map(d => d.key), ['a', 'b', 'c']);
    assert.equal(first.more, true);
    const rest = await readCatalog(lib, TYPE.proxy, { after: 'c', limit: 3 });
    assert.deepEqual([rest.drafts.map(d => d.key), rest.more], [['d'], false]);
    assert.deepEqual(rest.drafts[0], json(proxies[3]));
    await writeDrafts(lib, [presetFromUpstream('openai', 'P', { prompts: [{ identifier: 'x' }, { identifier: 'y' }] }).preset]);
    await writeDrafts(lib, [presetFromUpstream('openai', 'P', { prompts: [{ identifier: 'y' }] }).preset]);
    assert.deepEqual((await readCatalog(lib, TYPE.chatPrompt, { limit: 10 })).drafts.map(d => d.key), ['openai:P:y']);
});

test('a character\'s statements outlive a write of its card, and aren\'t the card\'s', async () => {
    const lib = await open('statements');
    const card = name => JSON.stringify({ name, description: '', personality: '', scenario: '', first_mes: 'Hello.', mes_example: '', spec: 'chara_card_v2', spec_version: '2.0', data: { name, description: '', personality: '', scenario: '', first_mes: 'Hello.', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {} } });
    const { id } = await lib.writeCard({}, 'cara.png', card('Cara'));
    await lib.store.commit([{ kind: 'jsonValue', entity: id, field: `${STATEMENT_PREFIX}personas`, json: '["7"]' }]);
    await lib.writeCard({}, 'cara.png', card('Cara Prime'));
    const [stored] = await lib.entities([id]);
    assert.equal(stored.values.find(v => v.field === `${STATEMENT_PREFIX}personas`)?.json, '["7"]');
    const parts = cardParts(stored);
    assert.equal(parts.columns.name, 'Cara Prime');
    assert.deepEqual(parts.extra.filter(x => x.path.startsWith(STATEMENT_PREFIX)), []);
});
