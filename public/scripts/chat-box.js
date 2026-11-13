import { boxText } from './chat-box-text.js';
import { boxCopies, guardedStorage } from './chat-box-copies.js';
import { sameOwner } from './chat-box-ends.js';
import { loadChatEditor } from './chat-text/editors.js';
import { getRequestHeaders } from './request-headers.js';
import { tabToken } from './tab-session.js';

/**
 * The chat box. Its text is a view of the draft of the message the chat ends on, as the server has it: an action that
 * uses it takes it when the action is taken (`chatBoxText`, `takeChatBoxText`), and whatever puts text in it writes it
 * (`writeChatBox`). The text goes to the server only when the person leaves that end: in the request that moves them
 * (`leavingChatBox`, `openingChatBox`), or when the page is hidden. A save carries its text and the changes from the
 * draft it was written over, which the server merges into its draft. Every draft the server writes is pushed to every
 * tab (`takeChatBoxPush`), and shown with what was typed since laid over it, as the editor's text port does. Until the
 * server confirms a text, the browser keeps a copy of it, this tab's own, written on every edit (`chat-box-copies.js`),
 * so a crash or a lost request loses nothing.
 */

/**
 * @typedef {import('./chat-box-ends.js').DraftOwner} DraftOwner
 * @typedef {import('./chat-box-text.js').BoxChange} BoxChange
 * @typedef {{ avatar_url: string } | { group_id: string }} ChatOf
 * @typedef {{ owner: DraftOwner, text: string }} Draft
 * @typedef {Partial<ChatOf> & { owner: DraftOwner, text: string, changes: BoxChange[], tab: string, change?: string }} LeftDraft
 *   a draft as a request carries it to be kept
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

/** This page's own, so an edit id of an earlier page of this tab is never taken for one of its own */
const PAGE = Math.random().toString(36).slice(2);

/**
 * @type {{ chat: ChatOf, owner: DraftOwner, base: string } | null} the end the box's text responds to, and its draft
 *   as this page last heard it
 */
let here = null;

const tab = () => tabToken();

/** @returns {string | undefined} the latest edit, as a save and the push of what it made name it */
const change = () => {
    const latest = text.latest();
    return latest === undefined ? undefined : `${PAGE}/${latest}`;
};

/**
 * The edits the box has that its draft as heard doesn't: the text they were written over, and the changes to the box's
 * text
 * @returns {{ base: string, changes: BoxChange[] }}
 */
function unsaved() {
    const view = editor?.unsaved();
    if (view) return { base: view.text, changes: view.changes };
    const base = here?.base ?? '';
    const written = text.text();
    return { base, changes: written === base ? [] : [{ from: 0, to: base.length, insert: written, deleted: base }] };
}

const keepCopy = () => {
    if (!here) return;
    const written = text.text();
    const { base, changes } = unsaved();
    if (written === base) {
        copies.remove(here.chat, here.owner, tab());
        return;
    }
    const latest = change();
    copies.write(here.chat, here.owner, tab(), { text: written, changes, ...(latest ? { change: latest } : {}) });
};

const text = boxText('', () => queueMicrotask(keepCopy));
/** @type {import('./chat-text/chat-box-editor.js').ChatBoxEditor | null} */
let editor = null;
let shownPlaceholder = '';

/**
 * @param {ChatOf} a
 * @param {ChatOf} b
 */
const sameChat = (a, b) => ('group_id' in a ? 'group_id' in b && a.group_id === b.group_id : 'avatar_url' in b && a.avatar_url === b.avatar_url);

/** @param {{ avatar_url?: string, group_id?: string }} given */
const chatIn = given => /** @type {ChatOf} */ (typeof given.group_id === 'string' ? { group_id: given.group_id } : { avatar_url: given.avatar_url });

/**
 * @param {ChatOf} chat
 * @param {DraftOwner} owner
 */
const isHere = (chat, owner) => here !== null && sameChat(here.chat, chat) && sameOwner(here.owner, owner);

/** @type {ChatBoxPage | null} */
let page = null;

/**
 * The box's draft is `base` now, and the box keeps what it shows: what it has that `base` doesn't is its unsaved text
 * @param {string} base
 */
function rebase(base) {
    if (!here) return;
    here.base = base;
    if (editor) editor.rebase(base);
    else text.rebased(base, undefined);
}

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
    const was = here;
    if (sameOwner(owner, was.owner)) return;
    here = { chat: was.chat, owner, base: was.base };
    rebase(known?.text ?? '');
    keepCopy();
    copies.remove(was.chat, was.owner, tab());
}

/**
 * Puts the box in its element; the editor library is loaded for it at once
 * @param {ChatBoxPage} dependencies
 * @returns {Promise<void>} when the box can be written in
 */
