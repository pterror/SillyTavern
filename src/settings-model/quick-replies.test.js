import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { TYPE } from '../library-codes.js';
import { THEME_FIELDS, themeFromUpstream, themeToUpstream } from './themes.js';
import { quickReplySetFromUpstream, quickReplySetToUpstream, setListFromUpstream, setListToUpstream } from './quick-replies.js';

const CONTENT = path.join(import.meta.dirname, '../../default/content');
const json = value => JSON.parse(JSON.stringify(value));

test('a version 2 quick reply set: replies are parts by id, context menus their lists; it comes back as it came', () => {
    const file = {
        version: 2, name: 'Tools', disableSend: false, placeBeforeInput: true, injectInput: false, color: 'transparent', onlyBorderColor: false, idIndex: 3,
        qrList: [
            { id: 1, icon: '', showLabel: false, label: 'Roll', title: '', message: '/roll 1d20', contextList: [{ set: 'Dice', isChained: true }, { set: 'Misc', isChained: false }], preventAutoExecute: true, isHidden: false, executeOnStartup: false, executeOnUser: false, executeOnAi: false, executeOnChatChange: false, executeOnGroupMemberDraft: false, executeOnNewChat: false, executeBeforeGeneration: false, automationId: '' },
            { id: 3, label: 'Bare', message: '/echo hi' },
        ],
    };
    const { set, warnings } = quickReplySetFromUpstream('Tools', structuredClone(file));
    assert.deepEqual(warnings, []);
    assert.equal(set.type, TYPE.quickReplySet);
    assert.equal(Object.hasOwn(set.values, 'qrList'), false);
    const [roll, bare] = set.lists[0];
    assert.deepEqual([roll.type, roll.key, bare.key], [TYPE.quickReply, 'Tools:1', 'Tools:3']);
    assert.equal(Object.hasOwn(roll.values, 'id'), false);
    assert.deepEqual(roll.lists, { 0: ['Dice', 'Misc'], 1: ['Dice'] });
    assert.deepEqual(quickReplySetToUpstream(json(set)), file);
});

test('a reply with a repeated or non-number id is kept under its place, warned', () => {
    const file = { version: 2, name: 'S', qrList: [{ id: 1, label: 'a' }, { id: 1, label: 'b' }, { id: 'x', label: 'c' }] };
    const { set, warnings } = quickReplySetFromUpstream('S', structuredClone(file));
    assert.deepEqual(set.lists[0].map(part => part.key), ['S:1', 'S:#1', 'S:#2']);
    assert.equal(warnings.length, 2);
    assert.deepEqual(quickReplySetToUpstream(json(set)), file);
});

test('the shipped first-version set is brought to version 2 as the page brings it, its old keys dropped', () => {
    const file = JSON.parse(fs.readFileSync(path.join(CONTENT, 'presets/quick-replies/Default.json'), 'utf8'));
    const { set, warnings } = quickReplySetFromUpstream('Default', file);
    assert.equal(warnings.length, 1);
    const back = quickReplySetToUpstream(json(set));
    assert.equal(back.version, 2);
    assert.deepEqual(Object.keys(back).sort(), ['disableSend', 'injectInput', 'name', 'placeBeforeInput', 'qrList', 'version']);
    assert.deepEqual(/** @type {any[]} */ (back.qrList).map(qr => [qr.id, qr.label, qr.message]), file.quickReplySlots.map((slot, i) => [i + 1, slot.label, slot.mes]));
});

test('a set list statement: its sets in order and the hidden ones', () => {
    const config = { setList: [{ set: 'A', isVisible: true }, { set: 'B', isVisible: false }] };
    assert.deepEqual(setListFromUpstream(config), { items: ['A', 'B'], hidden: ['B'] });
    assert.deepEqual(setListToUpstream(setListFromUpstream(config)), config);
    assert.deepEqual(setListFromUpstream(undefined), { items: [], hidden: [] });
});

test('every shipped theme comes back as it came, and holds only theme fields', () => {
    const files = fs.readdirSync(path.join(CONTENT, 'themes')).filter(file => file.endsWith('.json'));
    assert.ok(files.length > 0);
    for (const file of files) {
        const theme = JSON.parse(fs.readFileSync(path.join(CONTENT, 'themes', file), 'utf8'));
        const name = path.basename(file, '.json');
        const entity = themeFromUpstream(name, structuredClone(theme));
        assert.deepEqual([entity.type, entity.key], [TYPE.theme, name]);
        assert.deepEqual(themeToUpstream(json(entity)), theme, file);
        assert.deepEqual(Object.keys(theme).filter(key => key !== 'name' && !THEME_FIELDS.includes(key)), [], file);
    }
});
