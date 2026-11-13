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
 * (`leavingChatBox`, `openingChatBox`), or when the page is hidden. The server lays it over its draft by the version it
 * was written over, and answers with the draft as merged; drafts written in other tabs arrive pushed
 * (`takeChatBoxPush`). Either is shown with what was typed since laid over it, as the editor's text port does. Until the
 * server confirms a text, the browser keeps a copy of it, this tab's own, written on every edit
 * (`chat-box-copies.js`), so a crash or a lost request loses nothing.
 */

/**
 * @typedef {import('./chat-box-ends.js').DraftOwner} DraftOwner
 * @typedef {{ avatar_url: string } | { group_id: string }} ChatOf
 * @typedef {{ owner: DraftOwner, text: string, version: string }} Draft
 * @typedef {Partial<ChatOf> & { owner: DraftOwner, text: string, version: string, tab: string }} LeftDraft a draft as a
 *   request carries it to be kept
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

/** A draft never written */
const NO_VERSION = '0.0';

const copies = boxCopies(guardedStorage(() => globalThis.localStorage));

/**
 * @type {{ chat: ChatOf, owner: DraftOwner, version: string, text: string } | null} the end the box's text responds
 *   to, and its draft as the server last told this page: the version and its text
 */
let here = null;
/** @type {{ chat: ChatOf, owner: DraftOwner, text: string } | null} the text a send took, until the chat ends past what it responded to */
let sending = null;
/** @type {{ sent: string, includes: string | undefined } | null} a save of the box's text not answered yet, and the latest edit it holds */
let saving = null;
/** @type {{ text: string, version: string } | null} the newest draft pushed while a save was not answered */
let heldPush = null;
/** @type {string | null} the tab this one says is open */
let saidOpen = null;

const tab = () => tabToken();

/**
 * @param {string | undefined} version
 * @returns {[string, string] | null} its two whole numbers, as written
 */
const versionParts = (version) => {
    const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version ?? '');
    return parts ? [parts[1], parts[2]] : null;
};

/**
 * @param {string} a a whole number as written, without leading zeros
 * @param {string} b
 * @returns {number} below, at or above 0 as `a` is less than, equal to or greater than `b`
 */
const compareWhole = (a, b) => (a.length === b.length ? (a < b ? -1 : a > b ? 1 : 0) : a.length - b.length);

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean} whether `a` is a later version of a draft than `b`
 */
export function laterVersion(a, b) {
    const x = versionParts(a);
    const y = versionParts(b);
    if (x === null || y === null) return false;
    const written = compareWhole(x[0], y[0]);
    return written > 0 || (written === 0 && compareWhole(x[1], y[1]) > 0);
}

function sayOpen() {
    const now = tab();
    if (saidOpen === now) return;
    saidOpen = now;
    copies.setOpen(now, true);
}

