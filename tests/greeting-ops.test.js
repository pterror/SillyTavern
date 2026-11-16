import { describe, test, expect } from '@jest/globals';
import * as ops from '../src/greeting-ops.js';

const { hashGreetingText } = ops;
const h = hashGreetingText;

/**
 * A card whose greetings have the given texts and ids (ids 0, 1, 2, … when none are given)
 * @param {string[]} texts
 * @param {number|null} defaultIndex
 * @param {number[]} [ids]
 */
const card = (texts, defaultIndex = 0, ids = texts.map((_, k) => k)) => ({
    greetings: texts.map((text, k) => ({ id: ids[k], text })),
    defaultId: defaultIndex === null ? null : ids[defaultIndex],
    nextId: Math.max(-1, ...ids) + 1,
});
const texts = result => result.model.greetings.map(g => g.text);
const ids = result => result.model.greetings.map(g => g.id);
const defaultText = result => result.model.greetings.find(g => g.id === result.model.defaultId)?.text ?? null;

const move = (model, from, side, to) => ops.opMove(
    model,
    from, h(model.greetings.find(g => g.id === from)?.text ?? ''),
    side,
    to, h(model.greetings.find(g => g.id === to)?.text ?? ''),
);

describe('opMove', () => {
    const abcde = () => card(['a', 'b', 'c', 'd', 'e'], null);

    test('before or after an anchor on either side of the source', () => {
        expect(texts(move(abcde(), 1, 'before', 3))).toEqual(['a', 'c', 'b', 'd', 'e']);
        expect(texts(move(abcde(), 1, 'after', 3))).toEqual(['a', 'c', 'd', 'b', 'e']);
        expect(texts(move(abcde(), 3, 'before', 1))).toEqual(['a', 'd', 'b', 'c', 'e']);
        expect(texts(move(abcde(), 3, 'after', 1))).toEqual(['a', 'b', 'd', 'c', 'e']);
        expect(texts(move(abcde(), 0, 'after', 4))).toEqual(['b', 'c', 'd', 'e', 'a']);
    });

    test('says where the ends were', () => {
        expect(move(abcde(), 1, 'after', 3)).toMatchObject({ ok: true, sourcePosition: 1, targetPosition: 3 });
    });

    test('the default stays on its greeting', () => {
        expect(defaultText(move(card(['a', 'b', 'c', 'd'], 1), 1, 'after', 3))).toBe('b');
        expect(defaultText(move(card(['a', 'b', 'c', 'd'], 2), 0, 'after', 3))).toBe('c');
    });

    test('each end is the greeting of its id, wherever it is now', () => {
        const moved = card(['c', 'a', 'b'], null, [2, 0, 1]);
        expect(texts(move(moved, 0, 'after', 2))).toEqual(['c', 'a', 'b']);
        expect(texts(move(moved, 2, 'after', 1))).toEqual(['a', 'b', 'c']);
    });

    test('an end that is gone, or whose text changed, is refused', () => {
        expect(ops.opMove(abcde(), 9, h('b'), 'after', 3, h('d'))).toEqual({ ok: false, reason: 'the greeting is gone' });
        expect(ops.opMove(abcde(), 1, h('x'), 'after', 3, h('d'))).toEqual({ ok: false, reason: 'the greeting changed since it was loaded' });
        expect(ops.opMove(abcde(), 1, h('b'), 'after', 9, h('d'))).toEqual({ ok: false, reason: 'the target greeting is gone' });
        expect(ops.opMove(abcde(), 1, h('b'), 'after', 3, h('x'))).toEqual({ ok: false, reason: 'the target greeting changed since it was loaded' });
    });

    test('an end is never found by its text', () => {
        expect(ops.opMove(abcde(), 0, h('b'), 'after', 3, h('d'))).toEqual({ ok: false, reason: 'the greeting changed since it was loaded' });
        expect(ops.opMove(abcde(), 1, h('b'), 'after', 4, h('d'))).toEqual({ ok: false, reason: 'the target greeting changed since it was loaded' });
    });

    test('a greeting cannot be moved next to itself', () => {
        expect(move(abcde(), 2, 'before', 2)).toEqual({ ok: false, reason: 'cannot move a greeting next to itself' });
    });

    test('a no-op placement returns a model equal to the input', () => {
        const model = card(['a', 'b', 'c'], 1);
        expect(move(model, 1, 'before', 2).model).toEqual(model);
        expect(move(model, 1, 'after', 0).model).toEqual(model);
    });

    test('the input model is never mutated', () => {
        const model = card(['a', 'b', 'c'], 0);
        move(model, 0, 'after', 2);
        expect(model).toEqual(card(['a', 'b', 'c'], 0));
    });
});

