import assert from 'node:assert/strict';
import { test } from 'node:test';

import { baseOf, draftAfterSend, mergeDraft } from './draft-merge.js';

test('a save is laid over what the draft had changed since its base', () => {
    assert.equal(mergeDraft('Hello', 'Hello world', 'Hey Hello'), 'Hey Hello world');
    assert.equal(mergeDraft('the cat sat', 'the dog sat', 'the cat sat down'), 'the dog sat down');
    assert.equal(mergeDraft('abc def', 'abc', 'abc def ghi'), 'abc ghi', 'a deletion made since stays deleted');
    assert.equal(mergeDraft('x', 'x', 'y'), 'y');
    assert.equal(mergeDraft('x', 'y', 'x'), 'y');
});

test('a change made on both sides is taken once, so merging one already in the draft changes nothing', () => {
    const once = mergeDraft('Hi', 'Hi', 'Hi there');
    assert.equal(mergeDraft('Hi', once, 'Hi there'), 'Hi there');
    const elsewhere = mergeDraft('Hi', 'Hi there', 'Oh, Hi');
    assert.equal(mergeDraft('Hi', elsewhere, 'Hi there'), 'Oh, Hi there');
    assert.equal(mergeDraft('Hi', 'Hi Kit. Also.', 'Hi Kit.'), 'Hi Kit. Also.', 'a change the draft holds within a longer one');
});

test('where both changed the same text differently, both are kept, the draft first', () => {
    assert.equal(mergeDraft('Hi', 'Hi friend', 'Hi there'), 'Hi friend there');
    assert.equal(mergeDraft('', 'x', 'y'), 'xy');
    assert.equal(mergeDraft('a b c', 'a B c', 'a β c'), 'a Bβ c');
});

test('short texts merge as long ones do', () => {
    assert.equal(mergeDraft('ok', 'ok!', 'so ok'), 'so ok!');
    assert.equal(mergeDraft('ab', 'b', 'abc'), 'bc');
    assert.equal(mergeDraft('a', 'ab', 'ca'), 'cab');
});

test('a merge never splits a character in two', () => {
    assert.equal(mergeDraft('x 😀 y', 'x 😃 y', 'x 😀 y!'), 'x 😃 y!');
    const merged = mergeDraft('😀', '😃', '😄');
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(merged), merged);
    assert.ok(merged.includes('😃') && merged.includes('😄'), merged);
});

test('a send takes out exactly what it sent', () => {
    assert.equal(draftAfterSend('Hi Kit.', 'Hi Kit. Also.', 'Hi Kit.'), ' Also.');
    assert.equal(draftAfterSend('', ' Also.', 'Hi Kit.'), ' Also.', 'a sent text never saved before');
    assert.equal(draftAfterSend('Hi', 'Hi', 'Hi there'), '');
});

test('the base is the save\'s changes undone on its text; changes that don\'t fit it are refused', () => {
    assert.equal(baseOf('Hey Hello', [{ from: 0, to: 0, insert: 'Hey ', deleted: '' }]), 'Hello');
    assert.equal(baseOf('one', [{ from: 0, to: 3, insert: 'one', deleted: 'two' }]), 'two');
    assert.equal(baseOf('a-c', [{ from: 1, to: 2, insert: '-', deleted: 'b' }, { from: 3, to: 5, insert: '', deleted: 'de' }]), 'abcde');
    assert.equal(baseOf('same', []), 'same');
    assert.equal(baseOf('abc', [{ from: 0, to: 1, insert: 'Z', deleted: 'a' }]), null, 'an insert the text doesn\'t have');
    assert.equal(baseOf('abc', [{ from: 0, to: 2, insert: 'a', deleted: 'q' }]), null, 'a range unlike what it deleted');
    assert.equal(baseOf('ab', [{ from: 1, to: 1, insert: 'b', deleted: '' }, { from: 0, to: 0, insert: 'a', deleted: '' }]), null, 'out of order');
    assert.equal(baseOf('ab', [{ from: 0, to: 0, insert: 'abc', deleted: '' }]), null, 'past the text\'s end');
    assert.equal(baseOf('ab', 'ab'), null);
    assert.equal(baseOf(3, []), null);
    assert.equal(baseOf('ab', [{ from: -1, to: 0, insert: '', deleted: 'x' }]), null);
});
