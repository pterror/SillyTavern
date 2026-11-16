import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { ChangeSet, Text } from '@codemirror/state';
import { boxText } from '../public/scripts/chat-box-text.js';
import { endOwnerOf, sameOwner } from '../public/scripts/chat-box-ends.js';
import { boxCopies, guardedStorage } from '../public/scripts/chat-box-copies.js';

let tab = 'tab-a';
jest.unstable_mockModule('../public/scripts/chat-text/editors.js', () => ({ loadChatEditor: () => Promise.resolve() }));
jest.unstable_mockModule('../public/scripts/chat-text/chat-box-editor.js', () => ({ chatBoxEditor: (/** @type {any} */ options) => (shown = { ...boxEditor(options.text), macroValue: options.macroValue }) }));
jest.unstable_mockModule('../public/scripts/request-headers.js', () => ({ getRequestHeaders: () => ({}) }));
jest.unstable_mockModule('../public/scripts/tab-session.js', () => ({ tabToken: () => tab }));

/** @type {typeof import('../public/scripts/chat-box.js')} */
let box;
/** @type {ReturnType<typeof boxEditor>} */
let shown;

/** @param {string} text */
const doc = text => Text.of(text.split('\n'));

/**
 * One replacement of what differs between two texts
 * @param {string} from
 * @param {string} to
 */
