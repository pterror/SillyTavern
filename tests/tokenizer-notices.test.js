import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

/** In-memory sessionStorage stand-in. */
function makeStorage() {
    const map = new Map();
    return {
        getItem: jest.fn((k) => (map.has(k) ? map.get(k) : null)),
        setItem: jest.fn((k, v) => { map.set(k, String(v)); }),
        removeItem: jest.fn((k) => { map.delete(k); }),
        clear: jest.fn(() => map.clear()),
    };
}

let showTokenizerWarnings;

beforeAll(async () => {
    ({ showTokenizerWarnings } = await import('../public/scripts/tokenizer-notices.js'));
});

beforeEach(() => {
    globalThis.toastr = { warning: jest.fn() };
    globalThis.sessionStorage = makeStorage();
});

const estimate = (key) => ({ kind: 'estimate', key, message: `Counts are estimates for ${key}` });

describe('showTokenizerWarnings', () => {
    test('a repeated estimate key toasts once', () => {
        showTokenizerWarnings([estimate('textgen|llamacpp|u|m1|t')]);
        showTokenizerWarnings([estimate('textgen|llamacpp|u|m1|t')]);
        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(1);
        expect(globalThis.toastr.warning).toHaveBeenCalledWith('Counts are estimates for textgen|llamacpp|u|m1|t');
    });

    test('a dropped warning toasts on every call', () => {
        const dropped = { kind: 'dropped', key: 'k', message: 'Dropped: a, b', entries: ['a', 'b'] };
        showTokenizerWarnings([dropped]);
        showTokenizerWarnings([dropped]);
        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(2);
    });

    test('a new model key toasts again', () => {
        showTokenizerWarnings([estimate('textgen|llamacpp|u|m1|t')]);
        showTokenizerWarnings([estimate('textgen|llamacpp|u|m2|t')]);
        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(2);
    });

    test('storage throwing still toasts', () => {
        globalThis.sessionStorage = {
            getItem: jest.fn(() => { throw new Error('denied'); }),
            setItem: jest.fn(() => { throw new Error('denied'); }),
        };
        expect(() => showTokenizerWarnings([estimate('k')])).not.toThrow();
        expect(globalThis.toastr.warning).toHaveBeenCalledTimes(1);
    });
});
