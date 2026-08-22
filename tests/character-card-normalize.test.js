import { describe, test, expect } from '@jest/globals';
import { unsetPrivateFields } from '../src/character-card-normalize.js';

// unsetPrivateFields() strips per-user local state (favorite flag, active chat file) from a character object
// before it's shared - either inbound (import, so a shared card's local state doesn't leak into the importer's
// library) or outbound (export, so the exporter's own local state doesn't leak into the shared file). It used to
// live in src/endpoints/characters.js (added in 76c59cbc5, "Unset chat field on import/export") but was dropped
// during the phase-1 SQLite metadata store refactor (f872377eb) when getCharaCardV2/convertToV2/readFromV2/
// charaFormatData were moved out to this module - every sibling function made the move except this one, leaving
// all 5 of characters.js's call sites referencing an undefined function. It's re-added here rather than back in
// characters.js so it lives alongside the rest of the normalization helpers it was extracted with.
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
