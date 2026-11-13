import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { boxText } from '../public/scripts/chat-box-text.js';
import { endOwnerOf, sameOwner } from '../public/scripts/chat-box-ends.js';
import { boxCopies, guardedStorage } from '../public/scripts/chat-box-copies.js';

jest.unstable_mockModule('../public/scripts/chat-text/editors.js', () => ({ loadChatEditor: () => new Promise(() => {}) }));
jest.unstable_mockModule('../public/scripts/request-headers.js', () => ({ getRequestHeaders: () => ({}) }));

/** @type {typeof import('../public/scripts/chat-box.js')} */
let box;

beforeAll(async () => {
    globalThis.document = /** @type {any} */ ({ addEventListener: () => {}, visibilityState: 'visible' });
    globalThis.window = /** @type {any} */ ({ addEventListener: () => {} });
    box = await import('../public/scripts/chat-box.js');
});

describe('the chat box\'s text', () => {
    test('is what the editor\'s edits made it', () => {
        const text = boxText('hi');
        text.edited([{ from: 2, to: 2, insert: ' there' }], '1:1');
        text.edited([{ from: 0, to: 1, insert: 'H' }, { from: 3, to: 8, insert: 'you' }], '1:2');
        expect(text.text()).toBe('Hi you');
    });

    test('replaced from outside includes every edit made, so the editor keeps none of them', () => {
        const text = boxText('');
        let heard = 0;
        text.port.watch(() => heard++);
        text.edited([{ from: 0, to: 0, insert: 'typed' }], '1:1');
        text.replace('a draft');
        expect(text.port.get()).toEqual({ text: 'a draft', includes: '1:1' });
        expect(text.text()).toBe('a draft');
        expect(heard).toBe(1);
    });
});

describe('what a chat ends on', () => {
    test('is its last stored message', () => {
        expect(endOwnerOf([{ node_id: '7' }, { node_id: '9' }, { mes: 'streaming' }], 'Ada.png')).toEqual({ message: '9' });
    });

    test('before anything is stored, is the last opening shown, by its greeting', () => {
        const shown = [{ node_id: 'card:1', original_avatar: 'Bo.png', extra: { greeting_id: 2 } }, { node_id: 'card:2', original_avatar: 'Cy.png', extra: { greeting_id: 0 } }];
        expect(endOwnerOf(shown, null)).toEqual({ greeting: 0, avatar: 'Cy.png' });
        expect(endOwnerOf([{ node_id: 'card:1', extra: { greeting_id: 3 } }], 'Ada.png')).toEqual({ greeting: 3, avatar: 'Ada.png' });
    });

    test('with nothing shown, is the root', () => {
        expect(endOwnerOf([], 'Ada.png')).toEqual({ root: true });
    });

    test('names the same message only when both are it', () => {
        expect(sameOwner({ message: '1' }, { message: '1' })).toBe(true);
        expect(sameOwner({ message: '1' }, { root: true })).toBe(false);
        expect(sameOwner({ root: true }, { root: true })).toBe(true);
        expect(sameOwner({ greeting: 1, avatar: 'a' }, { greeting: 1, avatar: 'b' })).toBe(false);
        expect(sameOwner(null, { root: true })).toBe(false);
    });
});

/** A browser storage in memory */
function memoryStorage() {
    /** @type {Map<string, string>} */
    const items = new Map();
    return {
        getItem: (/** @type {string} */ key) => items.get(key) ?? null,
        setItem: (/** @type {string} */ key, /** @type {string} */ value) => void items.set(key, String(value)),
        removeItem: (/** @type {string} */ key) => void items.delete(key),
        get length() {
            return items.size;
        },
        key: (/** @type {number} */ i) => [...items.keys()][i] ?? null,
        items,
    };
}

/** A browser storage that refuses everything, as in a private window */
const refusing = {
    getItem() {
        throw new Error('refused');
    },
    setItem() {
        throw new Error('refused');
    },
    removeItem() {
        throw new Error('refused');
    },
};

