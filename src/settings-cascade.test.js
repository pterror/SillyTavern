import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ORDER_FIELD, combineList, editField, foldIntoBundle, levelOrder, resetGroup, resolveField } from './settings-cascade.js';

// Every precedence rule of the settings model §1.1 and settings-scopes.md.

/** @type {Record<string, Record<string, unknown>>} */
const BUNDLES = {
    'preset:P': { temp: 1.0, top_p: 0.9, rep_pen: 1.1 },
    'preset:Q': { temp: 0.5, top_p: 0.5 },
    'instruct:ChatML': { input_sequence: '<|im_start|>user' },
    'theme:Dark': { blur: 10, font_scale: 1 },
};
/** @type {Record<string, Record<string, string>>} */
const PROFILES = { 'profile:Work': { preset: 'preset:Q', instruct: 'instruct:ChatML' } };
const GROUPS = { temp: 'preset', top_p: 'preset', rep_pen: 'preset', input_sequence: 'instruct', blur: 'theme', font_scale: 'theme' };
const KINDS = { blur: 'reader', font_scale: 'reader', background: 'background', tts_voice: 'browser' };

/** @type {import('./settings-cascade.js').Catalog} */
const catalog = {
    groupOf: field => GROUPS[field] ?? null,
    kindOf: field => /** @type {any} */ (KINDS[field] ?? 'generation'),
    bundle: ref => BUNDLES[ref],
    profile: ref => PROFILES[ref],
};

/**
 * Levels in the default order, each stating what's given for it.
 * @param {Partial<Record<string, Omit<import('./settings-cascade.js').LevelStatements, 'level'>>>} stated
 */
function levels(stated) {
    return ['tab', 'chat', 'character', 'device', 'user', 'default'].map(level => ({ level, ...stated[level] }));
}

test('the closest level that states a field supplies it', () => {
    const ls = levels({ user: { overrides: { temp: 0.7 } }, chat: { overrides: { temp: 0.2 } } });
    assert.deepEqual(resolveField(ls, 'temp', catalog), { value: 0.2, from: 'override', index: 1 });
});

test('a bundle stated at a closer level beats a farther override of a field it holds', () => {
    const ls = levels({ character: { bundles: { preset: 'preset:Q' } }, user: { overrides: { temp: 0.7 } } });
    assert.deepEqual(resolveField(ls, 'temp', catalog), { value: 0.5, from: 'bundle', bundle: 'preset:Q', index: 2 });
});

test('a closer override of one field keeps the farther bundle for the rest', () => {
    const ls = levels({ character: { overrides: { temp: 0.3 } }, user: { bundles: { preset: 'preset:P' } } });
    assert.equal(resolveField(ls, 'temp', catalog).value, 0.3);
    assert.deepEqual(resolveField(ls, 'top_p', catalog), { value: 0.9, from: 'bundle', bundle: 'preset:P', index: 4 });
});

test('at one level an override beats the bundle the level states', () => {
    const ls = levels({ user: { bundles: { preset: 'preset:P' }, overrides: { temp: 0.8 } } });
    assert.equal(resolveField(ls, 'temp', catalog).value, 0.8);
});

test('a bundle without the field lets it fall through to the next level', () => {
    const ls = levels({ character: { bundles: { preset: 'preset:Q' } }, user: { bundles: { preset: 'preset:P' } } });
    assert.deepEqual(resolveField(ls, 'rep_pen', catalog), { value: 1.1, from: 'bundle', bundle: 'preset:P', index: 4 });
});

test('a profile states its bundles at its level; a statement made there directly beats the profile\'s', () => {
    const viaProfile = levels({ user: { profile: 'profile:Work' } });
    assert.equal(resolveField(viaProfile, 'temp', catalog).value, 0.5);
    assert.equal(resolveField(viaProfile, 'input_sequence', catalog).value, '<|im_start|>user');
    const direct = levels({ user: { profile: 'profile:Work', bundles: { preset: 'preset:P' } } });
    assert.equal(resolveField(direct, 'temp', catalog).value, 1.0);
});

test('a level a field\'s kind may not use is skipped: no chat or character changes a reader-bound setting', () => {
    const ls = levels({ chat: { overrides: { blur: 0 } }, character: { bundles: { theme: 'theme:Dark' } }, device: { overrides: { blur: 4 } } });
    assert.deepEqual(resolveField(ls, 'blur', catalog), { value: 4, from: 'override', index: 3 });
    // And a generation setting never depends on a device.
    const generation = levels({ device: { overrides: { temp: 0.1 } }, user: { overrides: { temp: 0.6 } } });
    assert.equal(resolveField(generation, 'temp', catalog).value, 0.6);
    // A background may be stated at every level; a browser-run capability at the device too.
    assert.equal(resolveField(levels({ chat: { overrides: { background: 'b.png' } } }), 'background', catalog).value, 'b.png');
    assert.equal(resolveField(levels({ device: { overrides: { tts_voice: 'v' } } }), 'tts_voice', catalog).value, 'v');
});

