import { describe, test, expect } from '@jest/globals';
import { hashGreetingText, opAppend, opDelete, opEdit, opMove, opSetDefault } from '../src/greeting-ops.js';

const h = hashGreetingText;
const modelOf = (greetings, defaultIndex = 0) => ({ greetings, defaultIndex });

/** Moves the greeting at `from` next to the one at `to`, with both hashes read from the model as it stands. */
const move = (model, from, side, to) => opMove(model, from, h(model.greetings[from]), side, to, h(model.greetings[to]));

describe('opMove', () => {
    const abcde = () => modelOf(['a', 'b', 'c', 'd', 'e'], null);

    test('before an anchor that comes after the source', () => {
        expect(move(abcde(), 1, 'before', 3)).toEqual({ ok: true, model: modelOf(['a', 'c', 'b', 'd', 'e'], null), sourcePosition: 1, targetPosition: 3 });
    });

    test('after an anchor that comes after the source', () => {
        expect(move(abcde(), 1, 'after', 3)).toEqual({ ok: true, model: modelOf(['a', 'c', 'd', 'b', 'e'], null), sourcePosition: 1, targetPosition: 3 });
    });

    test('before an anchor that comes before the source', () => {
        expect(move(abcde(), 3, 'before', 1)).toEqual({ ok: true, model: modelOf(['a', 'd', 'b', 'c', 'e'], null), sourcePosition: 3, targetPosition: 1 });
    });

    test('after an anchor that comes before the source', () => {
        expect(move(abcde(), 3, 'after', 1)).toEqual({ ok: true, model: modelOf(['a', 'b', 'd', 'c', 'e'], null), sourcePosition: 3, targetPosition: 1 });
    });

    test('to the end is after the last greeting', () => {
        expect(move(abcde(), 0, 'after', 4)).toEqual({ ok: true, model: modelOf(['b', 'c', 'd', 'e', 'a'], null), sourcePosition: 0, targetPosition: 4 });
    });

    test('the default follows the moved greeting', () => {
        const result = move(modelOf(['a', 'b', 'c', 'd'], 1), 1, 'after', 3);
        expect(result.model.greetings).toEqual(['a', 'c', 'd', 'b']);
        expect(result.model.defaultIndex).toBe(3);
    });

    test('the default follows a greeting the move passes', () => {
        const result = move(modelOf(['a', 'b', 'c', 'd'], 2), 0, 'after', 3);
        expect(result.model.greetings).toEqual(['b', 'c', 'd', 'a']);
        expect(result.model.greetings[result.model.defaultIndex]).toBe('c');

        const back = move(modelOf(['a', 'b', 'c', 'd'], 1), 3, 'before', 0);
        expect(back.model.greetings).toEqual(['d', 'a', 'b', 'c']);
        expect(back.model.greetings[back.model.defaultIndex]).toBe('b');
    });

    test('a stale source hash is refused', () => {
        const model = abcde();
        expect(opMove(model, 1, h('x'), 'after', 3, h('d'))).toEqual({ ok: false, reason: 'greeting at position changed since it was loaded' });
    });

    test('a stale target hash is refused', () => {
        const model = abcde();
        expect(opMove(model, 1, h('b'), 'after', 3, h('x'))).toEqual({ ok: false, reason: 'target greeting changed since it was loaded' });
    });

    test('a target out of range whose hash no greeting has is refused', () => {
        const model = abcde();
        expect(opMove(model, 1, h('b'), 'after', 5, h('x'))).toEqual({ ok: false, reason: 'target position out of range' });
        expect(opMove(model, 1, h('b'), 'before', -1, h('x'))).toEqual({ ok: false, reason: 'target position out of range' });
    });

    test('a greeting cannot be moved next to itself', () => {
        expect(move(abcde(), 2, 'before', 2)).toEqual({ ok: false, reason: 'cannot move a greeting next to itself' });
    });

    test('a no-op placement returns a model equal to the input', () => {
        const model = modelOf(['a', 'b', 'c'], 1);
        expect(move(model, 1, 'before', 2)).toEqual({ ok: true, model, sourcePosition: 1, targetPosition: 2 });
        expect(move(model, 1, 'after', 0)).toEqual({ ok: true, model, sourcePosition: 1, targetPosition: 0 });
    });

    test('the input model is never mutated', () => {
        const model = modelOf(['a', 'b', 'c'], 0);
        move(model, 0, 'after', 2);
        expect(model).toEqual(modelOf(['a', 'b', 'c'], 0));
    });

    test('next to either of two identical greetings gives the same result', () => {
        const model = modelOf(['x', 'same', 'same', 'y'], null);
        // "After the first copy" and "before the second" name the same slot.
        expect(move(model, 3, 'after', 1)).toEqual({ ok: true, model: modelOf(['x', 'same', 'y', 'same'], null), sourcePosition: 3, targetPosition: 1 });
        expect(move(model, 3, 'before', 2)).toEqual({ ok: true, model: modelOf(['x', 'same', 'y', 'same'], null), sourcePosition: 3, targetPosition: 2 });
        expect(move(model, 0, 'after', 1)).toEqual({ ok: true, model: modelOf(['same', 'x', 'same', 'y'], null), sourcePosition: 0, targetPosition: 1 });
        expect(move(model, 0, 'before', 2)).toEqual({ ok: true, model: modelOf(['same', 'x', 'same', 'y'], null), sourcePosition: 0, targetPosition: 2 });
    });
});

