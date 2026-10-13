import { describe, test, expect } from '@jest/globals';

import { applyChanges, baselineAfter, baselineOf, changeOps, changesSince, changesStateHere, metadataChanges, replaceInPlace, unsavedVariables } from '../public/scripts/state-sync.js';

const none = { set: {}, unset: [], variables: { set: {}, unset: [] } };

describe('chat_metadata as state, sent per key and per variable', () => {
    test('nothing changed sends nothing; integrity is never sent', () => {
        const metadata = { note: 'a', variables: { hp: 3 }, integrity: 's1' };
        expect(metadataChanges(metadata, baselineOf(metadata))).toBeNull();
        expect(metadataChanges({ ...metadata, integrity: 's2' }, baselineOf(metadata))).toBeNull();
    });

    test('only the variables whose value differs travel, one by one', () => {
        const baseline = baselineOf({ variables: { hp: 3, mp: 1, list: [1] } });
        const metadata = { variables: { hp: 4, mp: 1, list: [1], gold: 0 } };
        expect(metadataChanges(metadata, baseline)).toEqual({ ...none, variables: { set: { hp: 4, gold: 0 }, unset: [] } });
    });

    test('a variable deleted is removed by name; the object replaced wholesale goes through the same diff', () => {
        const baseline = baselineOf({ note: 'n', variables: { hp: 3, mp: 1 } });
        const metadata = { note: 'n', variables: { hp: 3 } };
        expect(metadataChanges(metadata, baseline)).toEqual({ ...none, variables: { set: {}, unset: ['mp'] } });
        metadata.variables = { hp: 5, xp: 2 };
        expect(metadataChanges(metadata, baseline)).toEqual({ ...none, variables: { set: { hp: 5, xp: 2 }, unset: ['mp'] } });
    });

    test('the object made, even empty, sends `variables: {}`; removed, an unset of the key', () => {
        expect(metadataChanges({ variables: {} }, baselineOf({}))).toEqual({ ...none, set: { variables: {} } });
        expect(metadataChanges({ variables: { a: 1 } }, baselineOf({}))).toEqual({ set: { variables: {} }, unset: [], variables: { set: { a: 1 }, unset: [] } });
        expect(metadataChanges({ note: 'x' }, baselineOf({ note: 'x', variables: { a: 1 } }))).toEqual({ ...none, unset: ['variables'] });
    });

    test('top-level keys travel as before, beside the variables', () => {
        const baseline = baselineOf({ note: 'a', scene: 'inn', variables: {} });
        expect(metadataChanges({ note: 'b', variables: { a: 1 } }, baseline)).toEqual({
            set: { note: 'b' }, unset: ['scene'], variables: { set: { a: 1 }, unset: [] },
        });
    });

    test('the baseline after a stored save sends nothing more', () => {
        const before = { note: 'a', variables: { hp: 3, mp: 1 } };
        const cases = [
            { note: 'b', variables: { hp: 4 } },
            { note: 'a' },
            { variables: {} },
            { note: 'a', variables: { hp: 3, mp: 1, xp: { level: 2 } } },
        ];
        for (const after of cases) {
            const changes = metadataChanges(after, baselineOf(before));
            expect(metadataChanges(after, baselineAfter(baselineOf(before), changes))).toBeNull();
        }
        // Setting a variable with no object there makes it.
        const changes = metadataChanges({ variables: { a: 1 } }, baselineOf({}));
        changes.set = {};
        expect([...baselineAfter(baselineOf({}), changes)]).toEqual([['variables', '{"a":1}']]);
    });

    test('the server\'s state replaces the page\'s in place, the variables object kept', () => {
        const target = { note: 'a', variables: { hp: 3 }, old: 1 };
        const vars = target.variables;
        replaceInPlace(target, { variables: { mp: 2 }, note: 'b' });
        expect(target).toEqual({ variables: { mp: 2 }, note: 'b' });
        expect(Object.keys(target)).toEqual(['variables', 'note']);
        expect(target.variables).toBe(vars);
        replaceInPlace(target, { note: 'c' });
        expect(target).toEqual({ note: 'c' });
    });

    test('a failed save names its variables; a change re-reads the state only on the page\'s path', () => {
        expect(unsavedVariables({ ...none, variables: { set: { a: 1, b: 2 }, unset: ['c', 'a'] } })).toEqual(['a', 'b', 'c']);
        const path = [{ node_id: 'g' }, { node_id: 'r' }];
        expect(changesStateHere(null, path)).toBe(true);
        expect(changesStateHere('r', path)).toBe(true);
        expect(changesStateHere('other', path)).toBe(false);
    });
});

describe('changes made while producing a reply, and changes kept over the server\'s state', () => {
    test('what changed after the start: new and changed keys and variables, and what went back as it was', () => {
        const baseline = baselineOf({ note: 'a', mood: 'calm', variables: { hp: 3, mp: 1 } });
        const atStart = { note: 'typed', mood: 'calm', variables: { hp: 2, mp: 1 } };
        const now = { note: 'typed', scene: 'x', variables: { hp: 3, gold: 5 } };
        const since = changesSince(metadataChanges(atStart, baseline), metadataChanges(now, baseline), now);
        expect(since).toEqual({ set: { scene: 'x' }, unset: ['mood'], variables: { set: { gold: 5, hp: 3 }, unset: ['mp'] } });
        expect(changesSince(metadataChanges(atStart, baseline), metadataChanges(atStart, baseline), atStart)).toBeNull();
        expect(changesSince(null, null, {})).toBeNull();
    });

    test('as ops: keys set and removed, variables by name, the variables object itself none', () => {
        expect(changeOps({ set: { scene: 'x', variables: {} }, unset: ['mood'], variables: { set: { gold: 5 }, unset: ['mp'] } })).toEqual([
            { key: 'scene', value: 'x' },
            { key: 'mood' },
            { key: 'gold', variable: true, value: 5 },
            { key: 'mp', variable: true },
        ]);
    });

    test('changes applied over another state keep it where they don\'t say otherwise', () => {
        const target = { note: 'server', other: 1, variables: { hp: 9, xp: 1 } };
        applyChanges(target, { set: { note: 'mine' }, unset: ['other'], variables: { set: { hp: 3 }, unset: ['xp'] } });
        expect(target).toEqual({ note: 'mine', variables: { hp: 3 } });
        const bare = { note: 'x' };
        applyChanges(bare, { set: {}, unset: [], variables: { set: { hp: 1 }, unset: [] } });
        expect(bare).toEqual({ note: 'x', variables: { hp: 1 } });
    });
});