test('the order is a setting: stated at a level for every field, or for one field', () => {
    const order = ['tab', 'device', 'user', 'chat', 'character', 'default'];
    // "On this phone, my settings win over chats."
    const everyField = levels({ device: { overrides: { [ORDER_FIELD]: order } }, chat: { overrides: { temp: 0.2 } }, user: { overrides: { temp: 0.9 } } });
    assert.equal(resolveField(everyField, 'temp', catalog).value, 0.9);
    // "My preset over characters' presets", for one field only.
    const oneField = levels({
        user: { overrides: { [`${ORDER_FIELD}:temp`]: order, temp: 0.9, top_p: 0.4 } },
        character: { overrides: { temp: 0.2, top_p: 0.1 } },
    });
    assert.equal(resolveField(oneField, 'temp', catalog).value, 0.9);
    assert.equal(resolveField(oneField, 'top_p', catalog).value, 0.1);
});

test('in a group, the speaking character\'s statements come before the group\'s', () => {
    const ls = [
        { level: 'tab' }, { level: 'chat' },
        { level: 'character', overrides: { temp: 0.3 } },
        { level: 'character', overrides: { temp: 0.6, top_p: 0.2 } },
        { level: 'device' }, { level: 'user' }, { level: 'default' },
    ];
    assert.equal(resolveField(ls, 'temp', catalog).value, 0.3);
    assert.equal(resolveField(ls, 'top_p', catalog).value, 0.2);
    assert.deepEqual(levelOrder(ls, 'temp', catalog), [0, 1, 2, 3, 5, 6]);
});

test('nothing stated anywhere resolves to nothing', () => {
    assert.deepEqual(resolveField(levels({}), 'temp', catalog), { value: undefined, index: -1, from: 'none' });
});

test('an edit goes to the level supplying the value, or the user when it comes from the default', () => {
    const ls = levels({ character: { overrides: { temp: 0.3 } }, default: { overrides: { top_p: 1 } } });
    assert.deepEqual(editField(ls, 'temp', 0.4, catalog), { op: 'set', index: 2, field: 'temp', value: 0.4 });
    assert.deepEqual(editField(ls, 'top_p', 0.5, catalog), { op: 'set', index: 4, field: 'top_p', value: 0.5 });
    // A bundle supplying it: the override goes to that level.
    const bundled = levels({ chat: { bundles: { preset: 'preset:P' } } });
    assert.deepEqual(editField(bundled, 'temp', 0.4, catalog), { op: 'set', index: 1, field: 'temp', value: 0.4 });
    // Another level, as asked.
    assert.deepEqual(editField(ls, 'temp', 0.4, catalog, 4), { op: 'set', index: 4, field: 'temp', value: 0.4 });
    assert.throws(() => editField(ls, 'temp', 0.4, catalog, 5));
});

test('an override equal to what its level would resolve without it is not stored: setting it deletes the override', () => {
    const ls = levels({ chat: { overrides: { temp: 0.3 } }, user: { bundles: { preset: 'preset:P' } } });
    assert.deepEqual(editField(ls, 'temp', 1.0, catalog), { op: 'delete', index: 1, field: 'temp' });
    // Nothing stated at the level and the value what it already resolves to: nothing to write.
    assert.equal(editField(ls, 'top_p', 0.9, catalog, 1), null);
    // The same override again: nothing either.
    assert.equal(editField(ls, 'temp', 0.3, catalog), null);
});

test('save to preset folds a level\'s overrides of the bundle\'s fields into it; reset drops them', () => {
    const user = { level: 'user', bundles: { preset: 'preset:P' }, overrides: { temp: 0.8, top_p: 0.9, input_sequence: 'x' } };
    assert.deepEqual(foldIntoBundle(user, 'preset', catalog), { bundle: 'preset:P', fields: { temp: 0.8 }, drop: ['temp', 'top_p'] });
    assert.equal(foldIntoBundle({ level: 'chat', overrides: { temp: 1 } }, 'preset', catalog), null);
    assert.deepEqual(resetGroup(user, 'preset', catalog), ['temp', 'top_p']);
});

test('a combined list: each level adds its items, a closer one may remove inherited ones', () => {
    const chat = { items: ['chat-book'], minus: ['global-b'] };
    const character = { items: ['char-book', 'global-a'] };
    const user = { items: ['global-a', 'global-b'] };
    assert.deepEqual(combineList([chat, character, user]), ['global-a', 'char-book', 'chat-book']);
});
