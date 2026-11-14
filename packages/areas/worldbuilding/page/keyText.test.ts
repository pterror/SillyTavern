import { expect, test } from 'vite-plus/test';
import { isPattern, splitKeys } from './keyText.ts';

test('keys are separated by commas or lines, trimmed, none empty or repeated', () => {
    expect(splitKeys('a, b, c')).toEqual(['a', 'b', 'c']);
    expect(splitKeys(' a ,\n\nb\r\nc,, a')).toEqual(['a', 'b', 'c']);
    expect(splitKeys('  ')).toEqual([]);
    expect(splitKeys('the innkeeper')).toEqual(['the innkeeper']);
});

test('a comma inside a pattern does not separate, and a pattern that never closes is only words', () => {
    expect(splitKeys('a, /b{1,2}/i, c')).toEqual(['a', '/b{1,2}/i', 'c']);
    expect(splitKeys('/lamp(s|ed)?/, /x/')).toEqual(['/lamp(s|ed)?/', '/x/']);
    expect(splitKeys('/open, a')).toEqual(['/open', 'a']);
    expect(splitKeys('a/b, c')).toEqual(['a/b', 'c']);
});

test('a key is a pattern as the engine reads it', () => {
    expect(isPattern('/ilse+/i')).toBe(true);
    expect(isPattern('/ilse')).toBe(false);
    expect(isPattern('/a/b/')).toBe(false);
    expect(isPattern('/(/')).toBe(false);
    expect(isPattern('ilse')).toBe(false);
});