describe('opEdit', () => {
    const abc = () => modelOf(['a', 'b', 'c'], 0);

    test('edits the greeting at the position when its hash matches', () => {
        expect(opEdit(abc(), 1, h('b'), 'B')).toEqual({ ok: true, model: modelOf(['a', 'B', 'c'], 0), position: 1 });
    });

    test('the position wins over another greeting with the same hash', () => {
        expect(opEdit(modelOf(['b', 'b'], 0), 1, h('b'), 'B')).toEqual({ ok: true, model: modelOf(['b', 'B'], 0), position: 1 });
    });

    test('a hash that moved to another position edits the one greeting that has it', () => {
        expect(opEdit(abc(), 0, h('c'), 'C')).toEqual({ ok: true, model: modelOf(['a', 'b', 'C'], 0), position: 2 });
    });

    test('a position past the end edits the one greeting that has the hash', () => {
        expect(opEdit(modelOf(['b', 'c'], 0), 2, h('c'), 'C')).toEqual({ ok: true, model: modelOf(['b', 'C'], 0), position: 1 });
    });

    test('the default stays where it was', () => {
        expect(opEdit(modelOf(['a', 'b', 'c'], 2), 0, h('b'), 'B')).toEqual({ ok: true, model: modelOf(['a', 'B', 'c'], 2), position: 1 });
    });

    test('refuses when no greeting has the hash', () => {
        expect(opEdit(abc(), 1, h('x'), 'X')).toEqual({ ok: false, reason: 'greeting at position changed since it was loaded' });
        expect(opEdit(abc(), 3, h('x'), 'X')).toEqual({ ok: false, reason: 'position out of range' });
    });

    test('refuses when more than one other greeting has the hash', () => {
        expect(opEdit(modelOf(['a', 'b', 'b'], 0), 0, h('b'), 'B')).toEqual({ ok: false, reason: 'greeting at position changed since it was loaded' });
        expect(opEdit(modelOf(['b', 'b'], 0), 5, h('b'), 'B')).toEqual({ ok: false, reason: 'position out of range' });
    });

    test('refuses empty text even when the hash matches', () => {
        expect(opEdit(abc(), 1, h('b'), '')).toEqual({ ok: false, reason: 'refused to blank stored greeting text' });
    });

    test('never mutates the input model', () => {
        const model = abc();
        opEdit(model, 0, h('c'), 'C');
        expect(model).toEqual(abc());
    });
});

