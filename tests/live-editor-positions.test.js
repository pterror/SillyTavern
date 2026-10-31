import { describe, test, expect } from '@jest/globals';
import { sourcePosition } from '../public/scripts/live-editor/positions.js';

const at = (/** @type {string} */ shown) => ({ text: shown.replace('|', ''), offset: shown.indexOf('|') });
const expected = (/** @type {string} */ written) => ({ source: written.replace('|', ''), pos: written.indexOf('|') });

describe('a point in the rendered text, in the source', () => {
    test.each([
        ['markup before the point', 'Some em and strong tar|get.', 'Some *em* and **strong** tar|get.'],
        ['list numbers and line breaks', 'first item\nsecond item with the tar|get word\nthird', '1. first item\n2. second item with the tar|get word\n3. third'],
        ['the same word again', 'the target and the tar|get', 'the **target** and the tar|get'],
        ['entities and HTML', 'Tom & Jerry in red tar|get', 'Tom &amp; Jerry <font color="red">in red</font> tar|get'],
        ['a macro\'s value goes to the word before it', 'Hello there| Seraphina', 'Hello there| {{char}}'],
        ['the end of a word', 'one two|', 'one two|'],
        ['nothing found', '|', '|'],
    ])('%s', (_, shown, written) => {
        const { source, pos } = expected(written);
        expect(sourcePosition(source, at(shown))).toBe(pos);
    });
});