const keepCopy = () => {
    if (!here) return;
    sayOpen();
    const written = text.text();
    if (written === here.text) copies.remove(here.chat, here.owner, tab());
    else copies.write(here.chat, here.owner, tab(), { text: written, version: here.version });
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
 * The server's draft of where the box is, with what the editor typed since its latest edit `includes` laid over it
 * @param {string} draft
 * @param {string} version
 * @param {string | undefined} includes
 */
function hear(draft, version, includes) {
    if (!here) return;
    here.text = draft;
    here.version = version;
    text.heard(draft, includes);
    queueMicrotask(keepCopy);
}

/**
 * A save of the box's text is answered, or is not to be: a draft pushed meanwhile that is later than the one heard is
 * shown now
 */
function settleSaving() {
    saving = null;
    const pushed = heldPush;
    heldPush = null;
    if (pushed && here && laterVersion(pushed.version, here.version)) hear(pushed.text, pushed.version, undefined);
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
    if (sameOwner(owner, was.owner)) {
        if (!known || known.version === was.version) return;
        copies.confirm(was.chat, was.owner, tab(), text.text());
    }
    here = { chat: was.chat, owner, version: known?.version ?? NO_VERSION, text: known?.text ?? '' };
    saving = null;
    heldPush = null;
    keepCopy();
    if (!sameOwner(owner, was.owner)) copies.confirm(was.chat, was.owner, tab(), text.text());
    if (sending && sameChat(sending.chat, was.chat) && !sameOwner(owner, sending.owner)) {
        copies.confirm(sending.chat, sending.owner, tab(), sending.text);
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
    window.addEventListener('pagehide', () => {
        keepLeft();
        copies.setOpen(tab(), false);
        saidOpen = null;
    });
    window.addEventListener('pageshow', sayOpen);
    sayOpen();
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
        chatBoxLeft([{ ...leaving, sent: leaving.text, left: answer.left, text: answer.text, version: answer.version }]);
    } catch (error) {
        console.warn('The chat box\'s text was not kept:', error);
        settleSaving();
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
 * @returns {{ text: string, sent: (DraftOwner & { version: string }) | null }} the text, and the draft it was and the
 *   version it was written over: what the send takes out of the draft
 */
export function takeChatBoxText() {
    follow(null);
    const taken = text.text();
    const sent = here ? { ...here.owner, version: here.version } : null;
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
 * the text yet: with the chat it was written in, the version it was written over and this tab
 * @returns {LeftDraft[] | undefined}
 */
export function leavingChatBox() {
    const written = text.text();
    if (!here || written === here.text) return undefined;
    saving = { sent: written, includes: text.latest() };
    return [{ ...here.chat, owner: here.owner, text: written, version: here.version, tab: tab() }];
}

/**
 * What a request that opens a chat carries: the text it leaves, and every copy the browser kept of text written in
 * that chat that the server hasn't confirmed, from this tab's earlier pages and from tabs closed since
 * @param {ChatOf} chat the chat it opens
 * @returns {LeftDraft[] | undefined}
 */
export function openingChatBox(chat) {
    const own = tab();
    const open = new Set(copies.openTabs());
    const live = here;
    const left = copies.of(chat).filter(copy => (copy.tab === own || !open.has(copy.tab)) && !(copy.tab === own && live && sameChat(live.chat, chat) && sameOwner(live.owner, copy.owner)));
    const all = [...leavingChatBox() ?? [], ...left.map(copy => ({ ...chat, owner: copy.owner, text: copy.text, version: copy.version, tab: copy.tab }))];
    return all.length ? all : undefined;
}

/**
 * Hears what became of the drafts a request carried, as its answer names them: a copy of a text the server kept, or
 * won't keep because what it responds to is gone, is gone; one the server didn't answer for stays, to be carried again.
 * The box's own text, kept, is shown as the server merged it, with what was typed since laid over it.
 * @param {unknown} left the answer's `left`
 */
export function chatBoxLeft(left) {
    if (!Array.isArray(left)) return;
    for (const draft of left) {
        if (!draft || typeof draft !== 'object' || typeof draft.sent !== 'string' || !draft.owner) continue;
        if (typeof draft.avatar_url !== 'string' && typeof draft.group_id !== 'string') continue;
        const chat = chatIn(draft);
        const from = typeof draft.tab === 'string' ? draft.tab : tab();
        if (draft.left !== 'kept' && draft.left !== 'gone') continue;
        copies.confirm(chat, draft.owner, from, draft.sent);
        if (from !== tab() || !isHere(chat, draft.owner) || !saving || saving.sent !== draft.sent) continue;
        const { includes } = saving;
        if (draft.left === 'kept' && typeof draft.text === 'string' && typeof draft.version === 'string') hear(draft.text, draft.version, includes);
        settleSaving();
    }
}

/**
 * A draft written in another tab or on another device: shown, with what was typed here since laid over it, when the
 * box is at it and it is later than what the box has
 * @param {{ tree?: { avatar?: string, group?: string }, owner?: DraftOwner, text?: unknown, version?: unknown }} frame
 */
export function takeChatBoxPush(frame) {
    const tree = frame.tree;
    if (!tree || !frame.owner || typeof frame.text !== 'string' || typeof frame.version !== 'string') return;
    const chat = /** @type {ChatOf} */ (typeof tree.group === 'string' ? { group_id: tree.group } : { avatar_url: tree.avatar });
    if (!isHere(chat, frame.owner) || !here) return;
    if (saving) {
        if (!heldPush || laterVersion(frame.version, heldPush.version)) heldPush = { text: frame.text, version: frame.version };
        return;
    }
    if (laterVersion(frame.version, here.version)) hear(frame.text, frame.version, undefined);
}

/**
 * The person is at another end, or another chat: the box shows that end's draft, or this tab's copy of text written
 * over that same version and not kept yet. A copy written over another version is left for the next open of the chat
 * to carry. Text written before any chat was open stays, to be kept for the end it's sent after.
 * @param {ChatOf} chat
 * @param {Draft | undefined} draft the end's draft, as the answer that moved them carries it
 */
export function arriveChatBox(chat, draft) {
    if (!draft) return;
    if (here && isHere(chat, draft.owner)) {
        if (laterVersion(draft.version, here.version) && !saving) hear(draft.text, draft.version, undefined);
        return;
    }
    const first = here === null;
    here = { chat, owner: draft.owner, version: draft.version, text: draft.text };
    saving = null;
    heldPush = null;
    if (first && text.text() !== '' && draft.text === '') {
        keepCopy();
        return;
    }
    const copy = copies.read(chat, draft.owner, tab());
    if (copy && copy.version === draft.version) {
        if (text.text() !== copy.text) text.replace(copy.text);
        return;
    }
    if (copy) {
        copies.remove(chat, draft.owner, tab());
        copies.write(chat, draft.owner, `${tab()}@${copy.version}`, copy);
    }
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
