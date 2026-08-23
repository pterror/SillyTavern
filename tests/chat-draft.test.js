import { describe, test, expect, jest } from '@jest/globals';
import {
    buildDraftStorageKey,
    saveDraft,
    loadDraft,
    clearDraft,
} from '../public/scripts/chat-draft.js';

/** Minimal in-memory stand-in for localStorage's `{ getItem, setItem, removeItem }` surface. */
function makeStorage(initial = {}) {
    const state = { ...initial };
    return {
        state,
        getItem: jest.fn(key => (Object.hasOwn(state, key) ? String(state[key]) : null)),
        setItem: jest.fn((key, value) => { state[key] = String(value); }),
        removeItem: jest.fn(key => { delete state[key]; }),
    };
}

const charContext = { type: 'character', id: 'Seraphina.png', chatId: '2024-01-01@01h02m03s' };
const groupContext = { type: 'group', id: 'group-abc123', chatId: '2024-01-01@01h02m03s' };

describe('buildDraftStorageKey', () => {
    test('keys by the full type/id/chatId triple, not just chatId', () => {
        const key1 = buildDraftStorageKey(charContext);
        const key2 = buildDraftStorageKey(groupContext);
        // Same chatId, different type/id - must not collide, since chat file names aren't
        // guaranteed globally unique across characters/groups.
        expect(key1).not.toBe(key2);
    });

    test('two different characters with the same chatId get different keys', () => {
        const other = { ...charContext, id: 'OtherCharacter.png' };
        expect(buildDraftStorageKey(charContext)).not.toBe(buildDraftStorageKey(other));
    });
});

describe('saveDraft / loadDraft', () => {
    test('round-trips non-empty text', () => {
        const storage = makeStorage();
        saveDraft(storage, charContext, 'hello, unsent world');
        expect(loadDraft(storage, charContext)).toBe('hello, unsent world');
    });

    test('drafts for different chat contexts do not leak into each other', () => {
        const storage = makeStorage();
        saveDraft(storage, charContext, 'for the character chat');
        saveDraft(storage, groupContext, 'for the group chat');
        expect(loadDraft(storage, charContext)).toBe('for the character chat');
        expect(loadDraft(storage, groupContext)).toBe('for the group chat');
    });

    test('loadDraft returns null when nothing was ever saved for that context', () => {
        const storage = makeStorage();
        expect(loadDraft(storage, charContext)).toBeNull();
    });

    test('saving an empty string clears any previously-stored draft instead of persisting an empty entry', () => {
        const storage = makeStorage();
        saveDraft(storage, charContext, 'a draft in progress');
        saveDraft(storage, charContext, '');
        expect(loadDraft(storage, charContext)).toBeNull();
        expect(storage.removeItem).toHaveBeenCalledWith(buildDraftStorageKey(charContext));
    });

    test('saving a whitespace-only string also clears the draft', () => {
        const storage = makeStorage();
        saveDraft(storage, charContext, 'a draft in progress');
        saveDraft(storage, charContext, '   \n  ');
        expect(loadDraft(storage, charContext)).toBeNull();
    });

    test('overwrites a previously-saved draft for the same context', () => {
        const storage = makeStorage();
        saveDraft(storage, charContext, 'first draft');
        saveDraft(storage, charContext, 'second, longer draft');
        expect(loadDraft(storage, charContext)).toBe('second, longer draft');
    });
});

describe('clearDraft', () => {
    test('removes a stored draft', () => {
        const storage = makeStorage();
        saveDraft(storage, charContext, 'to be sent');
        clearDraft(storage, charContext);
        expect(loadDraft(storage, charContext)).toBeNull();
    });

    test('is a no-op when nothing was stored', () => {
        const storage = makeStorage();
        expect(() => clearDraft(storage, charContext)).not.toThrow();
        expect(storage.removeItem).toHaveBeenCalled();
    });

    test('clearing one context leaves other contexts untouched', () => {
        const storage = makeStorage();
        saveDraft(storage, charContext, 'character draft');
        saveDraft(storage, groupContext, 'group draft');
        clearDraft(storage, charContext);
        expect(loadDraft(storage, charContext)).toBeNull();
        expect(loadDraft(storage, groupContext)).toBe('group draft');
    });
});

describe('incomplete context handling', () => {
    const incompleteContexts = [
        { name: 'undefined context', context: undefined },
        { name: 'missing type', context: { id: 'x', chatId: 'y' } },
        { name: 'missing id', context: { type: 'character', chatId: 'y' } },
        { name: 'empty id', context: { type: 'character', id: '', chatId: 'y' } },
        { name: 'missing chatId', context: { type: 'character', id: 'x' } },
        { name: 'empty chatId', context: { type: 'character', id: 'x', chatId: '' } },
        { name: 'unknown type', context: { type: 'neither', id: 'x', chatId: 'y' } },
    ];

    test.each(incompleteContexts)('saveDraft is a no-op for $name (never writes to a fallback key)', ({ context }) => {
        const storage = makeStorage();
        saveDraft(storage, context, 'should not be persisted anywhere');
        expect(storage.setItem).not.toHaveBeenCalled();
    });

    test.each(incompleteContexts)('loadDraft returns null for $name instead of guessing a key', ({ context }) => {
        const storage = makeStorage();
        expect(loadDraft(storage, context)).toBeNull();
    });

    test.each(incompleteContexts)('clearDraft is a no-op for $name', ({ context }) => {
        const storage = makeStorage();
        expect(() => clearDraft(storage, context)).not.toThrow();
        expect(storage.removeItem).not.toHaveBeenCalled();
    });
});
