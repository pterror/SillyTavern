import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { ChangeSet, Text } from '@codemirror/state';
import { boxText } from '../public/scripts/chat-box-text.js';
import { endOwnerOf, sameOwner } from '../public/scripts/chat-box-ends.js';
import { boxCopies, guardedStorage } from '../public/scripts/chat-box-copies.js';

let tab = 'tab-a';
jest.unstable_mockModule('../public/scripts/chat-text/editors.js', () => ({ loadChatEditor: () => new Promise(() => {}) }));
jest.unstable_mockModule('../public/scripts/request-headers.js', () => ({ getRequestHeaders: () => ({}) }));
jest.unstable_mockModule('../public/scripts/tab-session.js', () => ({ tabToken: () => tab }));

/** @type {typeof import('../public/scripts/chat-box.js')} */
let box;

beforeAll(async () => {
    globalThis.document = /** @type {any} */ ({ addEventListener: () => {}, visibilityState: 'visible' });
    globalThis.window = /** @type {any} */ ({ addEventListener: () => {} });
    box = await import('../public/scripts/chat-box.js');
});

/**
 * An editor over a box's text as interact's textEditor is: it hands on each edit with an id, and shows a text heard
 * with the edits it doesn't include laid over it
 * @param {ReturnType<typeof boxText>} text
 */
