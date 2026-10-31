import { describe, test, expect } from '@jest/globals';
import path from 'node:path';
import { setConfigFilePath } from '../src/util.js';

setConfigFilePath(path.join(process.cwd(), '..', 'default', 'config.yaml'));
const { unsetPrivateFields } = await import('../src/character-card-normalize.js');

describe('unsetPrivateFields', () => {
    test('unsets top-level fav, mirrors it false on V1-shaped cards', () => {
        const char = { name: 'Test', fav: true, chat: 'Test - 2024-1-1 @00h00m00s' };
        unsetPrivateFields(char);
        expect(char.fav).toBe(false);
        expect(char.chat).toBeUndefined();
    });

    test('unsets data.extensions.fav on V2-shaped cards without touching sibling extensions', () => {
        const char = {
            name: 'Test',
            data: { extensions: { fav: true, world: 'Some World', talkativeness: 0.5 } },
            chat: 'Test - 2024-1-1 @00h00m00s',
        };
        unsetPrivateFields(char);
        expect(char.data.extensions.fav).toBe(false);
        expect(char.data.extensions.world).toBe('Some World');
        expect(char.data.extensions.talkativeness).toBe(0.5);
        expect(char.chat).toBeUndefined();
    });

    test('sets both fav locations to false even when the card had neither field set', () => {
        const char = { name: 'Test' };
        unsetPrivateFields(char);
        expect(char.fav).toBe(false);
        expect(char.data.extensions.fav).toBe(false);
        expect(char.chat).toBeUndefined();
    });

    test('leaves unrelated top-level fields untouched', () => {
        const char = {
            name: 'Test',
            description: 'A test character',
            create_date: '2024-1-1 @00h00m00s',
            fav: true,
            chat: 'Test - 2024-1-1 @00h00m00s',
        };
        unsetPrivateFields(char);
        expect(char.name).toBe('Test');
        expect(char.description).toBe('A test character');
        expect(char.create_date).toBe('2024-1-1 @00h00m00s');
    });

    test('mutates the object in place and also returns undefined (matches util.mutateJsonString\'s mutation contract)', () => {
        const char = { name: 'Test', fav: true };
        const result = unsetPrivateFields(char);
        expect(result).toBeUndefined();
        expect(char.fav).toBe(false);
    });
});