describe('opDelete', () => {
    const abc = (defaultIndex = 0) => modelOf(['a', 'b', 'c'], defaultIndex);

    test('deletes the greeting at the position when its hash matches', () => {
        expect(opDelete(abc(), 1, h('b'))).toEqual({ ok: true, model: modelOf(['a', 'c'], 0), position: 1 });
    });

    test('the position wins over another greeting with the same hash', () => {
        expect(opDelete(modelOf(['b', 'b'], 0), 1, h('b'))).toEqual({ ok: true, model: modelOf(['b'], 0), position: 1 });
    });

    test('a hash that moved to another position deletes the one greeting that has it', () => {
        expect(opDelete(abc(), 0, h('c'))).toEqual({ ok: true, model: modelOf(['a', 'b'], 0), position: 2 });
    });

    test('a position past the end deletes the one greeting that has the hash', () => {
        expect(opDelete(modelOf(['b', 'c'], 0), 2, h('c'))).toEqual({ ok: true, model: modelOf(['b'], 0), position: 1 });
    });

    test('the default is reindexed from the position actually deleted', () => {
        expect(opDelete(abc(2), 0, h('b'))).toEqual({ ok: true, model: modelOf(['a', 'c'], 1), position: 1 });
        expect(opDelete(abc(1), 0, h('b'))).toEqual({ ok: true, model: modelOf(['a', 'c'], null), position: 1 });
    });

    test('refuses when no greeting has the hash', () => {
        expect(opDelete(abc(), 1, h('x'))).toEqual({ ok: false, reason: 'greeting at position changed since it was loaded' });
        expect(opDelete(abc(), 3, h('x'))).toEqual({ ok: false, reason: 'position out of range' });
    });

    test('refuses when more than one other greeting has the hash', () => {
        expect(opDelete(modelOf(['a', 'b', 'b'], 0), 0, h('b'))).toEqual({ ok: false, reason: 'greeting at position changed since it was loaded' });
        expect(opDelete(modelOf(['b', 'b'], 0), 5, h('b'))).toEqual({ ok: false, reason: 'position out of range' });
    });

    test('never mutates the input model', () => {
        const model = abc();
        opDelete(model, 0, h('c'));
        expect(model).toEqual(abc());
    });
});

describe('opSetDefault', () => {
    const abc = () => modelOf(['a', 'b', 'c'], 0);

    test('makes the greeting at the position the default when its hash matches', () => {
        expect(opSetDefault(abc(), 1, h('b'))).toEqual({ ok: true, model: modelOf(['a', 'b', 'c'], 1), position: 1 });
    });

    test('the position wins over another greeting with the same hash', () => {
        expect(opSetDefault(modelOf(['a', 'b', 'b'], 0), 2, h('b'))).toEqual({ ok: true, model: modelOf(['a', 'b', 'b'], 2), position: 2 });
    });

    test('a hash that moved to another position makes the one greeting that has it the default', () => {
        expect(opSetDefault(abc(), 1, h('c'))).toEqual({ ok: true, model: modelOf(['a', 'b', 'c'], 2), position: 2 });
    });

    test('a position past the end makes the one greeting that has the hash the default', () => {
        expect(opSetDefault(modelOf(['b', 'c'], 0), 2, h('c'))).toEqual({ ok: true, model: modelOf(['b', 'c'], 1), position: 1 });
    });

    test('refuses when no greeting has the hash', () => {
        expect(opSetDefault(abc(), 1, h('x'))).toEqual({ ok: false, reason: 'greeting at position changed since it was loaded' });
        expect(opSetDefault(abc(), 3, h('x'))).toEqual({ ok: false, reason: 'position out of range' });
    });

    test('refuses when more than one other greeting has the hash', () => {
        expect(opSetDefault(modelOf(['a', 'b', 'b'], 0), 0, h('b'))).toEqual({ ok: false, reason: 'greeting at position changed since it was loaded' });
        expect(opSetDefault(modelOf(['b', 'b'], 0), 5, h('b'))).toEqual({ ok: false, reason: 'position out of range' });
    });
});

