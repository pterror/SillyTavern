import { boxText } from './chat-box-text.js';
import { boxCopies, guardedStorage } from './chat-box-copies.js';
import { sameOwner } from './chat-box-ends.js';
import { loadChatEditor } from './chat-text/editors.js';
import { getRequestHeaders } from './request-headers.js';

/**
 * The chat box. Its text is its own; an action that uses it takes it when the action is taken (`chatBoxText`,
 * `takeChatBoxText`), and whatever puts text in it writes it (`writeChatBox`). The text is kept on the server as the
 * draft of the message the chat ends on only when the person leaves that end: in the request that moves them
 * (`leavingChatBox`, `openingChatBox`), or when the page is hidden. Until the server says it kept a text, the browser
 * keeps a copy of it, written on every edit (`chat-box-copies.js`), so a crash or a lost request loses nothing.
 * Arriving at an end shows its draft (`arriveChatBox`).
 */

/**
 * @typedef {import('./chat-box-ends.js').DraftOwner} DraftOwner
 * @typedef {{ avatar_url: string } | { group_id: string }} ChatOf
 * @typedef {{ owner: DraftOwner, text: string }} Draft
 * @typedef {Draft & Partial<ChatOf> & { base: string }} LeftDraft a draft as a request carries it to be kept
 * @typedef {import('@codemirror/view').KeyBinding} KeyBinding
 */

/**
 * @typedef {object} ChatBoxPage
 * @property {HTMLElement} element where the box goes
 * @property {() => ChatOf | null} chat the chat open now
 * @property {() => DraftOwner} endOwner what the open chat ends on now
 * @property {() => import('./chat-text/surface.js').TextSetup} setup how the box's text is drawn, as the settings are when it's made
 * @property {string} label
 * @property {readonly KeyBinding[]} keys the box's commands
 * @property {Parameters<typeof import('./chat-text/suggest.js').slashSuggestions>[0]} slashParser
 * @property {(text: string) => boolean} slashWanted
 */

const copies = boxCopies(guardedStorage(() => globalThis.localStorage));

/** @type {{ chat: ChatOf, owner: DraftOwner, base: string } | null} the end the box's text is written after, as last known, and its draft on the server as far as this page knows */
let here = null;
/** @type {{ chat: ChatOf, owner: DraftOwner, text: string } | null} the text a send took, until the chat ends past what it responded to */
let sending = null;

const keepCopy = () => {
    if (here) copies.write(here.chat, here.owner, text.text(), here.base);
};

const text = boxText('', keepCopy);
/** @type {import('./chat-text/chat-box-editor.js').ChatBoxEditor | null} */
let editor = null;
let shownPlaceholder = '';

/**
 * @param {ChatOf} a
 * @param {ChatOf} b
 */
const sameChat = (a, b) => ('group_id' in a ? 'group_id' in b && a.group_id === b.group_id : 'avatar_url' in b && a.avatar_url === b.avatar_url);

/** @param {Partial<ChatOf>} given */
const chatIn = given => /** @type {ChatOf} */ (typeof given.group_id === 'string' ? { group_id: given.group_id } : { avatar_url: given.avatar_url });

/** @type {ChatBoxPage | null} */
let page = null;

/**
 * The open chat ended on another message by what was written in it, not by the person moving (a sent message, a stored
 * reply): the box's text now responds to that one, whose draft is new
 */
export function chatBoxFollowEnd() {
    follow(null);
}

/**
 * A cut took the open chat's end back to a message that may have a draft: the box's text now responds to it
 * @param {Draft | undefined} draft that end's draft, as the cut's answer carries it
 */
export function chatBoxFollowCut(draft) {
    if (draft) follow(draft);
}

/**
 * @param {Draft | null} known the new end's draft, when the answer that moved it says
 */
function follow(known) {
    const chat = page?.chat();
    if (!page || !here || !chat || !sameChat(chat, here.chat)) return;
    const owner = known?.owner ?? page.endOwner();
    const base = known?.text ?? '';
    const was = here;
    if (sameOwner(owner, was.owner)) {
        if (!known || known.text === was.base) return;
        copies.drop(was.chat, was.owner, text.text());
    }
    here = { chat: was.chat, owner, base };
    keepCopy();
    if (!sameOwner(owner, was.owner)) copies.drop(was.chat, was.owner, text.text());
    if (sending && sameChat(sending.chat, was.chat) && !sameOwner(owner, sending.owner)) {
        copies.drop(sending.chat, sending.owner, sending.text);
        sending = null;
    }
}

/**
 * Puts the box in its element; the editor library is loaded for it at once
 * @param {ChatBoxPage} dependencies
 * @returns {Promise<void>} when the box can be written in
 */
export async function initChatBox(dependencies) {
    page = dependencies;
    const keep = () => {
        if (document.visibilityState === 'hidden') keepLeft();
    };
    document.addEventListener('visibilitychange', keep);
    window.addEventListener('pagehide', keepLeft);
    await loadChatEditor();
    const { chatBoxEditor } = await import('./chat-text/chat-box-editor.js');
    editor = chatBoxEditor({
        parent: page.element,
        text,
        setup: page.setup(),
        label: page.label,
        keys: page.keys,
        slashParser: page.slashParser,
        slashWanted: page.slashWanted,
        maxHeight: '50dvh',
    });
    if (shownPlaceholder) editor.placeholder(shownPlaceholder);
}

/**
 * Keeps the text as its end's draft, as the page goes away or is hidden: the request may outlive the page. Until its
 * answer says the text is kept, the browser's copy stays.
 * @returns {Promise<void>}
 */
