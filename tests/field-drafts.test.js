import { describe, test, expect, jest } from '@jest/globals';
import {
    buildFieldDraftKey,
    readFieldDraft,
    writeFieldDraft,
    clearFieldDraft,
    commitFieldDraft,
    hasFieldDrafts,
    fieldEventAction,
    bindFieldDraft,
    clearThingDrafts,
    clearDraftsUnder,
    revertChanges,
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

const content = { kind: 'world-entry', id: 'book:7:1', field: 'content' };
const comment = { kind: 'world-entry', id: 'book:7:1', field: 'comment' };

describe('persist and restore', () => {
    test('a typed text survives as the field\'s draft (a new page reads it from the same storage)', () => {
        const storage = makeStorage();
        writeFieldDraft(storage, content, 'typed', 'stored');
        const reloaded = makeStorage(storage.state);
        expect(readFieldDraft(reloaded, content)).toEqual({ text: 'typed', base: 'stored' });
    });

    test('drafts are per (thing, field)', () => {
        const storage = makeStorage();
        writeFieldDraft(storage, content, 'a', '');
        writeFieldDraft(storage, comment, 'b', '');
        writeFieldDraft(storage, { ...content, id: 'book:7:2' }, 'c', '');
        expect(readFieldDraft(storage, content)?.text).toBe('a');
        expect(readFieldDraft(storage, comment)?.text).toBe('b');
        expect(readFieldDraft(storage, { ...content, id: 'book:7:2' })?.text).toBe('c');
    });

    test('ids holding the separator of another key do not collide', () => {
        expect(buildFieldDraftKey({ kind: 'k', id: 'a","b', field: 'c' }))
            .not.toBe(buildFieldDraftKey({ kind: 'k', id: 'a', field: 'b","c' }));
    });

    test('a draft keeps the stored text it was started from', () => {
        const storage = makeStorage();
        writeFieldDraft(storage, content, 'a', 'stored');
        writeFieldDraft(storage, content, 'ab', 'stored elsewhere since');
        expect(readFieldDraft(storage, content)).toEqual({ text: 'ab', base: 'stored' });
    });

    test('emptying a field is a draft', () => {
        const storage = makeStorage();
        writeFieldDraft(storage, content, '', 'stored');
        expect(readFieldDraft(storage, content)?.text).toBe('');
    });

    test('typing back to the stored text forgets the draft', () => {
        const storage = makeStorage();
        writeFieldDraft(storage, content, 'typed', 'stored');
        writeFieldDraft(storage, content, 'stored', 'stored');
        expect(readFieldDraft(storage, content)).toBeNull();
    });

    test('whether a thing has drafts is kept as its fields come and go', () => {
        const storage = makeStorage();
        expect(hasFieldDrafts(storage, 'world-entry', 'book:7:1')).toBe(false);
        writeFieldDraft(storage, content, 'a', '');
        writeFieldDraft(storage, comment, 'b', '');
        clearFieldDraft(storage, content);
        expect(hasFieldDrafts(storage, 'world-entry', 'book:7:1')).toBe(true);
        clearFieldDraft(storage, comment);
        expect(hasFieldDrafts(storage, 'world-entry', 'book:7:1')).toBe(false);
        expect(Object.keys(storage.state)).toEqual([]);
    });

    test('an incomplete ref never writes', () => {
        const storage = makeStorage();
        writeFieldDraft(storage, { kind: 'world-entry', id: '', field: 'content' }, 'x', '');
        writeFieldDraft(storage, null, 'x', '');
        expect(storage.setItem).not.toHaveBeenCalled();
    });

    test('a storage that throws throws nothing', () => {
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
        await expect(commitFieldDraft(storage, content, 'typed', 'stored', commit)).resolves.toBe(true);
        expect(commit).toHaveBeenCalledTimes(1);
        expect(commit).toHaveBeenCalledWith('typed');
        expect(readFieldDraft(storage, content)).toBeNull();
    });

    test('the draft is kept while the commit is on its way', async () => {
        const storage = makeStorage();
        /** @type {(value: boolean) => void} */
        let confirm = () => {};
        const pending = commitFieldDraft(storage, content, 'typed', 'stored', () => new Promise(resolve => { confirm = resolve; }));
        expect(readFieldDraft(makeStorage(storage.state), content)?.text).toBe('typed');
        confirm(true);
        await pending;
        expect(readFieldDraft(storage, content)).toBeNull();
    });

    test('a commit that resolves false keeps the draft', async () => {
        const storage = makeStorage();
        writeFieldDraft(storage, content, 'typed', 'stored');
        await expect(commitFieldDraft(storage, content, 'typed', 'stored', async () => false)).resolves.toBe(false);
        expect(readFieldDraft(storage, content)).toEqual({ text: 'typed', base: 'stored' });
    });

    test('a commit that rejects keeps the draft', async () => {
        const storage = makeStorage();
        const error = jest.spyOn(console, 'error').mockImplementation(() => {});
        await expect(commitFieldDraft(storage, content, 'typed', 'stored', async () => { throw new Error('offline'); })).resolves.toBe(false);
        expect(readFieldDraft(storage, content)?.text).toBe('typed');
        error.mockRestore();
    });

    test('text typed while the commit was on its way stays the draft, started from the committed text', async () => {
        const storage = makeStorage();
        /** @type {(value: boolean) => void} */
        let confirm = () => {};
        const pending = commitFieldDraft(storage, content, 'first', 'stored', () => new Promise(resolve => { confirm = resolve; }));
        writeFieldDraft(storage, content, 'first and more', 'stored');
        confirm(true);
        await pending;
        expect(readFieldDraft(storage, content)).toEqual({ text: 'first and more', base: 'first' });
    });
});

describe('commit points', () => {
    test.each([
        ['text', { type: 'input', user: true }, { draft: true, commit: false }],
        ['line', { type: 'input', user: true }, { draft: true, commit: false }],
        ['number', { type: 'input', user: true }, { draft: true, commit: false }],
        ['toggle', { type: 'input', user: true }, { draft: true, commit: true }],
        ['text', { type: 'input', user: false }, { draft: true, commit: true }],
        ['number', { type: 'change' }, { draft: true, commit: true }],
        ['text', { type: 'blur' }, { draft: false, commit: true }],
        ['text', { type: 'close' }, { draft: false, commit: true }],
        ['line', { type: 'keydown', key: 'Enter' }, { draft: false, commit: true }],
        ['number', { type: 'keydown', key: 'Enter' }, { draft: false, commit: true }],
        ['text', { type: 'keydown', key: 'Enter' }, { draft: false, commit: false }],
        ['line', { type: 'keydown', key: 'Enter', isComposing: true }, { draft: false, commit: false }],
        ['line', { type: 'keydown', key: 'Enter', shiftKey: true }, { draft: false, commit: false }],
        ['line', { type: 'keydown', key: 'a' }, { draft: false, commit: false }],
    ])('%s field, %o', (type, event, expected) => {
        // @ts-ignore
        expect(fieldEventAction(type, event)).toEqual(expected);
    });
});

/**
 * A field on a page: what it holds, what is stored for it, and a commit that stores it (or fails).
 * @param {object} [options]
 * @param {'text'|'line'|'number'|'toggle'} [options.type]
 * @param {string} [options.stored]
 * @param {ReturnType<typeof makeStorage>} [options.storage]
 */
function makeField({ type = 'text', stored = 'stored', storage = makeStorage() } = {}) {
    const field = {
        storage,
        value: stored,
        stored,
        fail: false,
        commit: jest.fn(async (/** @type {string} */ text) => {
            if (field.fail) return false;
            field.stored = text;
            return true;
        }),
    };
    const binding = bindFieldDraft({
        storage,
        ref: content,
        type,
        stored: () => field.stored,
        read: () => field.value,
        show: (text) => { field.value = text; },
        commit: field.commit,
    });
    /** @param {string} text */
    const typeText = async (text) => {
        field.value = text;
        await binding.handle({ type: 'input', user: true });
    };
    return { field, binding, typeText };
}

describe('an editor field', () => {
    test('typing writes the draft only; nothing is sent per keystroke', async () => {
        const { field, typeText } = makeField();
        await typeText('s');
        await typeText('st');
        await typeText('sto');
        expect(field.commit).not.toHaveBeenCalled();
        expect(readFieldDraft(field.storage, content)?.text).toBe('sto');
    });

    test('blur commits the edit as one action and clears the draft', async () => {
        const { field, binding, typeText } = makeField();
        await typeText('a');
        await typeText('ab');
        await binding.handle({ type: 'blur' });
        expect(field.commit).toHaveBeenCalledTimes(1);
        expect(field.commit).toHaveBeenCalledWith('ab');
        expect(readFieldDraft(field.storage, content)).toBeNull();
        expect(binding.state()).toBe('clean');
    });

    test('Enter commits a single-line field', async () => {
        const { field, binding, typeText } = makeField({ type: 'line' });
        await typeText('name');
        await binding.handle({ type: 'keydown', key: 'Enter' });
        expect(field.commit).toHaveBeenCalledWith('name');
    });

    test('Enter in a multi-line field is typing, not a commit', async () => {
        const { field, binding, typeText } = makeField({ type: 'text' });
        await typeText('line one');
        await binding.handle({ type: 'keydown', key: 'Enter' });
        expect(field.commit).not.toHaveBeenCalled();
    });

    test('closing the editor commits', async () => {
        const { field, binding, typeText } = makeField();
        await typeText('edited');
        await binding.handle({ type: 'close' });
        expect(field.commit).toHaveBeenCalledWith('edited');
    });

    test('a toggle commits at once', async () => {
        const { field, binding } = makeField({ type: 'toggle', stored: 'false' });
        field.value = 'true';
        await binding.handle({ type: 'input', user: true });
        expect(field.commit).toHaveBeenCalledWith('true');
    });

    test('code writing the field commits at once', async () => {
        const { field, binding } = makeField();
        field.value = 'written by an extension';
        await binding.handle({ type: 'input', user: false });
        expect(field.commit).toHaveBeenCalledWith('written by an extension');
    });

    test('a commit point with nothing changed sends nothing', async () => {
        const { field, binding, typeText } = makeField();
        await binding.handle({ type: 'blur' });
        await typeText('x');
        await typeText('stored');
        await binding.handle({ type: 'blur' });
        expect(field.commit).not.toHaveBeenCalled();
    });

    test('blur and change of one edit send it once', async () => {
        const { field, binding, typeText } = makeField();
        await typeText('once');
        await Promise.all([binding.handle({ type: 'change' }), binding.handle({ type: 'blur' })]);
        expect(field.commit).toHaveBeenCalledTimes(1);
    });

    test('an edit made while a commit is on its way is sent after it', async () => {
        const { field, binding, typeText } = makeField();
        await typeText('first');
        const first = binding.handle({ type: 'blur' });
        await typeText('second');
        const second = binding.handle({ type: 'blur' });
        await Promise.all([first, second]);
        expect(field.commit.mock.calls.map(call => call[0])).toEqual(['first', 'second']);
        expect(readFieldDraft(field.storage, content)).toBeNull();
    });

    test('a failed commit stays a draft and is sent again at the next commit point', async () => {
        const { field, binding, typeText } = makeField();
        field.fail = true;
        await typeText('kept');
        await expect(binding.handle({ type: 'blur' })).resolves.toBe(false);
        expect(readFieldDraft(field.storage, content)?.text).toBe('kept');
        expect(binding.state()).toBe('draft');
        field.fail = false;
        await expect(binding.handle({ type: 'blur' })).resolves.toBe(true);
        expect(field.commit).toHaveBeenCalledTimes(2);
        expect(field.stored).toBe('kept');
        expect(readFieldDraft(field.storage, content)).toBeNull();
    });
});

describe('after a reload', () => {
    test('a draft goes back into its field, stays marked, and commits at the next commit point', async () => {
        const first = makeField();
        await first.typeText('unsent');
        const { field, binding } = makeField({ storage: makeStorage(first.field.storage.state) });
        expect(binding.restore()).toBe('restored');
        expect(field.value).toBe('unsent');
        expect(binding.state()).toBe('draft');
        expect(field.commit).not.toHaveBeenCalled();
        await binding.handle({ type: 'close' });
        expect(field.commit).toHaveBeenCalledWith('unsent');
        expect(binding.state()).toBe('clean');
    });

    test('a draft of what is stored by now is forgotten', async () => {
        const first = makeField();
        await first.typeText('same');
        const { binding, field } = makeField({ stored: 'same', storage: makeStorage(first.field.storage.state) });
        expect(binding.restore()).toBe('none');
        expect(readFieldDraft(field.storage, content)).toBeNull();
    });

    describe('when what is stored changed after the draft started', () => {
        async function conflicted() {
            const first = makeField({ stored: 'old' });
            await first.typeText('mine');
            return makeField({ stored: 'theirs', storage: makeStorage(first.field.storage.state) });
        }

        test('the user is asked, with both texts; nothing is committed until they answer', async () => {
            const { field, binding } = await conflicted();
            expect(binding.restore()).toBe('conflict');
            expect(binding.state()).toBe('conflict');
            expect(binding.conflict()?.text).toBe('mine');
            expect(field.value).toBe('theirs');
            await binding.handle({ type: 'close' });
            expect(field.commit).not.toHaveBeenCalled();
            expect(readFieldDraft(field.storage, content)?.text).toBe('mine');
        });

        test('keeping the draft puts it in the field, as a draft started from what is stored now', async () => {
            const { field, binding } = await conflicted();
            binding.restore();
            binding.keep();
            expect(field.value).toBe('mine');
            expect(readFieldDraft(field.storage, content)).toEqual({ text: 'mine', base: 'theirs' });
            await binding.handle({ type: 'blur' });
            expect(field.commit).toHaveBeenCalledWith('mine');
        });

        test('keeping the stored one drops the draft', async () => {
            const { field, binding } = await conflicted();
            binding.restore();
            binding.discard();
            expect(field.value).toBe('theirs');
            expect(readFieldDraft(field.storage, content)).toBeNull();
            expect(binding.state()).toBe('clean');
        });
    });
});

describe('revertChanges (a failed commit leaves the page\'s copy as stored)', () => {
    test('sets back what the commit set, nested and removed keys too', () => {
        const before = { content: 'old', characterFilter: { isExclude: false, names: ['a'] }, gone: 1 };
        const entry = { content: 'new', characterFilter: { isExclude: true, names: ['a'] }, added: 2 };
        revertChanges(entry, before, structuredClone(entry));
        expect(entry).toEqual(before);
    });

    test('leaves what another edit has changed since', () => {
        const before = { content: 'old', comment: 'c' };
        const after = { content: 'new', comment: 'c' };
        const entry = { content: 'newer still', comment: 'c2' };
        revertChanges(entry, before, after);
        expect(entry).toEqual({ content: 'newer still', comment: 'c2' });
    });
});

describe('drafts of things that are gone', () => {
    /** A storage that can also be gone over, as localStorage can. */
    function makeListedStorage() {
        const storage = makeStorage();
        Object.defineProperty(storage, 'length', { get: () => Object.keys(storage.state).length });
        return Object.assign(storage, { key: (/** @type {number} */ index) => Object.keys(storage.state)[index] ?? null });
    }

    test('a deleted entry\'s drafts all go, and only its', () => {
        const storage = makeStorage();
        writeFieldDraft(storage, content, 'a', '');
        writeFieldDraft(storage, comment, 'b', '');
        writeFieldDraft(storage, { ...content, id: 'book:7:10' }, 'c', '');
        clearThingDrafts(storage, 'world-entry', 'book:7:1');
        expect(readFieldDraft(storage, content)).toBeNull();
        expect(readFieldDraft(storage, comment)).toBeNull();
        expect(hasFieldDrafts(storage, 'world-entry', 'book:7:1')).toBe(false);
        expect(readFieldDraft(storage, { ...content, id: 'book:7:10' })?.text).toBe('c');
    });

    test('a deleted book\'s entries\' drafts all go, and no other book\'s', () => {
        const storage = makeListedStorage();
        writeFieldDraft(storage, content, 'a', '');
        writeFieldDraft(storage, { ...content, id: 'book:7:2' }, 'b', '');
        writeFieldDraft(storage, { ...content, id: 'book:70:1' }, 'c', '');
        writeFieldDraft(storage, { ...content, kind: 'other', id: 'book:7:1' }, 'd', '');
        storage.setItem('FieldDraftIndex:not json', 'x');
        clearDraftsUnder(storage, 'world-entry', 'book:7:');
        expect(readFieldDraft(storage, content)).toBeNull();
        expect(readFieldDraft(storage, { ...content, id: 'book:7:2' })).toBeNull();
        expect(readFieldDraft(storage, { ...content, id: 'book:70:1' })?.text).toBe('c');
        expect(readFieldDraft(storage, { ...content, kind: 'other', id: 'book:7:1' })?.text).toBe('d');
    });
});