function between(from, to) {
    let start = 0;
    while (start < from.length && start < to.length && from[start] === to[start]) start++;
    let end = 0;
    while (end < from.length - start && end < to.length - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end++;
    return ChangeSet.of(start === from.length && start === to.length ? [] : [{ from: start, to: from.length - end, insert: to.slice(start, to.length - end) }], from.length);
}

/**
 * The chat box's editor as chat-box-editor.js makes it over interact's textEditor: edits handed on with ids, a text
 * heard shown with the edits it doesn't include laid over it, the edits not included given with the text they're over,
 * and another text taken as the one elsewhere
 * @param {ReturnType<typeof boxText>} text
 */
function boxEditor(text) {
    let current = text.port.get().text;
    let confirmed = current;
    /** @type {{ id: string, changes: ChangeSet }[]} */
    let pending = [];
    let n = 0;
    text.bind(() => current);
    text.port.watch(() => queueMicrotask(() => {
        const heard = text.port.get();
        const included = heard.includes === undefined ? 0 : pending.findIndex(p => p.id === heard.includes) + 1;
        let base = doc(confirmed);
        for (const p of pending.slice(0, included)) base = p.changes.apply(base);
        let other = between(base.toString(), heard.text);
        const rest = [];
        for (const p of pending.slice(included)) {
            rest.push({ id: p.id, changes: p.changes.map(other) });
            other = other.map(p.changes, true);
        }
        pending = rest;
        confirmed = heard.text;
        current = other.apply(doc(current)).toString();
    }));
    const view = {
        state: { doc: { toString: () => current, get length() { return current.length; } } },
        /** @param {{ changes: { from: number, to: number, insert: string } }} transaction */
        dispatch({ changes }) {
            const made = ChangeSet.of([changes], current.length);
            n += 1;
            const id = `e:${n}`;
            pending.push({ id, changes: made });
            current = made.apply(doc(current)).toString();
            text.edited([changes], id);
        },
        focus() {},
    };
    return {
        view,
        placeholder() {},
        stop() {},
        redrawn: 0,
        redraw() {
            this.redrawn += 1;
        },
        /** @param {string} typed what is typed at the end */
        type: typed => view.dispatch({ changes: { from: current.length, to: current.length, insert: typed } }),
        unsaved() {
            let all = ChangeSet.empty(confirmed.length);
            for (const p of pending) all = all.compose(p.changes);
            /** @type {{ from: number, to: number, insert: string, deleted: string }[]} */
            const changes = [];
            all.iterChanges((from, to, _fromB, _toB, inserted) => changes.push({ from, to, insert: inserted.toString(), deleted: confirmed.slice(from, to) }));
            return { text: confirmed, changes };
        },
        /** @param {string} base */
        rebase(base) {
            confirmed = base;
            if (current === base) {
                pending = [];
                text.rebased(base, undefined);
                return;
            }
            n += 1;
            const id = `e:${n}`;
            pending = [{ id, changes: between(base, current) }];
            text.rebased(base, id);
        },
    };
}

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

/**
 * @param {ReturnType<typeof boxCopies>} copies
 * @param {{ avatar_url: string } | { group_id: string }} chat
 */
const copiesOf = (copies, chat) => copies.all().filter(copy => JSON.stringify(copy.chat) === JSON.stringify(chat)).map(({ chat: _, ...copy }) => copy);

describe('the browser\'s copies of the chat box\'s text', () => {
    const ada = { avatar_url: 'Ada.png' };
    const one = { text: 'from one', changes: [{ from: 0, to: 0, insert: 'from one', deleted: '' }] };
    const two = { text: 'from two', changes: [{ from: 0, to: 0, insert: 'from two', deleted: '' }], change: 'p/e:1' };

    test('are each tab\'s own: two tabs never write over each other\'s', () => {
        const copies = boxCopies(memoryStorage());
        copies.write(ada, { message: '1' }, 'one', one);
        copies.write(ada, { message: '1' }, 'two', two);
        expect(copies.read(ada, { message: '1' }, 'one')).toEqual(one);
        expect(copies.read(ada, { message: '1' }, 'two')).toEqual(two);
        expect(copiesOf(copies, ada)).toEqual([{ owner: { message: '1' }, tab: 'one', ...one }, { owner: { message: '1' }, tab: 'two', ...two }]);
    });

    test('a copy goes only when the server confirms the text it holds', () => {
        const copies = boxCopies(memoryStorage());
        copies.write(ada, { message: '1' }, 'one', one);
        copies.confirm(ada, { message: '1' }, 'one', 'what was sent');
        expect(copies.read(ada, { message: '1' }, 'one')?.text).toBe('from one');
        copies.confirm(ada, { message: '1' }, 'one', 'from one');
        expect(copiesOf(copies, ada)).toEqual([]);
    });

    test('a copy set apart is kept as it is beside the next one', () => {
        const copies = boxCopies(memoryStorage());
        copies.write(ada, { message: '1' }, 'one', one);
        copies.setApart(ada, { message: '1' }, 'one');
        copies.write(ada, { message: '1' }, 'one', two);
        copies.setApart(ada, { message: '1' }, 'one');
        expect(copiesOf(copies, ada)).toEqual([{ owner: { message: '1' }, tab: 'one~1', ...one }, { owner: { message: '1' }, tab: 'one~2', ...two }]);
    });

    test('every copy of a chat that is gone goes with it', () => {
        const copies = boxCopies(memoryStorage());
        copies.write(ada, { message: '2' }, 'one', one);
        copies.write(ada, { greeting: 0, avatar: 'Ada.png' }, 'two', two);
        copies.write({ group_id: 'g' }, { root: true }, 'one', one);
        copies.dropChat(ada);
        expect(copiesOf(copies, ada)).toEqual([]);
        expect(copiesOf(copies, { group_id: 'g' })).toEqual([{ owner: { root: true }, tab: 'one', ...one }]);
    });

    test('with storage that refuses, keep nothing and never throw', () => {
        const copies = boxCopies(guardedStorage(() => /** @type {any} */ (refusing)));
        expect(() => copies.write(ada, { message: '1' }, 'one', one)).not.toThrow();
        expect(copies.read(ada, { message: '1' }, 'one')).toBeNull();
        expect(copiesOf(copies, ada)).toEqual([]);
        expect(() => copies.confirm(ada, { message: '1' }, 'one', 'hello')).not.toThrow();
        expect(() => copies.setApart(ada, { message: '1' }, 'one')).not.toThrow();
        expect(() => copies.dropChat(ada)).not.toThrow();
        const missing = boxCopies(guardedStorage(() => { throw new Error('no storage'); }));
        expect(() => missing.write(ada, { message: '1' }, 'one', one)).not.toThrow();
        expect(missing.read(ada, { message: '1' }, 'one')).toBeNull();
    });
});

describe('the chat box\'s drafts', () => {
    /** @type {import('../public/scripts/chat-box-ends.js').DraftOwner} */
    let end = { message: '1' };
    /** @type {{ avatar_url: string } | { group_id: string } | null} */
    /** @type {Record<string, string>} */
    let open = { avatar_url: 'Ada.png' };
    const storage = memoryStorage();
    const copies = () => boxCopies(storage);
    const ada = { avatar_url: 'Ada.png' };
    const insert = (/** @type {number} */ at, /** @type {string} */ text) => ({ from: at, to: at, insert: text, deleted: '' });
    const kept = (/** @type {any} */ leaving, /** @type {string} */ text) => [{ ...leaving, sent: leaving.text, left: 'kept', text }];
    /** @param {import('../public/scripts/chat-box-ends.js').DraftOwner} owner */
    const pushed = (owner, /** @type {string} */ text, /** @type {object} */ from = {}) => ({ tree: { avatar: 'Ada.png' }, owner, text, ...from });
    const leaving = () => {
        const [left] = box.leavingChatBox() ?? [];
        return left;
    };

    beforeAll(async () => {
        globalThis.localStorage = /** @type {any} */ (storage);
        await box.initChatBox(/** @type {any} */ ({ chat: () => open, endOwner: () => end, setup: () => ({}), macroScope: () => open }));
    });

    test('text written before any chat is open stays when one opens, and is copied for it', async () => {
        box.writeChatBox('early');
        box.arriveChatBox(ada, { owner: { message: '1' }, text: '' });
        await settle();
        expect(box.chatBoxText()).toBe('early');
        expect(leaving()).toMatchObject({ avatar_url: 'Ada.png', owner: { message: '1' }, text: 'early', changes: [insert(0, 'early')], tab: 'tab-a' });
        expect(copies().read(ada, { message: '1' }, 'tab-a')).toMatchObject({ text: 'early', changes: [insert(0, 'early')] });
    });

    test('each edit is copied with its changes; the copy goes only when the server says it kept the text', async () => {
        box.arriveChatBox(ada, { owner: { message: '2' }, text: 'kept for 2' });
        await settle();
        expect(box.chatBoxText()).toBe('kept for 2');
        expect(box.leavingChatBox()).toBeUndefined();
        shown.type(', more');
        await settle();
        expect(copies().read(ada, { message: '2' }, 'tab-a')).toMatchObject({ text: 'kept for 2, more', changes: [insert(10, ', more')] });
        const left = leaving();
        expect(left).toMatchObject({ avatar_url: 'Ada.png', owner: { message: '2' }, text: 'kept for 2, more', changes: [insert(10, ', more')], tab: 'tab-a' });
        expect(left.change).toMatch(/\/e:\d+$/);
        box.chatBoxLeft(undefined);
        box.chatBoxLeft([{ ...left, sent: left.text, left: null }]);
        expect(copies().read(ada, { message: '2' }, 'tab-a')?.text).toBe('kept for 2, more');
        box.chatBoxLeft(kept(left, 'kept for 2, more'));
        expect(copies().read(ada, { message: '2' }, 'tab-a')).toBeNull();
    });

    test('a push arriving mid-typing is shown with what was typed laid over it; this tab\'s own save in it isn\'t laid twice', async () => {
        box.arriveChatBox(ada, { owner: { message: '11' }, text: 'base' });
        await settle();
        shown.type(' mine');
        box.takeChatBoxPush(pushed({ message: '11' }, 'other base'));
        box.takeChatBoxPush({ ...pushed({ message: '11' }, 'not this chat'), tree: { avatar: 'Bo.png' } });
        await settle();
        expect(box.chatBoxText()).toBe('other base mine');
        const left = leaving();
        expect(left.changes).toEqual([insert(10, ' mine')]);
        shown.type(' more');
        box.takeChatBoxPush(pushed({ message: '11' }, 'other base mine', { tab: 'tab-a', change: left.change }));
        await settle();
        expect(box.chatBoxText()).toBe('other base mine more');
        expect(leaving().changes).toEqual([insert(15, ' more')]);
        box.takeChatBoxPush(pushed({ message: '11' }, 'yet other base mine', { tab: 'tab-a', change: 'another page/e:1' }));
        await settle();
        expect(box.chatBoxText()).toBe('yet other base mine more', 'an edit of another page of this tab is no edit of this one');
    });

    test('every copy goes with the next open of any chat, a crashed tab\'s and an open tab\'s too, so none outlasts it', async () => {
        box.arriveChatBox(ada, { owner: { message: '3' }, text: '' });
        await settle();
        const crashed = { text: 'from a crashed tab', changes: [insert(0, 'from a crashed tab')] };
        copies().write(ada, { message: '3' }, 'crashed-tab', crashed);
        copies().write(ada, { message: '3' }, 'open-tab', { ...crashed, text: 'from an open tab', changes: [insert(0, 'from an open tab')], change: 'p/e:4' });
        const elsewhere = { text: 'in a chat never opened again', changes: [insert(0, 'in a chat never opened again')] };
        copies().write({ group_id: 'never' }, { root: true }, 'crashed-tab', elsewhere);
        const carried = box.openingChatBox() ?? [];
        expect(carried).toEqual(expect.arrayContaining([
            { avatar_url: 'Ada.png', owner: { message: '3' }, ...crashed, tab: 'crashed-tab' },
            { avatar_url: 'Ada.png', owner: { message: '3' }, text: 'from an open tab', changes: [insert(0, 'from an open tab')], tab: 'open-tab', change: 'p/e:4' },
            { group_id: 'never', owner: { root: true }, ...elsewhere, tab: 'crashed-tab' },
        ]));
        box.chatBoxLeft(carried.map(c => ({ ...c, sent: c.text, left: c.owner.message === '1' ? 'gone' : 'kept', text: 'merged' })));
        expect(copies().all()).toEqual([]);
    });

    test('arriving at a draft this tab has an unconfirmed copy of shows the draft, and sets the copy apart for the next open', async () => {
        const unconfirmed = { text: 'unconfirmed for 5', changes: [insert(0, 'unconfirmed for 5')] };
        copies().write(ada, { message: '5' }, 'tab-a', unconfirmed);
        box.arriveChatBox(ada, { owner: { message: '5' }, text: 'kept for 5' });
        await settle();
        expect(box.chatBoxText()).toBe('kept for 5');
        shown.type('!');
        await settle();
        expect(copies().read(ada, { message: '5' }, 'tab-a')?.text).toBe('kept for 5!');
        expect(box.openingChatBox()).toContainEqual({ avatar_url: 'Ada.png', owner: { message: '5' }, ...unconfirmed, tab: 'tab-a~1' });
        copies().remove(ada, { message: '5' }, 'tab-a~1');
    });

    test('a send takes the text with its changes; its copy stays until the chat ends past it', async () => {
        box.arriveChatBox(ada, { owner: { message: '2' }, text: 'Hi Kit.' });
        await settle();
        end = { message: '2' };
        expect(box.takeChatBoxText()).toEqual({ text: 'Hi Kit.', sent: { message: '2', text: 'Hi Kit.', changes: [] }, from: { chat: ada, owner: { message: '2' } } });
        expect(box.chatBoxText()).toBe('');
        shown.type('next');
        await settle();
        end = { message: '3' };
        box.chatBoxFollowEnd();
        await settle();
        expect(copies().read(ada, { message: '2' }, 'tab-a')).toBeNull();
        expect(box.chatBoxText()).toBe('next');
        expect(leaving()).toMatchObject({ owner: { message: '3' }, text: 'next', changes: [insert(0, 'next')] });
    });

    test('the end moving by what was written keeps the text, now written over the new end\'s draft', async () => {
        shown.type(', about the reply');
        end = { message: '4' };
        box.chatBoxFollowEnd();
        await settle();
        expect(leaving()).toMatchObject({ owner: { message: '4' }, text: 'next, about the reply', changes: [insert(0, 'next, about the reply')] });
        expect(copies().read(ada, { message: '3' }, 'tab-a')).toBeNull();
        expect(copies().read(ada, { message: '4' }, 'tab-a')?.text).toBe('next, about the reply');
    });

    test('a cut back to a message with a draft keeps the text, written over that draft', async () => {
        box.chatBoxFollowCut({ owner: { message: '1' }, text: 'next, what 1 had' });
        await settle();
        expect(box.chatBoxText()).toBe('next, about the reply');
        const { changes } = leaving();
        let text = 'next, what 1 had';
        for (const change of [...changes].reverse()) text = text.slice(0, change.from) + change.insert + text.slice(change.to);
        expect(text).toBe('next, about the reply');
        expect(copies().read(ada, { message: '4' }, 'tab-a')).toBeNull();
    });

    test('the end of another chat than the text\'s is never followed', async () => {
        open = { group_id: 'g' };
        end = { root: true };
        box.chatBoxFollowEnd();
        await settle();
        expect(leaving()?.owner).toEqual({ message: '1' });
    });

    test('arriving where the box already is keeps what it has', async () => {
        box.arriveChatBox({ group_id: 'g' }, { owner: { root: true }, text: 'at the root' });
        await settle();
        shown.type(', edited');
        box.arriveChatBox({ group_id: 'g' }, { owner: { root: true }, text: 'at the root' });
        await settle();
        expect(box.chatBoxText()).toBe('at the root, edited');
    });

    test('its macros are drawn with the person\'s values in the open chat: those its draft came with, and those an answer carries', async () => {
        const { takeMacroValues } = await import('../public/scripts/macro-values.js');
        open = { group_id: 'mac' };
        box.arriveChatBox({ group_id: 'mac' }, { owner: { root: true }, text: 'Hi {{char}}, {{input}}', macro_values: { '{{char}}': 'Mac', '{{input}}': null } });
        await settle();
        expect(shown.macroValue('{{char}}')).toBe('Mac');
        expect(shown.macroValue('{{input}}')).toBeNull();
        shown.type(' {{user}}');
        await settle();
        expect(shown.macroValue('{{user}}')).toBeUndefined();
        takeMacroValues({ group_id: 'mac' }, [{ speaker: null, values: { '{{user}}': 'Me' } }, { speaker: 'Mac', values: { '{{user}}': 'Not the box\'s' } }]);
        expect(shown.macroValue('{{user}}')).toBe('Me');
        expect(shown.macroValue('{{char}}')).toBe('Mac');
        open = { group_id: 'mac2' };
        box.arriveChatBox({ group_id: 'mac2' }, { owner: { root: true }, text: '' });
        expect(shown.macroValue('{{char}}')).toBeUndefined();
        await settle();
        box.writeChatBox('');
        await settle();
    });

    test('a chat that is gone takes its copies with it', () => {
        copies().write(ada, { message: '9' }, 'tab-a', { text: 'x', changes: [insert(0, 'x')] });
        box.forgetChatBoxChat(ada);
        expect(copiesOf(copies(), ada)).toEqual([]);
    });

    test('with storage that refuses, the box keeps its text and carries it as before', async () => {
        globalThis.localStorage = /** @type {any} */ (refusing);
        box.arriveChatBox({ group_id: 'g' }, { owner: { message: '8' }, text: '' });
        await settle();
        box.writeChatBox('no storage');
        await settle();
        expect(box.chatBoxText()).toBe('no storage');
        expect(box.openingChatBox()).toEqual([expect.objectContaining({ group_id: 'g', owner: { message: '8' }, text: 'no storage', changes: [insert(0, 'no storage')], tab: 'tab-a' })]);
        globalThis.localStorage = /** @type {any} */ (storage);
    });

    test('a move empties the box at once and carries its text; what is typed after is laid over the draft its answer brings', async () => {
        box.arriveChatBox(ada, { owner: { message: '20' }, text: '' });
        await settle();
        shown.type('for 20');
        await settle();
        const move = box.moveChatBox({ chat: ada, owner: { message: '21' } });
        expect(move.leaving).toEqual([expect.objectContaining({ owner: { message: '20' }, text: 'for 20' })]);
        expect(box.chatBoxText()).toBe('');
        shown.type('typed while it moves');
        await settle();
        expect(copies().read(ada, { message: '21' }, 'tab-a')?.text).toBe('typed while it moves');
        move.arrive({ owner: { message: '21' }, text: 'draft of 21. ' });
        await settle();
        expect(box.chatBoxText()).toBe('draft of 21. typed while it moves');
        expect(leaving()).toMatchObject({ owner: { message: '21' }, text: 'draft of 21. typed while it moves', changes: [insert(13, 'typed while it moves')] });
        expect(copies().read(ada, { message: '20' }, 'tab-a')?.text).toBe('for 20');
        copies().remove(ada, { message: '20' }, 'tab-a');
    });

    test('the answer of a move a later one took the place of changes nothing', async () => {
        const first = box.moveChatBox({ chat: ada, owner: { message: '22' } });
        const second = box.moveChatBox({ chat: ada, owner: { message: '23' } });
        first.arrive({ owner: { message: '22' }, text: 'not this' });
        first.undo();
        await settle();
        expect(box.chatBoxText()).toBe('');
        second.arrive({ owner: { message: '24' }, text: '' });
        shown.type('at 24');
        await settle();
        expect(leaving()).toMatchObject({ owner: { message: '24' }, text: 'at 24' });
        expect(copies().read(ada, { message: '23' }, 'tab-a')).toBeNull();
    });

    test('a refused move puts the box back where it was, with what was typed since', async () => {
        box.arriveChatBox(ada, { owner: { message: '30' }, text: 'kept for 30' });
        await settle();
        shown.type(', mine');
        await settle();
        const move = box.moveChatBox({ chat: ada, owner: { message: '31' } });
        expect(box.chatBoxText()).toBe('');
        shown.type(' then this');
        await settle();
        move.undo();
        await settle();
        expect(box.chatBoxText()).toBe('kept for 30, mine then this');
        expect(leaving()).toMatchObject({ owner: { message: '30' }, text: 'kept for 30, mine then this' });
        let text = 'kept for 30';
        for (const change of [...leaving().changes].reverse()) text = text.slice(0, change.from) + change.insert + text.slice(change.to);
        expect(text).toBe('kept for 30, mine then this');
        expect(copies().read(ada, { message: '31' }, 'tab-a')).toBeNull();
        move.arrive({ owner: { message: '31' }, text: 'too late' });
        await settle();
        expect(box.chatBoxText()).toBe('kept for 30, mine then this');
        box.writeChatBox('');
        await settle();
    });

    test('a move to a chat being opened carries every copy; what is typed while it opens is the end its answer names', async () => {
        box.arriveChatBox(ada, { owner: { message: '40' }, text: '' });
        await settle();
        shown.type('left in 40');
        await settle();
        const opened = { group_id: 'opened' };
        const move = box.moveChatBox({ chat: opened, owner: null, opening: true });
        expect(move.leaving).toContainEqual(expect.objectContaining({ avatar_url: 'Ada.png', owner: { message: '40' }, text: 'left in 40' }));
        expect(box.chatBoxText()).toBe('');
        shown.type('typed while it opens');
        await settle();
        expect(box.leavingChatBox()).toBeUndefined();
        box.arriveChatBox(opened, { owner: { root: true }, text: 'its draft ' });
        await settle();
        expect(box.chatBoxText()).toBe('its draft typed while it opens');
        expect(leaving()).toMatchObject({ group_id: 'opened', owner: { root: true }, changes: [insert(10, 'typed while it opens')] });
        copies().remove(ada, { message: '40' }, 'tab-a');
    });

    test('text taken for a send that isn\'t made goes back: before what was written since, or as a copy once the box moved on', async () => {
        box.arriveChatBox(ada, { owner: { message: '50' }, text: '' });
        await settle();
        shown.type('pressed');
        await settle();
        const pressed = box.takeChatBoxText();
        expect(box.chatBoxText()).toBe('');
        shown.type(' and after');
        await settle();
        box.giveBackChatBoxText(pressed);
        await settle();
        expect(box.chatBoxText()).toBe('pressed and after');
        const again = box.takeChatBoxText();
        box.moveChatBox({ chat: ada, owner: { message: '51' } }).arrive({ owner: { message: '51' }, text: '' });
        box.giveBackChatBoxText(again);
        await settle();
        expect(box.chatBoxText()).toBe('');
        expect(copies().read(ada, { message: '50' }, 'tab-a')).toMatchObject({ text: 'pressed and after', changes: [insert(0, 'pressed and after')] });
        copies().remove(ada, { message: '50' }, 'tab-a');
    });

    test('a move to where the box is keeps its text and carries it', async () => {
        const stay = { group_id: 'stay' };
        box.arriveChatBox(stay, { owner: { root: true }, text: 'kept' });
        await settle();
        shown.type(' here');
        await settle();
        const move = box.moveChatBox({ chat: stay, owner: { root: true } });
        expect(move.leaving).toEqual([expect.objectContaining({ owner: { root: true }, text: 'kept here' })]);
        expect(box.chatBoxText()).toBe('kept here');
        shown.type('!');
        move.arrive({ owner: { root: true }, text: 'kept here' });
        await settle();
        expect(box.chatBoxText()).toBe('kept here!');
        expect(leaving()?.changes).toEqual([insert(9, '!')]);
    });
});