async function keepLeft() {
    const [leaving] = leavingChatBox() ?? [];
    if (!leaving) return;
    try {
        const response = await fetch('/api/chats/draft', { method: 'POST', keepalive: true, headers: getRequestHeaders(), body: JSON.stringify(leaving) });
        if (!response.ok) return;
        const answer = await response.json();
        chatBoxLeft([{ ...leaving, left: answer.left }]);
        const chat = chatIn(leaving);
        if (answer.left === 'superseded' && typeof answer.text === 'string' && here && sameChat(here.chat, chat) && sameOwner(here.owner, leaving.owner) && text.text() === leaving.text) {
            here.base = answer.text;
            text.replace(answer.text);
        }
    } catch (error) {
        console.warn('The chat box\'s text was not kept:', error);
    }
}

/**
 * @returns {string} the box's text, for an action taken now that uses it
 */
export function chatBoxText() {
    return text.text();
}

/**
 * Takes the box's text for an action that sends it, leaving the box empty. The browser's copy of it stays until the
 * chat ends past what it responded to, which a stored send makes it.
 * @returns {{ text: string, sent: DraftOwner | null }} the text, and the draft it was: what the send clears
 */
export function takeChatBoxText() {
    follow(null);
    const taken = text.text();
    const sent = here?.owner ?? null;
    if (here && taken !== '') sending = { chat: here.chat, owner: here.owner, text: taken };
    if (taken !== '') text.replace('');
    return { text: taken, sent };
}

/**
 * Writes text in the box in place of what it has, as the person's own edit (undone as one)
 * @param {string} written
 */
export function writeChatBox(written) {
    const view = editor?.view;
    if (!view) {
        text.replace(written);
        keepCopy();
        return;
    }
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: written }, selection: { anchor: written.length }, userEvent: 'input.set' });
}

/**
 * The draft an action that moves the person away from where their chat ends carries, when the server doesn't have
 * the text yet: with the chat it was written in and the draft it was written over
 * @returns {LeftDraft[] | undefined}
 */
export function leavingChatBox() {
    const written = text.text();
    if (!here || written === here.base) return undefined;
    return [{ ...here.chat, owner: here.owner, text: written, base: here.base }];
}

/**
 * What a request that opens a chat carries: the text it leaves, and every copy the browser kept of text written in
 * that chat that the server hasn't confirmed, as from an earlier page
 * @param {ChatOf} chat the chat it opens
 * @returns {LeftDraft[] | undefined}
 */
export function openingChatBox(chat) {
    const live = here;
    const kept = copies.of(chat).filter(copy => !(live && sameChat(live.chat, chat) && sameOwner(live.owner, copy.owner)));
    const all = [...leavingChatBox() ?? [], ...kept.map(copy => ({ ...chat, owner: copy.owner, text: copy.text, base: copy.base }))];
    return all.length ? all : undefined;
}

/**
 * Hears what became of the drafts a request carried, as its answer names them: a copy of a text the server kept, or
 * won't keep (the draft changed since, or what it responded to is gone), is gone; one the server didn't answer for
 * stays, to be carried again
 * @param {unknown} left the answer's `left`
 */
export function chatBoxLeft(left) {
    if (!Array.isArray(left)) return;
    for (const draft of left) {
        if (!draft || typeof draft !== 'object' || typeof draft.text !== 'string' || !draft.owner) continue;
        if (typeof draft.avatar_url !== 'string' && typeof draft.group_id !== 'string') continue;
        const chat = chatIn(draft);
        if (draft.left === 'kept') {
            copies.kept(chat, draft.owner, draft.text);
            if (here && sameChat(here.chat, chat) && sameOwner(here.owner, draft.owner)) here.base = draft.text;
        } else if (draft.left === 'superseded' || draft.left === 'gone') {
            copies.drop(chat, draft.owner, draft.text);
        }
    }
}

/**
 * The person is at another end, or another chat: the box shows that end's draft, or the browser's copy of text written
 * over that same draft and not kept yet. A copy written over a draft that changed since is gone. Text written before
 * any chat was open stays, to be kept for the end it's sent after.
 * @param {ChatOf} chat
 * @param {Draft | undefined} draft the end's draft, as the answer that moved them carries it
 */
export function arriveChatBox(chat, draft) {
    if (!draft) return;
    if (here && sameChat(here.chat, chat) && sameOwner(here.owner, draft.owner)) {
        if (text.text() === draft.text) {
            here.base = draft.text;
            keepCopy();
        }
        return;
    }
    const first = here === null;
    here = { chat, owner: draft.owner, base: draft.text };
    if (first && text.text() !== '' && draft.text === '') {
        keepCopy();
        return;
    }
    const copy = copies.read(chat, draft.owner);
    if (copy && copy.base === draft.text) {
        if (text.text() !== copy.text) text.replace(copy.text);
        return;
    }
    if (copy) copies.drop(chat, draft.owner, copy.text);
    if (text.text() !== draft.text) text.replace(draft.text);
}

/**
 * A chat that is gone: the browser's copies of text written in it go with it
 * @param {ChatOf} chat
 */
export function forgetChatBoxChat(chat) {
    copies.dropChat(chat);
}

/**
 * @param {string} shown what the empty box says
 */
export function setChatBoxPlaceholder(shown) {
    shownPlaceholder = shown;
    editor?.placeholder(shown);
}

export function focusChatBox() {
    editor?.view.focus();
}