export async function initChatBox(dependencies) {
    page = dependencies;
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') keepLeft();
    });
    window.addEventListener('pagehide', () => keepLeft());
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
    const view = editor.view;
    text.bind(() => view.state.doc.toString());
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
        if (!response.ok) throw new Error(`The draft save answered ${response.status}`);
        const answer = await response.json();
        chatBoxLeft([{ ...leaving, sent: leaving.text, left: answer.left, text: answer.text }]);
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
 * Takes the box's text for an action that sends it, leaving the box empty. Text typed since is the box's own; the
 * chat ending past what the text responded to, which a stored send makes it, moves it there.
 * @returns {{ text: string, sent: (DraftOwner & { text: string, changes: BoxChange[] }) | null }} the text, and the draft
 *   it was with the changes it was written with: what the send takes out of the draft
 */
export function takeChatBoxText() {
    follow(null);
    const taken = text.text();
    const sent = here ? { ...here.owner, text: taken, changes: unsaved().changes } : null;
    if (taken !== '') writeChatBox('');
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
 * the text yet: with the chat it was written in, its changes, this tab and the latest edit it holds
 * @returns {LeftDraft[] | undefined}
 */
export function leavingChatBox() {
    if (!here) return undefined;
    const written = text.text();
    const { base, changes } = unsaved();
    if (written === base) return undefined;
    const latest = change();
    return [{ ...here.chat, owner: here.owner, text: written, changes, tab: tab(), ...(latest ? { change: latest } : {}) }];
}

/**
 * What a request that opens a chat carries: the text it leaves, and every copy the browser kept of text written in
 * that chat that the server hasn't confirmed, from any tab. A copy already in the draft changes nothing when merged
 * again, so one that a tab still open is writing goes too.
 * @param {ChatOf} chat the chat it opens
 * @returns {LeftDraft[] | undefined}
 */
export function openingChatBox(chat) {
    const own = tab();
    const live = here;
    const kept = copies.of(chat).filter(copy => !(copy.tab === own && live && sameChat(live.chat, chat) && sameOwner(live.owner, copy.owner)));
    const all = [...leavingChatBox() ?? [], ...kept.map(copy => ({ ...chat, owner: copy.owner, text: copy.text, changes: copy.changes, tab: copy.tab, ...(copy.change ? { change: copy.change } : {}) }))];
    return all.length ? all : undefined;
}

/**
 * Hears what became of the drafts a request carried, as its answer names them: a copy of a text the server kept, or
 * won't keep because what it responds to is gone, is gone; one the server didn't answer for stays, to be carried again.
 * The draft the server made of it is shown when its push arrives.
 * @param {unknown} left the answer's `left`
 */
export function chatBoxLeft(left) {
    if (!Array.isArray(left)) return;
    for (const draft of left) {
        if (!draft || typeof draft !== 'object' || typeof draft.sent !== 'string' || !draft.owner) continue;
        if (typeof draft.avatar_url !== 'string' && typeof draft.group_id !== 'string') continue;
        if (draft.left !== 'kept' && draft.left !== 'gone') continue;
        copies.confirm(chatIn(draft), draft.owner, typeof draft.tab === 'string' ? draft.tab : tab(), draft.sent);
    }
}

/**
 * A draft the server wrote, from any tab or device: shown when the box is at it, with the edits it doesn't hold laid
 * over it. It holds this page's edits up to the one it names, when it came from a save of this page's.
 * @param {{ tree?: { avatar?: string, group?: string }, owner?: DraftOwner, text?: unknown, tab?: unknown, change?: unknown }} frame
 */
export function takeChatBoxPush(frame) {
    const tree = frame.tree;
    if (!tree || !frame.owner || typeof frame.text !== 'string' || !here) return;
    const chat = /** @type {ChatOf} */ (typeof tree.group === 'string' ? { group_id: tree.group } : { avatar_url: tree.avatar });
    const greeting = 'greeting' in frame.owner && 'greeting' in here.owner;
    if (!(greeting ? sameOwner(here.owner, frame.owner) : isHere(chat, frame.owner))) return;
    const own = frame.tab === tab() && typeof frame.change === 'string' && frame.change.startsWith(`${PAGE}/`);
    here.base = frame.text;
    text.heard(frame.text, own ? /** @type {string} */ (frame.change).slice(PAGE.length + 1) : undefined);
    queueMicrotask(keepCopy);
}

/**
 * The person is at another end, or another chat: the box shows that end's draft. Text written before any chat was
 * open stays, to be kept for the end it's sent after. A copy this tab kept for that end, which the request that moved
 * here didn't get kept, is set apart, so the box's own copy never writes over it; the next open of the chat carries it.
 * @param {ChatOf} chat
 * @param {Draft | undefined} draft the end's draft, as the answer that moved them carries it
 */
export function arriveChatBox(chat, draft) {
    if (!draft) return;
    if (here && isHere(chat, draft.owner)) return;
    const first = here === null;
    here = { chat, owner: draft.owner, base: draft.text };
    copies.setApart(chat, draft.owner, tab());
    if (first && text.text() !== '' && draft.text === '') {
        rebase('');
        keepCopy();
        return;
    }
    text.replace(draft.text);
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
