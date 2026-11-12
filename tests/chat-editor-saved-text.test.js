import { describe, expect, test } from '@jest/globals';
import { savedText } from '../public/scripts/chat-text/saved-text.js';

describe('an editor\'s stored text', () => {
    test('is the text it opened with, including none of its edits', () => {
        expect(savedText('hello').port.get()).toEqual({ text: 'hello', includes: undefined });
    });

    test('is what a save stored, with the latest edit that save held, and is told so', () => {
        const stored = savedText('a');
        let heard = 0;
        stored.port.watch(() => heard++);
        stored.saved('ab', '1:2', 1);
        expect(stored.port.get()).toEqual({ text: 'ab', includes: '1:2' });
        expect(heard).toBe(1);
    });

    test('never goes back to an older save answered after a newer one', () => {
        const stored = savedText('a');
        stored.saved('abc', '1:3', 2);
        stored.saved('ab', '1:2', 1);
        expect(stored.port.get()).toEqual({ text: 'abc', includes: '1:3' });
    });

    test('stops telling a listener that stopped', () => {
        const stored = savedText('a');
        let heard = 0;
        const stop = stored.port.watch(() => heard++);
        stop();
        stored.saved('b', '1:1', 1);
        expect(heard).toBe(0);
    });
});
