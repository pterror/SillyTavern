import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TYPE } from '../library-codes.js';
import { regexPresetsFromUpstream, regexPresetsToUpstream, regexScriptsFromUpstream, regexScriptsToUpstream } from './regex.js';
import { dataBankFromUpstream, dataBankToUpstream, globalVariablesFromUpstream, globalVariablesToUpstream } from './user-data.js';

const json = value => JSON.parse(JSON.stringify(value));
function keys() {
    let n = 0;
    return () => `new-${++n}`;
}

/** @param {Record<string, any>} fields */
function script(fields) {
    return {
        id: 'r1', scriptName: 'Trim', findRegex: '/x/g', replaceString: '', trimStrings: ['a', 'b'], placement: [1, 2],
        disabled: false, markdownOnly: false, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null, ...fields,
    };
}

test('the user\'s regex scripts: a catalog by id, trimStrings and placement as lists keeping their types', () => {
    const scripts = [script({}), script({ id: 'r2', placement: [] })];
    const { scripts: drafts, warnings } = regexScriptsFromUpstream(structuredClone(scripts), { newKey: keys() });
    assert.deepEqual(warnings, []);
    assert.deepEqual(drafts.map(d => [d.type, d.key]), [[TYPE.regexScript, 'r1'], [TYPE.regexScript, 'r2']]);
    assert.equal(Object.hasOwn(drafts[0].values, 'id'), false);
    assert.deepEqual(drafts[0].lists, { 0: ['"a"', '"b"'], 1: ['1', '2'] });
    assert.deepEqual(regexScriptsToUpstream(json(drafts)), scripts);
});

test('a script with a missing or repeated id gets a new key in the catalog, its place under a holder', () => {
    const scripts = [script({}), script({ scriptName: 'again' }), script({ id: undefined })];
    const catalog = regexScriptsFromUpstream(structuredClone(scripts), { newKey: keys() });
    assert.deepEqual(catalog.scripts.map(d => d.key), ['r1', '#new-1', '#new-2']);
    assert.equal(catalog.warnings.length, 2);
    assert.deepEqual(regexScriptsToUpstream(json(catalog.scripts)), json(scripts));
    const card = regexScriptsFromUpstream(structuredClone(scripts), { holder: 'Alice.png' });
    assert.deepEqual(card.scripts.map(d => d.key), ['Alice.png:r1', 'Alice.png:#1', 'Alice.png:#2']);
    assert.deepEqual(regexScriptsToUpstream(json(card.scripts), 'Alice.png'), json(scripts));
});

test('regex presets: lists of the scripts they turn on, and the selected one a slot', () => {
    const presets = [
        { id: 'p1', name: 'Chat', isSelected: false, global: [{ id: 'r1' }], scoped: [], preset: [{ id: 'r9' }] },
        { id: 'p2', name: 'Prose', isSelected: true, global: [{ id: 'r1' }, { id: 'r2' }], scoped: [{ id: 's1' }], preset: [] },
    ];
    const { presets: drafts, selected, warnings } = regexPresetsFromUpstream(structuredClone(presets), keys());
    assert.deepEqual(warnings, []);
    assert.equal(selected, 'p2');
    assert.deepEqual(drafts[1].values, { name: 'Prose' });
    assert.deepEqual(drafts[1].lists, { 0: ['r1', 'r2'], 1: ['s1'], 2: [] });
    assert.deepEqual(regexPresetsToUpstream(json(drafts), selected), presets);
    const twice = regexPresetsFromUpstream([{ ...presets[0], isSelected: true }, presets[1]], keys());
    assert.equal(twice.selected, 'p1');
    assert.equal(twice.warnings.length, 1);
});

test('global variables, each its own entity', () => {
    const variables = { score: 3, name: 'x', list: '[1,2]' };
    const drafts = globalVariablesFromUpstream(variables);
    assert.deepEqual(drafts.map(d => [d.type, d.key, d.values.value]), [[TYPE.globalVariable, 'score', 3], [TYPE.globalVariable, 'name', 'x'], [TYPE.globalVariable, 'list', '[1,2]']]);
    assert.deepEqual(globalVariablesToUpstream(json(drafts)), variables);
});

test('data bank files once each by url; the user\'s and each character\'s lists; turned-off ones', () => {
    const file = (url, fields = {}) => ({ url, size: 10, name: url.slice(1), created: 1, ...fields });
    const settings = {
        attachments: [file('/a.txt'), file('/b.txt', { text: 'cached' })],
        character_attachments: { 'Alice.png': [file('/c.txt'), file('/a.txt')] },
        disabled_attachments: ['/b.txt', '/chat-only.txt'],
    };
    const from = dataBankFromUpstream(structuredClone(settings));
    assert.deepEqual(from.files.map(f => f.key), ['/a.txt', '/b.txt', '/c.txt']);
    assert.equal(from.files[1].values.disabled, true);
    assert.deepEqual(from.user, ['/a.txt', '/b.txt']);
    assert.deepEqual(from.characters, [{ avatar: 'Alice.png', files: ['/c.txt', '/a.txt'] }]);
    assert.deepEqual(from.disabledElsewhere, ['/chat-only.txt']);
    assert.deepEqual(from.warnings, []);
    assert.deepEqual(dataBankToUpstream(json(from.files), json(from)), settings);
});
