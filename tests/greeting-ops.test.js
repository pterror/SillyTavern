import { describe, test, expect } from '@jest/globals';
import { hashGreetingText, opMove } from '../src/greeting-ops.js';

const h = hashGreetingText;
const modelOf = (greetings, defaultIndex = 0) => ({ greetings, defaultIndex });

/** Moves the greeting at `from` next to the one at `to`, with both hashes read from the model as it stands. */
const move = (model, from, side, to) => opMove(model, from, h(model.greetings[from]), side, to, h(model.greetings[to]));

describe('opMove', () => {
    const abcde = () => modelOf(['a', 'b', 'c', 'd', 'e'], null);

    test('before an anchor that comes after the source', () => {
        expect(move(abcde(), 1, 'before', 3)).toEqual({ ok: true, model: modelOf(['a', 'c', 'b', 'd', 'e'], null) });
    });

    test('after an anchor that comes after the source', () => {
        expect(move(abcde(), 1, 'after', 3)).toEqual({ ok: true, model: modelOf(['a', 'c', 'd', 'b', 'e'], null) });
    });

    test('before an anchor that comes before the source', () => {
        expect(move(abcde(), 3, 'before', 1)).toEqual({ ok: true, model: modelOf(['a', 'd', 'b', 'c', 'e'], null) });
    });

    test('after an anchor that comes before the source', () => {
        expect(move(abcde(), 3, 'after', 1)).toEqual({ ok: true, model: modelOf(['a', 'b', 'd', 'c', 'e'], null) });
    });

    test('to the end is after the last greeting', () => {
        expect(move(abcde(), 0, 'after', 4)).toEqual({ ok: true, model: modelOf(['b', 'c', 'd', 'e', 'a'], null) });
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

    test('a target out of range is refused', () => {
        const model = abcde();
        expect(opMove(model, 1, h('b'), 'after', 5, h('e'))).toEqual({ ok: false, reason: 'target position out of range' });
        expect(opMove(model, 1, h('b'), 'before', -1, h('a'))).toEqual({ ok: false, reason: 'target position out of range' });
    });

    test('a greeting cannot be moved next to itself', () => {
        expect(move(abcde(), 2, 'before', 2)).toEqual({ ok: false, reason: 'cannot move a greeting next to itself' });
    });

    test('a no-op placement returns a model equal to the input', () => {
        const model = modelOf(['a', 'b', 'c'], 1);
        expect(move(model, 1, 'before', 2)).toEqual({ ok: true, model });
        expect(move(model, 1, 'after', 0)).toEqual({ ok: true, model });
    });

    test('the input model is never mutated', () => {
        const model = modelOf(['a', 'b', 'c'], 0);
        move(model, 0, 'after', 2);
        expect(model).toEqual(modelOf(['a', 'b', 'c'], 0));
    });

    test('next to either of two identical greetings gives the same result', () => {
        const model = modelOf(['x', 'same', 'same', 'y'], null);
        // "After the first copy" and "before the second" name the same slot.
        expect(move(model, 3, 'after', 1)).toEqual({ ok: true, model: modelOf(['x', 'same', 'y', 'same'], null) });
        expect(move(model, 3, 'before', 2)).toEqual({ ok: true, model: modelOf(['x', 'same', 'y', 'same'], null) });
        expect(move(model, 0, 'after', 1)).toEqual({ ok: true, model: modelOf(['same', 'x', 'same', 'y'], null) });
        expect(move(model, 0, 'before', 2)).toEqual({ ok: true, model: modelOf(['same', 'x', 'same', 'y'], null) });
    });
});
