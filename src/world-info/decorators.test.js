import assert from 'node:assert/strict';
import { parseDecorators, getDecoratorActivation } from './decorators.js';

assert.deepEqual(parseDecorators('Some plain content.'), [[], 'Some plain content.']);

assert.deepEqual(
    parseDecorators('@@activate\nThe rest of the content.'),
    [['@@activate'], 'The rest of the content.'],
);
assert.deepEqual(
    parseDecorators('@@dont_activate\nSuppressed entry text.'),
    [['@@dont_activate'], 'Suppressed entry text.'],
);

assert.deepEqual(
    parseDecorators('@@activate\n@@dont_activate\nBody text.'),
    [['@@activate', '@@dont_activate'], 'Body text.'],
);

assert.deepEqual(
    parseDecorators('@@unknown_thing\nSome text.'),
    [[], 'Some text.'],
);

assert.deepEqual(
    parseDecorators('@@@activate\nReal content here.'),
    [[], 'Real content here.'],
);

assert.deepEqual(
    parseDecorators('@@unknown\n@@@activate\nBody.'),
    [['@@activate'], 'Body.'],
);

assert.deepEqual(
    parseDecorators('@@activate\n\nContent after a blank line.'),
    [['@@activate'], '\nContent after a blank line.'],
);

assert.equal(getDecoratorActivation(['@@activate']), 'activate');
assert.equal(getDecoratorActivation(['@@dont_activate']), 'suppress');
assert.equal(getDecoratorActivation([]), null);
assert.equal(getDecoratorActivation(undefined), null);
assert.equal(getDecoratorActivation(['@@activate', '@@dont_activate']), 'activate');

console.log('decorators.test.js: all assertions passed');