describe('opMove looks each end up by its hash', () => {
    const abcde = (defaultIndex = null) => modelOf(['a', 'b', 'c', 'd', 'e'], defaultIndex);

    test('returns the source and target positions it used', () => {
        expect(opMove(abcde(), 1, h('b'), 'after', 3, h('d'))).toEqual({
            ok: true, model: modelOf(['a', 'c', 'd', 'b', 'e'], null), sourcePosition: 1, targetPosition: 3,
        });
    });

    test('a source whose hash moved is found by it, and the landing is computed from where it was found', () => {
        expect(opMove(abcde(), 0, h('b'), 'after', 3, h('d'))).toEqual({
            ok: true, model: modelOf(['a', 'c', 'd', 'b', 'e'], null), sourcePosition: 1, targetPosition: 3,
        });
    });

    test('a target whose hash moved is found by it', () => {
        expect(opMove(abcde(), 1, h('b'), 'after', 4, h('d'))).toEqual({
            ok: true, model: modelOf(['a', 'c', 'd', 'b', 'e'], null), sourcePosition: 1, targetPosition: 3,
        });
    });

    test('both ends past the end are found by their hashes', () => {
        expect(opMove(modelOf(['b', 'd'], null), 5, h('b'), 'after', 6, h('d'))).toEqual({
            ok: true, model: modelOf(['d', 'b'], null), sourcePosition: 0, targetPosition: 1,
        });
    });

    test('the default follows from the positions actually used', () => {
        const result = opMove(abcde(1), 0, h('b'), 'after', 3, h('d'));
        expect(result.model.greetings).toEqual(['a', 'c', 'd', 'b', 'e']);
        expect(result.model.defaultIndex).toBe(3);
    });

    test('a source hash no greeting or more than one has is refused', () => {
        expect(opMove(abcde(), 1, h('x'), 'after', 3, h('d'))).toEqual({ ok: false, reason: 'greeting at position changed since it was loaded' });
        expect(opMove(modelOf(['a', 'b', 'b', 'd'], null), 0, h('b'), 'after', 3, h('d'))).toEqual({ ok: false, reason: 'greeting at position changed since it was loaded' });
        expect(opMove(modelOf(['a', 'b', 'b', 'd'], null), 9, h('b'), 'after', 3, h('d'))).toEqual({ ok: false, reason: 'position out of range' });
    });

    test('a target hash no greeting or more than one has is refused', () => {
        expect(opMove(abcde(), 1, h('b'), 'after', 3, h('x'))).toEqual({ ok: false, reason: 'target greeting changed since it was loaded' });
        expect(opMove(modelOf(['a', 'b', 'd', 'd'], null), 1, h('b'), 'after', 0, h('d'))).toEqual({ ok: false, reason: 'target greeting changed since it was loaded' });
        expect(opMove(modelOf(['a', 'b', 'd', 'd'], null), 1, h('b'), 'after', 9, h('d'))).toEqual({ ok: false, reason: 'target position out of range' });
    });

    test('ends that are found to be the same greeting are refused', () => {
        expect(opMove(abcde(), 0, h('b'), 'after', 1, h('b'))).toEqual({ ok: false, reason: 'cannot move a greeting next to itself' });
    });
});

describe('opAppend', () => {
    test('puts the text after the last greeting, whatever the length', () => {
        expect(opAppend(modelOf(['a', 'b'], 0), 'c')).toEqual({ ok: true, model: modelOf(['a', 'b', 'c'], 0), position: 2 });
        expect(opAppend(modelOf([], null), 'a')).toEqual({ ok: true, model: modelOf(['a'], null), position: 0 });
    });

    test('keeps the default where it is', () => {
        expect(opAppend(modelOf(['a', 'b'], 1), 'c')).toEqual({ ok: true, model: modelOf(['a', 'b', 'c'], 1), position: 2 });
    });

    test('refuses empty text', () => {
        expect(opAppend(modelOf(['a'], 0), '')).toEqual({ ok: false, reason: 'refused to add empty greeting text' });
    });

    test('never mutates the input model', () => {
        const model = modelOf(['a'], 0);
        opAppend(model, 'b');
        expect(model).toEqual(modelOf(['a'], 0));
    });
});
