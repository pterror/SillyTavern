import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { boxText } from '../public/scripts/chat-box-text.js';
import { endOwnerOf, sameOwner } from '../public/scripts/chat-box-ends.js';

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

describe('the chat box\'s drafts', () => {
    /** @type {import('../public/scripts/chat-box-ends.js').DraftOwner} */
    let end = { message: '1' };
    /** @type {{ avatar_url: string } | { group_id: string } | null} */
    let open = { avatar_url: 'Ada.png' };

    beforeAll(() => {
        box.initChatBox(/** @type {any} */ ({ chat: () => open, endOwner: () => end }));
    });

    test('text written before any chat is open stays when one opens', () => {
        box.writeChatBox('early');
        box.arriveChatBox({ avatar_url: 'Ada.png' }, { owner: { message: '1' }, text: '' });
        expect(box.chatBoxText()).toBe('early');
        expect(box.leavingChatBox()).toEqual({ owner: { message: '1' }, text: 'early' });
    });

    test('arriving at another end shows its draft; leaving it carries the text once, with its chat when asked', () => {
        box.arriveChatBox({ avatar_url: 'Ada.png' }, { owner: { message: '2' }, text: 'kept for 2' });
        expect(box.chatBoxText()).toBe('kept for 2');
        expect(box.leavingChatBox()).toBeUndefined();
        box.writeChatBox('kept for 2, more');
        expect(box.leavingChatBox({ named: true })).toEqual({ owner: { message: '2' }, text: 'kept for 2, more', avatar_url: 'Ada.png' });
        expect(box.leavingChatBox()).toBeUndefined();
    });

    test('a send takes the text and names the draft it was; the box is empty after it', () => {
        box.writeChatBox('hello');
        end = { message: '2' };
        expect(box.takeChatBoxText()).toEqual({ text: 'hello', sent: { message: '2' } });
        expect(box.chatBoxText()).toBe('');
    });

    test('the end moving by what was written keeps the text, now after the new end', () => {
        box.writeChatBox('about the reply');
        end = { message: '4' };
        box.chatBoxFollowEnd();
        expect(box.leavingChatBox()).toEqual({ owner: { message: '4' }, text: 'about the reply' });
    });

    test('the end of another chat than the text\'s is never followed', () => {
        box.arriveChatBox({ avatar_url: 'Ada.png' }, { owner: { message: '4' }, text: 'about the reply' });
        box.writeChatBox('still about 4');
        open = { group_id: 'g' };
        end = { root: true };
        box.chatBoxFollowEnd();
        expect(box.leavingChatBox({ named: true })).toEqual({ owner: { message: '4' }, text: 'still about 4', avatar_url: 'Ada.png' });
    });

    test('arriving where the box already is keeps what it has', () => {
        box.arriveChatBox({ group_id: 'g' }, { owner: { root: true }, text: 'at the root' });
        box.writeChatBox('at the root, edited');
        box.arriveChatBox({ group_id: 'g' }, { owner: { root: true }, text: 'at the root' });
        expect(box.chatBoxText()).toBe('at the root, edited');
    });
});