describe('the browser\'s copies of the chat box\'s text', () => {
    const ada = { avatar_url: 'Ada.png' };

    test('keep text written over a draft until the server keeps it; a copy of just the draft is none', () => {
        const copies = boxCopies(memoryStorage());
        copies.write(ada, { message: '1' }, 'hello', '');
        copies.write(ada, { message: '1' }, 'hello there', 'ignored: the copy keeps the draft it was first written over');
        expect(copies.read(ada, { message: '1' })).toEqual({ text: 'hello there', base: '' });
        copies.write(ada, { root: true }, 'same as kept', 'same as kept');
        expect(copies.read(ada, { root: true })).toBeNull();
        expect(copies.of(ada)).toEqual([{ owner: { message: '1' }, text: 'hello there', base: '' }]);
        copies.kept(ada, { message: '1' }, 'hello there');
        expect(copies.of(ada)).toEqual([]);
    });

    test('a copy typed on since a save is kept over the text the server kept', () => {
        const copies = boxCopies(memoryStorage());
        copies.write(ada, { message: '1' }, 'hello there, more', '');
        copies.kept(ada, { message: '1' }, 'hello there');
        expect(copies.read(ada, { message: '1' })).toEqual({ text: 'hello there, more', base: 'hello there' });
    });

    test('drop only a copy of the text named, and every copy of a chat that is gone', () => {
        const copies = boxCopies(memoryStorage());
        copies.write(ada, { message: '1' }, 'newer', '');
        copies.drop(ada, { message: '1' }, 'older');
        expect(copies.read(ada, { message: '1' })?.text).toBe('newer');
        copies.drop(ada, { message: '1' }, 'newer');
        expect(copies.read(ada, { message: '1' })).toBeNull();
        copies.write(ada, { message: '2' }, 'a', '');
        copies.write(ada, { greeting: 0, avatar: 'Ada.png' }, 'b', '');
        copies.write({ group_id: 'g' }, { root: true }, 'c', '');
        copies.dropChat(ada);
        expect(copies.of(ada)).toEqual([]);
        expect(copies.of({ group_id: 'g' })).toEqual([{ owner: { root: true }, text: 'c', base: '' }]);
    });

    test('with storage that refuses, keep nothing and never throw', () => {
        const copies = boxCopies(guardedStorage(() => /** @type {any} */ (refusing)));
        expect(() => copies.write(ada, { message: '1' }, 'hello', '')).not.toThrow();
        expect(copies.read(ada, { message: '1' })).toBeNull();
        expect(copies.of(ada)).toEqual([]);
        expect(() => copies.kept(ada, { message: '1' }, 'hello')).not.toThrow();
        expect(() => copies.dropChat(ada)).not.toThrow();
        const missing = boxCopies(guardedStorage(() => { throw new Error('no storage'); }));
        expect(() => missing.write(ada, { message: '1' }, 'hello', '')).not.toThrow();
        expect(missing.read(ada, { message: '1' })).toBeNull();
    });
});