describe('opEdit', () => {
    const abc = () => card(['a', 'b', 'c'], 0);

    test('edits the greeting of the id when its text is the one read', () => {
        expect(ops.opEdit(abc(), 1, h('b'), 'B')).toEqual({ ok: true, model: card(['a', 'B', 'c'], 0), position: 1, id: 1 });
    });

    test('the greeting is found by its id wherever it moved', () => {
        const result = ops.opEdit(card(['c', 'a', 'b'], 0, [2, 0, 1]), 1, h('b'), 'B');
        expect(texts(result)).toEqual(['c', 'a', 'B']);
        expect(result).toMatchObject({ position: 2, id: 1 });
    });

    test('the default stays where it was', () => {
        expect(defaultText(ops.opEdit(card(['a', 'b', 'c'], 2), 1, h('b'), 'B'))).toBe('c');
    });

    test('refuses a greeting that is gone, or whose text changed, and never takes another with the text', () => {
        expect(ops.opEdit(abc(), 7, h('b'), 'X')).toEqual({ ok: false, reason: 'the greeting is gone' });
        expect(ops.opEdit(abc(), 1, h('x'), 'X')).toEqual({ ok: false, reason: 'the greeting changed since it was loaded' });
        expect(ops.opEdit(abc(), 0, h('c'), 'C')).toEqual({ ok: false, reason: 'the greeting changed since it was loaded' });
    });

    test('refuses empty text', () => {
        expect(ops.opEdit(abc(), 1, h('b'), '')).toEqual({ ok: false, reason: 'refused to blank stored greeting text' });
    });

    test('never mutates the input model', () => {
        const model = abc();
        ops.opEdit(model, 2, h('c'), 'C');
        expect(model).toEqual(abc());
    });
});

describe('opDelete', () => {
    const abc = (defaultIndex = 0) => card(['a', 'b', 'c'], defaultIndex);

    test('deletes the greeting of the id when its text is the one read', () => {
        expect(ops.opDelete(abc(), 1, h('b'))).toEqual({ ok: true, model: { ...card(['a', 'c'], 0, [0, 2]), nextId: 3 }, position: 1, id: 1 });
    });

    test('the default stays on its greeting, or is none when it is the one deleted', () => {
        expect(defaultText(ops.opDelete(abc(2), 1, h('b')))).toBe('c');
        expect(ops.opDelete(abc(1), 1, h('b')).model.defaultId).toBeNull();
    });

    test('refuses a greeting that is gone, or whose text changed, and never takes another with the text', () => {
        expect(ops.opDelete(abc(), 3, h('x'))).toEqual({ ok: false, reason: 'the greeting is gone' });
        expect(ops.opDelete(abc(), 1, h('x'))).toEqual({ ok: false, reason: 'the greeting changed since it was loaded' });
        expect(ops.opDelete(abc(), 0, h('c'))).toEqual({ ok: false, reason: 'the greeting changed since it was loaded' });
    });

    test('never mutates the input model', () => {
        const model = abc();
        ops.opDelete(model, 2, h('c'));
        expect(model).toEqual(abc());
    });
});

describe('opSetDefault', () => {
    const abc = () => card(['a', 'b', 'c'], 0);

    test('makes the greeting of the id the default when its text is the one read', () => {
        expect(ops.opSetDefault(abc(), 1, h('b'))).toEqual({ ok: true, model: card(['a', 'b', 'c'], 1), position: 1, id: 1 });
    });

    test('an already default greeting is no change', () => {
        expect(ops.opSetDefault(abc(), 0, h('a')).model).toEqual(abc());
    });

    test('refuses a greeting that is gone, or whose text changed, and never takes another with the text', () => {
        expect(ops.opSetDefault(abc(), 3, h('x'))).toEqual({ ok: false, reason: 'the greeting is gone' });
        expect(ops.opSetDefault(abc(), 1, h('x'))).toEqual({ ok: false, reason: 'the greeting changed since it was loaded' });
        expect(ops.opSetDefault(abc(), 1, h('c'))).toEqual({ ok: false, reason: 'the greeting changed since it was loaded' });
    });
});

describe('opUnsetDefault', () => {
    test('clears the default when it is the greeting of the id, with the text read', () => {
        expect(ops.opUnsetDefault(card(['a', 'b', 'c'], 1), 1, h('b'))).toEqual({ ok: true, model: card(['a', 'b', 'c'], null) });
    });

    test('refuses when the default is another greeting, or its text changed', () => {
        expect(ops.opUnsetDefault(card(['a', 'b', 'c'], 2), 1, h('b'))).toEqual({ ok: false, reason: 'default greeting changed since it was loaded' });
        expect(ops.opUnsetDefault(card(['a', 'b', 'c'], 1), 1, h('x'))).toEqual({ ok: false, reason: 'default greeting changed since it was loaded' });
    });

    test('with no default any more it is no change', () => {
        expect(ops.opUnsetDefault(card(['a', 'b'], null), 1, h('b'))).toEqual({ ok: true, model: card(['a', 'b'], null) });
    });

    test('never mutates the input model', () => {
        const model = card(['a', 'b'], 1);
        ops.opUnsetDefault(model, 1, h('b'));
        expect(model).toEqual(card(['a', 'b'], 1));
    });
});

