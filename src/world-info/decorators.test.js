import assert from 'node:assert/strict';
import { parseDecorators, getDecoratorActivation } from './decorators.js';

// No decorators - content passes through unchanged
assert.deepEqual(parseDecorators('Some plain content.'), [[], 'Some plain content.']);

// Single known decorator
assert.deepEqual(
    parseDecorators('@@activate\nThe rest of the content.'),
    [['@@activate'], 'The rest of the content.'],
);
assert.deepEqual(
    parseDecorators('@@dont_activate\nSuppressed entry text.'),
    [['@@dont_activate'], 'Suppressed entry text.'],
);

// Multiple decorators stack
assert.deepEqual(
    parseDecorators('@@activate\n@@dont_activate\nBody text.'),
    [['@@activate', '@@dont_activate'], 'Body text.'],
);

// An unrecognized "@@something" line is silently dropped (not kept as decorator or content)
assert.deepEqual(
    parseDecorators('@@unknown_thing\nSome text.'),
    [[], 'Some text.'],
);

// @@@ escape: the FIRST @@@-prefixed line (not already in a "fallback" state from an unrecognized
// @@ line before it) is treated as an escaped/literal attempt and silently dropped, not processed
// as a real decorator.
assert.deepEqual(
    parseDecorators('@@@activate\nReal content here.'),
    [[], 'Real content here.'],
);

// @@@ escape unwraps into a real decorator once an unrecognized @@ line has already set the
// "fallback" state - this is the actual escape mechanism's point: a genuine unrecognized decorator
// line puts the parser into a mode where a subsequent @@@-prefixed KNOWN decorator IS processed
// (with the leading @ stripped).
assert.deepEqual(
    parseDecorators('@@unknown\n@@@activate\nBody.'),
    [['@@activate'], 'Body.'],
);

// A trailing blank line before real content is still just content (no @@ prefix)
assert.deepEqual(
    parseDecorators('@@activate\n\nContent after a blank line.'),
    [['@@activate'], '\nContent after a blank line.'],
);

// getDecoratorActivation
assert.equal(getDecoratorActivation(['@@activate']), 'activate');
assert.equal(getDecoratorActivation(['@@dont_activate']), 'suppress');
assert.equal(getDecoratorActivation([]), null);
assert.equal(getDecoratorActivation(undefined), null);
// @@activate takes precedence if (implausibly) both are present, matching the client's if/else-if order
assert.equal(getDecoratorActivation(['@@activate', '@@dont_activate']), 'activate');

console.log('decorators.test.js: all assertions passed');