describe('the chat box\'s drafts', () => {
    /** @type {import('../public/scripts/chat-box-ends.js').DraftOwner} */
    let end = { message: '1' };
    /** @type {{ avatar_url: string } | { group_id: string } | null} */
    let open = { avatar_url: 'Ada.png' };
    let storage = memoryStorage();
    const copies = () => boxCopies(storage);
    const ada = { avatar_url: 'Ada.png' };

    beforeAll(() => {
        globalThis.localStorage = /** @type {any} */ (storage);
        box.initChatBox(/** @type {any} */ ({ chat: () => open, endOwner: () => end }));
    });

    test('text written before any chat is open stays when one opens, and is copied for it', () => {
        box.writeChatBox('early');
        box.arriveChatBox(ada, { owner: { message: '1' }, text: '' });
        expect(box.chatBoxText()).toBe('early');
        expect(box.leavingChatBox()).toEqual([{ avatar_url: 'Ada.png', owner: { message: '1' }, text: 'early', base: '' }]);
        expect(copies().read(ada, { message: '1' })).toEqual({ text: 'early', base: '' });
    });

    test('each edit is copied; the copy goes only when the server says it kept the text', () => {
        box.arriveChatBox(ada, { owner: { message: '2' }, text: 'kept for 2' });
        expect(box.chatBoxText()).toBe('kept for 2');
        expect(box.leavingChatBox()).toBeUndefined();
        box.writeChatBox('kept for 2, more');
        expect(copies().read(ada, { message: '2' })).toEqual({ text: 'kept for 2, more', base: 'kept for 2' });
        const leaving = box.leavingChatBox();
        expect(leaving).toEqual([{ avatar_url: 'Ada.png', owner: { message: '2' }, text: 'kept for 2, more', base: 'kept for 2' }]);
        box.chatBoxLeft(undefined);
        box.chatBoxLeft([{ ...leaving?.[0], left: null }]);
        expect(copies().read(ada, { message: '2' })?.text).toBe('kept for 2, more');
        box.chatBoxLeft([{ ...leaving?.[0], left: 'kept' }]);
        expect(copies().read(ada, { message: '2' })).toBeNull();
        expect(box.leavingChatBox()).toBeUndefined();
    });

    test('a copy not confirmed goes with the next open of its chat, and one the server won\'t keep is gone', () => {
        box.writeChatBox('left unconfirmed');
        box.arriveChatBox(ada, { owner: { message: '3' }, text: '' });
        expect(box.openingChatBox({ group_id: 'g' })).toBeUndefined();
        const carried = box.openingChatBox(ada);
        expect(carried).toEqual([
            { avatar_url: 'Ada.png', owner: { message: '1' }, text: 'early', base: '' },
            { avatar_url: 'Ada.png', owner: { message: '2' }, text: 'left unconfirmed', base: 'kept for 2, more' },
        ]);
        box.chatBoxLeft([{ ...carried?.[0], left: 'gone' }, { ...carried?.[1], left: 'superseded' }]);
        expect(copies().of(ada)).toEqual([]);
    });

    test('arriving at a draft shows the copy written over it; a copy over a draft that changed since is gone', () => {
        copies().write(ada, { message: '5' }, 'unconfirmed for 5', 'kept for 5');
        box.arriveChatBox(ada, { owner: { message: '5' }, text: 'kept for 5' });
        expect(box.chatBoxText()).toBe('unconfirmed for 5');
        copies().write(ada, { message: '6' }, 'unconfirmed for 6', 'what 6 had');
        box.arriveChatBox(ada, { owner: { message: '6' }, text: 'written elsewhere since' });
        expect(box.chatBoxText()).toBe('written elsewhere since');
        expect(copies().read(ada, { message: '6' })).toBeNull();
        expect(copies().read(ada, { message: '5' })?.text).toBe('unconfirmed for 5');
    });

    test('a send takes the text and names the draft it was; its copy stays until the chat ends past it', () => {
        box.arriveChatBox(ada, { owner: { message: '2' }, text: '' });
        box.writeChatBox('hello');
        end = { message: '2' };
        expect(box.takeChatBoxText()).toEqual({ text: 'hello', sent: { message: '2' } });
        expect(box.chatBoxText()).toBe('');
        expect(copies().read(ada, { message: '2' })?.text).toBe('hello');
        end = { message: '3' };
        box.chatBoxFollowEnd();
        expect(copies().read(ada, { message: '2' })).toBeNull();
    });

    test('the end moving by what was written keeps the text and its copy, now after the new end', () => {
        box.writeChatBox('about the reply');
        end = { message: '4' };
        box.chatBoxFollowEnd();
        expect(box.leavingChatBox()).toEqual([{ avatar_url: 'Ada.png', owner: { message: '4' }, text: 'about the reply', base: '' }]);
        expect(copies().read(ada, { message: '3' })).toBeNull();
        expect(copies().read(ada, { message: '4' })).toEqual({ text: 'about the reply', base: '' });
    });

    test('a cut back to a message with a draft keeps the text, written over that draft', () => {
        box.chatBoxFollowCut({ owner: { message: '1' }, text: 'what 1 had' });
        expect(box.leavingChatBox()).toEqual([{ avatar_url: 'Ada.png', owner: { message: '1' }, text: 'about the reply', base: 'what 1 had' }]);
        expect(copies().read(ada, { message: '1' })).toEqual({ text: 'about the reply', base: 'what 1 had' });
        expect(copies().read(ada, { message: '4' })).toBeNull();
    });

    test('the end of another chat than the text\'s is never followed', () => {
        box.arriveChatBox(ada, { owner: { message: '4' }, text: 'about the reply' });
        box.writeChatBox('still about 4');
        open = { group_id: 'g' };
        end = { root: true };
        box.chatBoxFollowEnd();
        expect(box.leavingChatBox()).toEqual([{ avatar_url: 'Ada.png', owner: { message: '4' }, text: 'still about 4', base: 'about the reply' }]);
    });

    test('arriving where the box already is keeps what it has', () => {
        box.arriveChatBox({ group_id: 'g' }, { owner: { root: true }, text: 'at the root' });
        box.writeChatBox('at the root, edited');
        box.arriveChatBox({ group_id: 'g' }, { owner: { root: true }, text: 'at the root' });
        expect(box.chatBoxText()).toBe('at the root, edited');
    });

    test('a chat that is gone takes its copies with it', () => {
        copies().write(ada, { message: '9' }, 'x', '');
        box.forgetChatBoxChat(ada);
        expect(copies().of(ada)).toEqual([]);
    });

    test('with storage that refuses, the box keeps its text and carries it as before', () => {
        globalThis.localStorage = /** @type {any} */ (refusing);
        box.arriveChatBox({ group_id: 'g' }, { owner: { message: '8' }, text: '' });
        box.writeChatBox('no storage');
        expect(box.chatBoxText()).toBe('no storage');
        expect(box.openingChatBox({ group_id: 'h' })).toEqual([{ group_id: 'g', owner: { message: '8' }, text: 'no storage', base: '' }]);
        globalThis.localStorage = /** @type {any} */ (storage);
    });
});
