import { boxText } from './chat-box-text.js';
import { sameOwner } from './chat-box-ends.js';
import { loadChatEditor } from './chat-text/editors.js';
import { getRequestHeaders } from './request-headers.js';

/**
 * The chat box. Its text is its own; an action that uses it takes it when the action is taken (`chatBoxText`,
 * `takeChatBoxText`), and whatever puts text in it writes it (`writeChatBox`). The text is kept on the server as the
 * draft of the message the chat ends on only when the person leaves that end: in the request that moves them
 * (`leavingChatBox`), or when the page is hidden. Arriving at an end shows its draft (`arriveChatBox`).
 */

/**
 * @typedef {import('./chat-box-ends.js').DraftOwner} DraftOwner
 * @typedef {{ avatar_url: string } | { group_id: string }} ChatOf
 * @typedef {{ owner: DraftOwner, text: string }} Draft
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

const text = boxText();

/** @type {{ chat: ChatOf, owner: DraftOwner } | null} the end the box's text is written after, as last known */
let here = null;
/** The text the server keeps as the draft of `here`, as far as this page knows */
let kept = '';
/** @type {import('./chat-text/chat-box-editor.js').ChatBoxEditor | null} */
let editor = null;
let shownPlaceholder = '';

/**
 * @param {ChatOf} a
 * @param {ChatOf} b
 */
const sameChat = (a, b) => ('group_id' in a ? 'group_id' in b && a.group_id === b.group_id : 'avatar_url' in b && a.avatar_url === b.avatar_url);

/** @type {ChatBoxPage | null} */
let page = null;

/**
 * The open chat ended on another message by what was written in it, not by the person moving (a sent message, a stored
 * reply): the box's text now responds to that one
 */
export function chatBoxFollowEnd() {
    follow();
}

function follow() {
    const chat = page?.chat();
    if (page && here && chat && sameChat(chat, here.chat)) here.owner = page.endOwner();
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

/** Keeps the text as its end's draft, as the page goes away or is hidden: the request may outlive the page */
function keepLeft() {
    const leaving = leavingChatBox({ named: true });
    if (!leaving) return;
    fetch('/api/chats/draft', { method: 'POST', keepalive: true, headers: getRequestHeaders(), body: JSON.stringify(leaving) })
        .catch(error => console.warn('The chat box\'s text was not kept:', error));
}

/**
 * @returns {string} the box's text, for an action taken now that uses it
 */
export function chatBoxText() {
    return text.text();
}

/**
 * Takes the box's text for an action that sends it, leaving the box empty
 * @returns {{ text: string, sent: DraftOwner | null }} the text, and the draft it was: what the send clears
 */
export function takeChatBoxText() {
    follow();
    const taken = text.text();
    const sent = here?.owner ?? null;
    if (taken !== '') text.replace('');
    kept = '';
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
        return;
    }
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: written }, selection: { anchor: written.length }, userEvent: 'input.set' });
}

/**
 * The draft an action that moves the person away from where their chat ends carries, when the text isn't kept yet
 * @param {{ named?: boolean }} [options] named: with the chat it was written in, for an action in another chat
 * @returns {(Draft & Partial<ChatOf>) | undefined}
 */
export function leavingChatBox({ named = false } = {}) {
    const written = text.text();
    if (!here || written === kept) return undefined;
    kept = written;
    return { owner: here.owner, text: written, ...(named ? here.chat : {}) };
}

/**
 * The person is at another end, or another chat: the box shows that end's draft. Text written before any chat was
 * open stays, to be kept for the end it's sent after.
 * @param {ChatOf} chat
 * @param {Draft | undefined} draft the end's draft, as the answer that moved them carries it
 */
export function arriveChatBox(chat, draft) {
    if (!draft) return;
    const first = here === null;
    const same = here !== null && sameChat(here.chat, chat) && sameOwner(here.owner, draft.owner);
    here = { chat, owner: draft.owner };
    kept = draft.text;
    if (same || (first && text.text() !== '' && draft.text === '')) return;
    if (text.text() !== draft.text) text.replace(draft.text);
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
