import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeDraft, unionOf } from './draft-merge.js';

test('a text written over a draft is laid over what was changed in it since', () => {
    assert.equal(mergeDraft('hello world', 'hello brave world', 'hello world!'), 'hello brave world!');
    assert.equal(mergeDraft('one two three', 'ONE two three', 'one two THREE'), 'ONE two THREE');
    assert.equal(mergeDraft('abc', 'abXc', 'abYc'), 'abXYc', 'both inserts at one place are kept, the draft\'s first');
});

test('a text that changed nothing, or only what the draft has, is the draft', () => {
    assert.equal(mergeDraft('base', 'base and more', 'base'), 'base and more');
    assert.equal(mergeDraft('base', 'same', 'same'), 'same');
    assert.equal(mergeDraft('base', 'base', 'mine'), 'mine');
});

test('what one side took out and the other kept is out; what either wrote stays', () => {
    assert.equal(mergeDraft('keep drop keep', 'keep keep', 'keep drop keep, added'), 'keep keep, added');
    assert.equal(mergeDraft('sent text', '', 'sent text and more'), ' and more', 'a send cleared the draft: only what was written since stays');
});

test('a character outside the BMP is never split', () => {
    const merged = mergeDraft('a 😀 b', 'a 😁 b', 'a 😀 b c');
    assert.doesNotMatch(merged, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    assert.ok(merged.endsWith(' c'));
});

test('two texts with no draft between them in common are both kept whole', () => {
    assert.equal(unionOf('hello A end', 'hello B end'), 'hello AB end');
    assert.equal(unionOf('', 'x'), 'x');
    assert.equal(unionOf('x', ''), 'x');
    assert.equal(unionOf('same', 'same'), 'same');
    const both = unionOf('first text', 'quite another');
    assert.ok(both.includes('first text') && both.includes('quite another'));
});
