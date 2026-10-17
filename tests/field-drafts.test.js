import { describe, test, expect, jest } from '@jest/globals';
import {
    buildFieldDraftKey,
    readFieldDraft,
    writeFieldDraft,
    clearFieldDraft,
    commitFieldDraft,
} from '../public/scripts/field-drafts.js';

/** In-memory stand-in for localStorage's `{ getItem, setItem, removeItem }`. */
function makeStorage(initial = {}) {
    const state = { ...initial };
    return {
        state,
        getItem: jest.fn(key => (Object.hasOwn(state, key) ? String(state[key]) : null)),
        setItem: jest.fn((key, value) => { state[key] = String(value); }),
        removeItem: jest.fn(key => { delete state[key]; }),
    };
}

const content = { kind: 'world-entry', id: 'Book\u00001', field: 'content' };
const comment = { kind: 'world-entry', id: 'Book\u00001', field: 'comment' };

describe('persist and restore', () => {
    test('a typed text survives as the field\'s draft (a new page reads it from the same storage)', () => {
        const storage = makeStorage();
        writeFieldDraft(storage, content, 'typed', 'stored');
        const reloaded = makeStorage(storage.state);
        expect(readFieldDraft(reloaded, content)).toBe('typed');
    });

    test('drafts are per (thing, field)', () => {
        const storage = makeStorage();
        writeFieldDraft(storage, content, 'a', '');
        writeFieldDraft(storage, comment, 'b', '');
        writeFieldDraft(storage, { ...content, id: 'Book\u00002' }, 'c', '');
        expect(readFieldDraft(storage, content)).toBe('a');
        expect(readFieldDraft(storage, comment)).toBe('b');
        expect(readFieldDraft(storage, { ...content, id: 'Book\u00002' })).toBe('c');
    });

    test('ids holding the separator of another key do not collide', () => {
        expect(buildFieldDraftKey({ kind: 'k', id: 'a","b', field: 'c' }))
            .not.toBe(buildFieldDraftKey({ kind: 'k', id: 'a', field: 'b","c' }));
    });

    test('emptying a field is a draft', () => {
        const storage = makeStorage();
        writeFieldDraft(storage, content, '', 'stored');
        expect(readFieldDraft(storage, content)).toBe('');
    });

    test('typing back to the stored text forgets the draft', () => {
        const storage = makeStorage();
        writeFieldDraft(storage, content, 'typed', 'stored');
        writeFieldDraft(storage, content, 'stored', 'stored');
        expect(readFieldDraft(storage, content)).toBeNull();
    });

    test('an incomplete ref never writes', () => {
        const storage = makeStorage();
        writeFieldDraft(storage, { kind: 'world-entry', id: '', field: 'content' }, 'x', '');
        expect(storage.setItem).not.toHaveBeenCalled();
    });

    test('a storage that throws loses nothing the field holds and throws nothing', () => {
        const storage = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); }, removeItem: () => { throw new Error('no'); } };
        expect(() => writeFieldDraft(storage, content, 'x', '')).not.toThrow();
        expect(readFieldDraft(storage, content)).toBeNull();
        expect(() => clearFieldDraft(storage, content)).not.toThrow();
    });
});

describe('commit', () => {
    test('a confirmed commit clears the draft', async () => {
        const storage = makeStorage();
        writeFieldDraft(storage, content, 'typed', 'stored');
        const commit = jest.fn(async () => true);
        await expect(commitFieldDraft(storage, content, 'typed', commit)).resolves.toBe(true);
        expect(commit).toHaveBeenCalledTimes(1);
        expect(commit).toHaveBeenCalledWith('typed');
        expect(readFieldDraft(storage, content)).toBeNull();
    });

    test('the draft is kept while the commit is on its way', async () => {
        const storage = makeStorage();
        /** @type {(value: boolean) => void} */
        let confirm = () => {};
        const pending = commitFieldDraft(storage, content, 'typed', () => new Promise(resolve => { confirm = resolve; }));
        expect(readFieldDraft(makeStorage(storage.state), content)).toBe('typed');
        confirm(true);
        await pending;
        expect(readFieldDraft(storage, content)).toBeNull();
    });

    test('a commit that resolves false keeps the draft', async () => {
        const storage = makeStorage();
        writeFieldDraft(storage, content, 'typed', 'stored');
        await expect(commitFieldDraft(storage, content, 'typed', async () => false)).resolves.toBe(false);
        expect(readFieldDraft(storage, content)).toBe('typed');
    });

    test('a commit that rejects keeps the draft', async () => {
        const storage = makeStorage();
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        await expect(commitFieldDraft(storage, content, 'typed', async () => { throw new Error('offline'); })).resolves.toBe(false);
        expect(readFieldDraft(storage, content)).toBe('typed');
        error.mockRestore();
    });

    test('text typed while the commit was on its way stays the draft', async () => {
        const storage = makeStorage();
        /** @type {(value: boolean) => void} */
        let confirm = () => {};
        const pending = commitFieldDraft(storage, content, 'first', () => new Promise(resolve => { confirm = resolve; }));
        writeFieldDraft(storage, content, 'first and more', 'stored');
        confirm(true);
        await pending;
        expect(readFieldDraft(storage, content)).toBe('first and more');
    });
});