describe('an edit sent again after it was stored', () => {
    test('succeeds when the greeting of the id already has the new text', () => {
        const model = card(['a', 'X', 'c'], 0);
        expect(ops.opEdit(model, 1, h('b'), 'X')).toEqual({ ok: true, model, position: 1, id: 1 });
    });

    test('is refused when only another greeting has the new text', () => {
        expect(ops.opEdit(card(['X', 'a', 'c'], 0), 1, h('b'), 'X')).toEqual({ ok: false, reason: 'the greeting changed since it was loaded' });
    });
});

describe('opAdd and opAppend', () => {
    test('append puts the text after the last greeting, whatever the length, and keeps the default', () => {
        expect(texts(ops.opAppend(card(['a', 'b'], 1), 'c'))).toEqual(['a', 'b', 'c']);
        expect(defaultText(ops.opAppend(card(['a', 'b'], 1), 'c'))).toBe('b');
    });

    test('the first greeting of a card with none is its default, inserted or appended', () => {
        expect(ops.opAdd(card([], null), 0, 0, 'Hi')).toEqual({ ok: true, model: card(['Hi'], 0), position: 0, id: 0 });
        expect(ops.opAppend(card([], null), 'Hi')).toEqual({ ok: true, model: card(['Hi'], 0), position: 0, id: 0 });
    });

    test('a later one leaves the default where it is', () => {
        expect(defaultText(ops.opAdd(card(['a'], null), 0, 1, 'b'))).toBeNull();
        expect(defaultText(ops.opAdd(card(['a', 'b'], 1), 1, 2, 'c'))).toBe('b');
    });

    test('refuses empty text, or a list that changed length', () => {
        expect(ops.opAppend(card(['a'], 0), '')).toEqual({ ok: false, reason: 'refused to add empty greeting text' });
        expect(ops.opAdd(card(['a'], 0), 1, 2, 'b')).toEqual({ ok: false, reason: 'greeting list length changed since it was loaded' });
    });

    test('never mutates the input model', () => {
        const model = card(['a'], 0);
        ops.opAppend(model, 'b');
        expect(model).toEqual(card(['a'], 0));
    });
});

describe('a greeting keeps its id', () => {
    const abc = () => card(['a', 'b', 'c'], 1, [4, 7, 9]);

    test('through an edit, a move and a delete of another; an add takes the next id and says it', () => {
        expect(ids(ops.opEdit({ ...abc(), nextId: 12 }, 7, h('b'), 'B'))).toEqual([4, 7, 9]);
        expect(ids(move(abc(), 4, 'after', 9))).toEqual([7, 9, 4]);
        expect(ids(ops.opDelete(abc(), 4, h('a')))).toEqual([7, 9]);
        const added = ops.opAdd({ ...abc(), nextId: 12 }, 1, 3, 'x');
        expect(ids(added)).toEqual([4, 12, 7, 9]);
        expect(added.id).toBe(12);
        expect(added.model.nextId).toBe(13);
    });

    test('the default is an id: it stays on its greeting wherever that moves, and goes with it', () => {
        expect(move(abc(), 7, 'after', 9).model.defaultId).toBe(7);
        expect(ops.opAdd(abc(), 0, 3, 'x').model.defaultId).toBe(7);
        expect(ops.opDelete(abc(), 7, h('b')).model.defaultId).toBeNull();
        expect(ops.opSetDefault(abc(), 9, h('c')).model.defaultId).toBe(9);
    });
});

describe('a card has each greeting text once', () => {
    const ab = () => card(['a', 'b'], 0, [3, 5]);

    test('an add or an edit to another greeting\'s text is refused, naming that greeting by its place and id', () => {
        expect(ops.opAdd(ab(), 2, 2, 'a')).toEqual({ ok: false, reason: 'same as greeting 1', same: 0, sameId: 3 });
        expect(ops.opAppend(ab(), 'b')).toEqual({ ok: false, reason: 'same as greeting 2', same: 1, sameId: 5 });
        expect(ops.opEdit(ab(), 5, h('b'), 'a')).toEqual({ ok: false, reason: 'same as greeting 1', same: 0, sameId: 3 });
    });

    test('whitespace makes a different text; an edit to its own text is no change', () => {
        expect(ops.opAppend(ab(), 'a ').ok).toBe(true);
        expect(ops.opEdit(ab(), 3, h('a'), 'a')).toEqual({ ok: true, model: ab(), position: 0, id: 3 });
    });
});

describe('greetingOperation', () => {
    test('names each existing greeting by its id', () => {
        const model = card(['a', 'b'], 0, [3, 5]);
        expect(texts(ops.greetingOperation({ op: 'edit', id: 5, hash: h('b'), text: 'B' })(model))).toEqual(['a', 'B']);
        expect(texts(ops.greetingOperation({ op: 'delete', id: 3, hash: h('a') })(model))).toEqual(['b']);
        expect(texts(ops.greetingOperation({ op: 'move', id: 3, hash: h('a'), side: 'after', target: 5, targetHash: h('b') })(model))).toEqual(['b', 'a']);
        expect(ops.greetingOperation({ op: 'default', id: 5, hash: h('b') })(model).model.defaultId).toBe(5);
        expect(ops.greetingOperation({ op: 'undefault', id: 3, hash: h('a') })(model).model.defaultId).toBeNull();
    });
});