function editorOver(text) {
    let doc = text.port.get().text;
    let confirmed = doc;
    /** @type {{ id: string, changes: ChangeSet }[]} */
    let pending = [];
    let n = 0;
    text.bind(() => doc);
    text.port.watch(() => queueMicrotask(() => {
        const heard = text.port.get();
        const included = heard.includes === undefined ? 0 : pending.findIndex(p => p.id === heard.includes) + 1;
        let base = Text.of(confirmed.split('\n'));
        for (const p of pending.slice(0, included)) base = p.changes.apply(base);
        const from = base.toString();
        let start = 0;
        while (start < from.length && start < heard.text.length && from[start] === heard.text[start]) start++;
        let end = 0;
        while (end < from.length - start && end < heard.text.length - start && from[from.length - 1 - end] === heard.text[heard.text.length - 1 - end]) end++;
        let other = ChangeSet.of(start === from.length && start === heard.text.length ? [] : [{ from: start, to: from.length - end, insert: heard.text.slice(start, heard.text.length - end) }], from.length);
        const rest = [];
        for (const p of pending.slice(included)) {
            rest.push({ id: p.id, changes: p.changes.map(other) });
            other = other.map(p.changes, true);
        }
        pending = rest;
        confirmed = heard.text;
        doc = other.apply(Text.of(doc.split('\n'))).toString();
    }));
    return {
        /** @param {string} typed what is typed at the end */
        type(typed) {
            const changes = ChangeSet.of([{ from: doc.length, insert: typed }], doc.length);
            n += 1;
            const id = `e:${n}`;
            pending.push({ id, changes });
            doc = changes.apply(Text.of(doc.split('\n'))).toString();
            text.edited([{ from: doc.length - typed.length, to: doc.length - typed.length, insert: typed }], id);
        },
        doc: () => doc,
    };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('the chat box\'s text', () => {
    test('is what the editor\'s edits made it', () => {
        const text = boxText('hi');
        text.edited([{ from: 2, to: 2, insert: ' there' }], '1:1');
        text.edited([{ from: 0, to: 1, insert: 'H' }, { from: 3, to: 8, insert: 'you' }], '1:2');
        expect(text.text()).toBe('Hi you');
        expect(text.latest()).toBe('1:2');
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

    test('a draft heard is shown with what was typed since laid over it', async () => {
        const text = boxText('Dear Hal,');
        const editor = editorOver(text);
        editor.type(' the plan.');
        const saved = text.latest();
        editor.type(' More.');
        text.heard('Dear Hal, the plan. P.S. tea.', saved);
        expect(text.port.get()).toEqual({ text: 'Dear Hal, the plan. P.S. tea.', includes: saved });
        await settle();
        expect(text.text()).toBe('Dear Hal, the plan. P.S. tea. More.');
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

    test('are each tab\'s own: two tabs never write over each other\'s', () => {
        const copies = boxCopies(memoryStorage());
        copies.write(ada, { message: '1' }, 'one', { text: 'from one', version: '5.0' });
        copies.write(ada, { message: '1' }, 'two', { text: 'from two', version: '5.0' });
        expect(copies.read(ada, { message: '1' }, 'one')).toEqual({ text: 'from one', version: '5.0' });
        expect(copies.read(ada, { message: '1' }, 'two')).toEqual({ text: 'from two', version: '5.0' });
        expect(copies.of(ada)).toEqual([
            { owner: { message: '1' }, tab: 'one', text: 'from one', version: '5.0' },
            { owner: { message: '1' }, tab: 'two', text: 'from two', version: '5.0' },
        ]);
    });

    test('a copy goes only when the server confirms the text it holds', () => {
        const copies = boxCopies(memoryStorage());
        copies.write(ada, { message: '1' }, 'one', { text: 'typed on since', version: '5.0' });
        copies.confirm(ada, { message: '1' }, 'one', 'what was sent');
        expect(copies.read(ada, { message: '1' }, 'one')?.text).toBe('typed on since');
        copies.confirm(ada, { message: '1' }, 'one', 'typed on since');
        expect(copies.of(ada)).toEqual([]);
    });

    test('every copy of a chat that is gone goes with it', () => {
        const copies = boxCopies(memoryStorage());
        copies.write(ada, { message: '2' }, 'one', { text: 'a', version: '0.0' });
        copies.write(ada, { greeting: 0, avatar: 'Ada.png' }, 'two', { text: 'b', version: '0.0' });
        copies.write({ group_id: 'g' }, { root: true }, 'one', { text: 'c', version: '0.0' });
        copies.dropChat(ada);
        expect(copies.of(ada)).toEqual([]);
        expect(copies.of({ group_id: 'g' })).toEqual([{ owner: { root: true }, tab: 'one', text: 'c', version: '0.0' }]);
    });

    test('know which tabs say they are open', () => {
        const copies = boxCopies(memoryStorage());
        copies.setOpen('one', true);
        copies.setOpen('two', true);
        copies.setOpen('one', false);
        expect(copies.openTabs()).toEqual(['two']);
    });

    test('with storage that refuses, keep nothing and never throw', () => {
        const copies = boxCopies(guardedStorage(() => /** @type {any} */ (refusing)));
        expect(() => copies.write(ada, { message: '1' }, 'one', { text: 'hello', version: '0.0' })).not.toThrow();
        expect(copies.read(ada, { message: '1' }, 'one')).toBeNull();
        expect(copies.of(ada)).toEqual([]);
        expect(() => copies.confirm(ada, { message: '1' }, 'one', 'hello')).not.toThrow();
        expect(() => copies.dropChat(ada)).not.toThrow();
        expect(() => copies.setOpen('one', true)).not.toThrow();
        const missing = boxCopies(guardedStorage(() => { throw new Error('no storage'); }));
        expect(() => missing.write(ada, { message: '1' }, 'one', { text: 'hello', version: '0.0' })).not.toThrow();
        expect(missing.read(ada, { message: '1' }, 'one')).toBeNull();
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
    const kept = (/** @type {any} */ leaving, /** @type {string} */ text, /** @type {string} */ version) => [{ ...leaving, sent: leaving.text, left: 'kept', text, version }];

    beforeAll(() => {
        globalThis.localStorage = /** @type {any} */ (storage);
        box.initChatBox(/** @type {any} */ ({ chat: () => open, endOwner: () => end }));
    });

    test('text written before any chat is open stays when one opens, and is copied for it', () => {
        box.writeChatBox('early');
        box.arriveChatBox(ada, { owner: { message: '1' }, text: '', version: '0.0' });
        expect(box.chatBoxText()).toBe('early');
        expect(box.leavingChatBox()).toEqual([{ avatar_url: 'Ada.png', owner: { message: '1' }, text: 'early', version: '0.0', tab: 'tab-a' }]);
        expect(copies().read(ada, { message: '1' }, 'tab-a')).toEqual({ text: 'early', version: '0.0' });
        expect(copies().openTabs()).toContain('tab-a');
    });

    test('each edit is copied; the copy goes only when the server says it kept the text', () => {
        box.arriveChatBox(ada, { owner: { message: '2' }, text: 'kept for 2', version: '7.0' });
        expect(box.chatBoxText()).toBe('kept for 2');
        expect(box.leavingChatBox()).toBeUndefined();
        box.writeChatBox('kept for 2, more');
        expect(copies().read(ada, { message: '2' }, 'tab-a')).toEqual({ text: 'kept for 2, more', version: '7.0' });
        const [leaving] = box.leavingChatBox() ?? [];
        expect(leaving).toEqual({ avatar_url: 'Ada.png', owner: { message: '2' }, text: 'kept for 2, more', version: '7.0', tab: 'tab-a' });
        box.chatBoxLeft(undefined);
        box.chatBoxLeft([{ ...leaving, sent: leaving.text, left: null }]);
        expect(copies().read(ada, { message: '2' }, 'tab-a')?.text).toBe('kept for 2, more');
        box.chatBoxLeft(kept(leaving, 'kept for 2, more', '7.1'));
        expect(copies().read(ada, { message: '2' }, 'tab-a')).toBeNull();
        expect(box.leavingChatBox()).toBeUndefined();
    });

    test('a copy not confirmed goes with the next open of its chat, as do closed tabs\' copies; open tabs\' copies don\'t', () => {
        box.writeChatBox('left unconfirmed');
        box.arriveChatBox(ada, { owner: { message: '3' }, text: '', version: '0.0' });
        copies().write(ada, { message: '3' }, 'closed-tab', { text: 'from a closed tab', version: '0.0' });
        copies().write(ada, { message: '3' }, 'open-tab', { text: 'from an open tab', version: '0.0' });
        copies().setOpen('open-tab', true);
        expect(box.openingChatBox({ group_id: 'g' })).toBeUndefined();
        const carried = box.openingChatBox(ada);
        expect(carried).toEqual([
            { avatar_url: 'Ada.png', owner: { message: '1' }, text: 'early', version: '0.0', tab: 'tab-a' },
            { avatar_url: 'Ada.png', owner: { message: '2' }, text: 'left unconfirmed', version: '7.1', tab: 'tab-a' },
            { avatar_url: 'Ada.png', owner: { message: '3' }, text: 'from a closed tab', version: '0.0', tab: 'closed-tab' },
        ]);
        box.chatBoxLeft([
            { ...carried?.[0], sent: 'early', left: 'gone' },
            { ...carried?.[1], sent: 'left unconfirmed', left: 'kept', text: 'kept for 2, more left unconfirmed', version: '7.2' },
            { ...carried?.[2], sent: 'from a closed tab', left: 'kept', text: 'from a closed tab', version: '9.0' },
        ]);
        expect(copies().of(ada)).toEqual([{ owner: { message: '3' }, tab: 'open-tab', text: 'from an open tab', version: '0.0' }]);
        copies().setOpen('open-tab', false);
        copies().remove(ada, { message: '3' }, 'open-tab');
    });

    test('arriving at a draft shows this tab\'s copy written over that version; one over another version is left for the next open', () => {
        copies().write(ada, { message: '5' }, 'tab-a', { text: 'unconfirmed for 5', version: '4.0' });
        box.arriveChatBox(ada, { owner: { message: '5' }, text: 'kept for 5', version: '4.0' });
        expect(box.chatBoxText()).toBe('unconfirmed for 5');
        copies().write(ada, { message: '6' }, 'tab-a', { text: 'unconfirmed for 6', version: '4.0' });
        box.arriveChatBox(ada, { owner: { message: '6' }, text: 'written elsewhere since', version: '8.0' });
        expect(box.chatBoxText()).toBe('written elsewhere since');
        expect(copies().read(ada, { message: '6' }, 'tab-a')).toBeNull();
        expect(box.openingChatBox(ada)).toContainEqual({ avatar_url: 'Ada.png', owner: { message: '6' }, text: 'unconfirmed for 6', version: '4.0', tab: 'tab-a@4.0' });
        copies().remove(ada, { message: '6' }, 'tab-a@4.0');
        copies().remove(ada, { message: '5' }, 'tab-a');
    });

    test('a push is shown when the box is at its draft and it is later; one while a save is unanswered waits for the answer', () => {
        box.arriveChatBox(ada, { owner: { message: '11' }, text: 'base', version: '8.0' });
        box.takeChatBoxPush({ tree: { avatar: 'Ada.png' }, owner: { message: '11' }, text: 'older', version: '7.9' });
        expect(box.chatBoxText()).toBe('base');
        box.takeChatBoxPush({ tree: { avatar: 'Bo.png' }, owner: { message: '11' }, text: 'another chat', version: '9.0' });
        expect(box.chatBoxText()).toBe('base');
        box.takeChatBoxPush({ tree: { avatar: 'Ada.png' }, owner: { message: '11' }, text: 'base, from another tab', version: '8.1' });
        expect(box.chatBoxText()).toBe('base, from another tab');
        box.writeChatBox('mine');
        const [leaving] = box.leavingChatBox() ?? [];
        box.takeChatBoxPush({ tree: { avatar: 'Ada.png' }, owner: { message: '11' }, text: 'merged later', version: '8.3' });
        expect(box.chatBoxText()).toBe('mine', 'held while the save is unanswered');
        box.chatBoxLeft(kept(leaving, 'mine, merged', '8.2'));
        expect(box.chatBoxText()).toBe('merged later', 'the later push, after the answer');
    });

    test('a send takes the text and names the draft and version it was; its copy stays until the chat ends past it', () => {
        box.arriveChatBox(ada, { owner: { message: '2' }, text: '', version: '7.2' });
        box.writeChatBox('hello');
        end = { message: '2' };
        expect(box.takeChatBoxText()).toEqual({ text: 'hello', sent: { message: '2', version: '7.2' } });
        expect(box.chatBoxText()).toBe('');
        expect(copies().read(ada, { message: '2' }, 'tab-a')?.text).toBe('hello');
        end = { message: '3' };
        box.chatBoxFollowEnd();
        expect(copies().read(ada, { message: '2' }, 'tab-a')).toBeNull();
    });

    test('the end moving by what was written keeps the text and its copy, now after the new end', () => {
        box.writeChatBox('about the reply');
        end = { message: '4' };
        box.chatBoxFollowEnd();
        expect(box.leavingChatBox()).toEqual([{ avatar_url: 'Ada.png', owner: { message: '4' }, text: 'about the reply', version: '0.0', tab: 'tab-a' }]);
        expect(copies().read(ada, { message: '3' }, 'tab-a')).toBeNull();
        expect(copies().read(ada, { message: '4' }, 'tab-a')).toEqual({ text: 'about the reply', version: '0.0' });
    });

    test('a cut back to a message with a draft keeps the text, written over that draft', () => {
        box.chatBoxFollowCut({ owner: { message: '1' }, text: 'what 1 had', version: '3.0' });
        expect(box.leavingChatBox()).toEqual([{ avatar_url: 'Ada.png', owner: { message: '1' }, text: 'about the reply', version: '3.0', tab: 'tab-a' }]);
        expect(copies().read(ada, { message: '1' }, 'tab-a')).toEqual({ text: 'about the reply', version: '3.0' });
        expect(copies().read(ada, { message: '4' }, 'tab-a')).toBeNull();
    });

    test('the end of another chat than the text\'s is never followed', () => {
        box.arriveChatBox(ada, { owner: { message: '4' }, text: 'about the reply', version: '5.0' });
        box.writeChatBox('still about 4');
        open = { group_id: 'g' };
        end = { root: true };
        box.chatBoxFollowEnd();
        expect(box.leavingChatBox()).toEqual([{ avatar_url: 'Ada.png', owner: { message: '4' }, text: 'still about 4', version: '5.0', tab: 'tab-a' }]);
    });

    test('arriving where the box already is keeps what it has', () => {
        box.arriveChatBox({ group_id: 'g' }, { owner: { root: true }, text: 'at the root', version: '2.0' });
        box.writeChatBox('at the root, edited');
        box.arriveChatBox({ group_id: 'g' }, { owner: { root: true }, text: 'at the root', version: '2.0' });
        expect(box.chatBoxText()).toBe('at the root, edited');
    });

    test('a chat that is gone takes its copies with it', () => {
        copies().write(ada, { message: '9' }, 'tab-a', { text: 'x', version: '0.0' });
        box.forgetChatBoxChat(ada);
        expect(copies().of(ada)).toEqual([]);
    });

    test('another tab\'s copy of the same draft is its own: both are kept', () => {
        box.arriveChatBox(ada, { owner: { message: '10' }, text: '', version: '0.0' });
        box.writeChatBox('typed in tab a');
        tab = 'tab-b';
        box.writeChatBox('typed in tab b');
        tab = 'tab-a';
        expect(copies().read(ada, { message: '10' }, 'tab-b')?.text).toBe('typed in tab b');
        expect(copies().read(ada, { message: '10' }, 'tab-a')?.text).toBe('typed in tab a');
        box.forgetChatBoxChat(ada);
    });

    test('with storage that refuses, the box keeps its text and carries it as before', () => {
        globalThis.localStorage = /** @type {any} */ (refusing);
        box.arriveChatBox({ group_id: 'g' }, { owner: { message: '8' }, text: '', version: '0.0' });
        box.writeChatBox('no storage');
        expect(box.chatBoxText()).toBe('no storage');
        expect(box.openingChatBox({ group_id: 'h' })).toEqual([{ group_id: 'g', owner: { message: '8' }, text: 'no storage', version: '0.0', tab: 'tab-a' }]);
        globalThis.localStorage = /** @type {any} */ (storage);
    });
});

describe('draft versions', () => {
    test('are ordered by where their value was written, then by edits', () => {
        expect(box.laterVersion('5.1', '5.0')).toBe(true);
        expect(box.laterVersion('6.0', '5.9')).toBe(true);
        expect(box.laterVersion('5.0', '5.0')).toBe(false);
        expect(box.laterVersion('0.0', '5.0')).toBe(false);
        expect(box.laterVersion('x', '5.0')).toBe(false);
    });
});
