import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TYPE } from '../library-codes.js';
import { personasFromUpstream, personasToUpstream } from './personas.js';

const json = value => JSON.parse(JSON.stringify(value));

/**
 * @param {Record<string, any>} record
 */
function persona(record) {
    return { description: '', position: 0, depth: 2, role: 0, lorebook: '', title: '', connections: [], ...record };
}

test('this fork\'s persona_data: a persona per avatar; connections become each character\'s statement, and come back', () => {
    const persona_data = {
        'a.png': persona({ name: 'Ann', description: 'Ann is {{user}}.', lorebook: 'Ann lore', connections: [{ type: 'character', id: 'Bob.png' }, { type: 'group', id: '17' }] }),
        'b.png': persona({ name: 'Bea', position: 4, depth: 1, role: 2, connections: [{ type: 'character', id: 'Bob.png' }] }),
        'c.png': persona({ name: 'Cy', extra: { kept: true } }),
    };
    const from = personasFromUpstream({ persona_data: structuredClone(persona_data), default_persona: 'b.png', user_avatar: 'b.png', username: 'Bea' });
    assert.deepEqual(from.personas.map(p => [p.type, p.key]), [[TYPE.persona, 'a.png'], [TYPE.persona, 'b.png'], [TYPE.persona, 'c.png']]);
    assert.equal(Object.hasOwn(from.personas[0].values, 'connections'), false);
    assert.deepEqual(from.connected, [
        { holder: { type: 'character', id: 'Bob.png' }, personas: ['a.png', 'b.png'] },
        { holder: { type: 'group', id: '17' }, personas: ['a.png'] },
    ]);
    assert.equal(from.userPersona, 'b.png');
    assert.equal(from.username, undefined);
    assert.deepEqual(from.warnings, []);

    const back = personasToUpstream(json(from.personas), json(from));
    assert.deepEqual(back.persona_data, persona_data);
    assert.deepEqual(back.personas, { 'a.png': 'Ann', 'b.png': 'Bea', 'c.png': 'Cy' });
    assert.equal(back.persona_descriptions['a.png'].lorebook, 'Ann lore');
    assert.deepEqual(back.persona_descriptions, back.persona_data);
    assert.deepEqual([back.default_persona, back.user_avatar, back.username], ['b.png', 'b.png', 'Bea']);
});

test('upstream\'s two dictionaries merge into one persona each, as the page merges them', () => {
    const from = personasFromUpstream({
        personas: { 'a.png': 'Ann', 'only-name.png': 'Nameless' },
        persona_descriptions: { 'a.png': { description: 'd', position: 0, connections: [] }, 'only-desc.png': { description: 'x', name: 'From desc' } },
        user_avatar: 'a.png',
    });
    assert.deepEqual(from.personas.map(p => [p.key, p.values.name]), [['a.png', 'Ann'], ['only-name.png', 'Nameless'], ['only-desc.png', 'From desc']]);
    assert.equal(from.personas[0].values.description, 'd');
    assert.equal(from.currentPersona, 'a.png');
});

test('the default and the current persona are each their own', () => {
    const both = personasFromUpstream({ persona_data: {}, default_persona: 'd.png', user_avatar: 'u.png' });
    assert.deepEqual([both.userPersona, both.currentPersona, both.warnings], ['d.png', 'u.png', []]);
    const back = personasToUpstream([], both);
    assert.deepEqual([back.default_persona, back.user_avatar], ['d.png', 'u.png']);
    assert.equal(personasToUpstream([], { currentPersona: 'u.png' }).default_persona, null);
});

test('username is kept only when no persona has the user\'s avatar', () => {
    const none = personasFromUpstream({ persona_data: {}, user_avatar: 'user-default.png', username: 'Me' });
    assert.equal(none.username, 'Me');
    assert.equal(personasToUpstream([], { userPersona: 'user-default.png', username: 'Me' }).username, 'Me');
    const named = personasFromUpstream({ persona_data: { 'user-default.png': persona({ name: 'Persona' }) }, user_avatar: 'user-default.png', username: 'Stale' });
    assert.equal(named.username, undefined);
    assert.equal(personasToUpstream(named.personas, named).username, 'Persona');
});

test('a connection naming no character or group is dropped, warned; a repeat once', () => {
    const from = personasFromUpstream({
        persona_data: { 'a.png': persona({ name: 'A', connections: [{ type: 'character', id: 'X.png' }, { type: 'character', id: 'X.png' }, { type: 'world', id: 'w' }, null] }) },
    });
    assert.deepEqual(from.connected, [{ holder: { type: 'character', id: 'X.png' }, personas: ['a.png'] }]);
    assert.equal(from.warnings.length, 2);
});
