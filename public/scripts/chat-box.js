import { boxText } from './chat-box-text.js';
import { boxCopies, guardedStorage } from './chat-box-copies.js';
import { sameOwner } from './chat-box-ends.js';
import { loadChatEditor } from './chat-text/editors.js';
import { getRequestHeaders } from './request-headers.js';
import { MacroValues as AskedValues } from './macro-values.js';
import { macrosIn } from './safe-macros.js';
import { tabToken } from './tab-session.js';

/**
 * The chat box. Its text is a view of the draft of the message the chat ends on, as the server has it: an action that
 * uses it takes it when the action is taken (`chatBoxText`, `takeChatBoxText`), and whatever puts text in it writes it
 * (`writeChatBox`). The text goes to the server only when the person leaves that end: in the request that moves them
 * (`moveChatBox`), or when the page is hidden. A save carries its text and the changes from the draft it was written
 * over, which the server merges into its draft. Every draft the server writes is pushed to every tab
 * (`takeChatBoxPush`), and shown with what was typed since laid over it, as the editor's text port does. Until the
 * server confirms a text, the browser keeps a copy of it, this tab's own, written on every edit (`chat-box-copies.js`),
 * so a crash or a lost request loses nothing.
 *
 * A move to another end is made at once, as the person makes it: the box's text goes with the end it was written at,
 * and the box is the new end's from then on. The answer to the request that moves them confirms the move, with the new
 * end's draft, which what was typed since is laid over; it never replaces the box. A refusal undoes the move.
 */

/**
 * @typedef {import('./chat-box-ends.js').DraftOwner} DraftOwner
 * @typedef {import('./chat-box-text.js').BoxChange} BoxChange
 * @typedef {{ avatar_url: string } | { group_id: string }} ChatOf
 * @typedef {Record<string, string | null>} MacroValues each macro's value, by its source; null when only known when sent
 * @typedef {{ owner: DraftOwner, text: string, macro_values?: MacroValues }} Draft
 * @typedef {Partial<ChatOf> & { owner: DraftOwner, text: string, changes: BoxChange[], tab: string, change?: string }} LeftDraft
 *   a draft as a request carries it to be kept
 */

/**
 * @typedef {object} ChatBoxPage
 * @property {HTMLElement} element where the box goes
 * @property {() => ChatOf | null} chat the chat open now
 * @property {() => DraftOwner} endOwner what the open chat ends on now
 * @property {(valuesOf: () => MacroValues | undefined) => import('./chat-text/surface.js').TextSetup} setup how the box's
 *   text is drawn, its macros' values as `valuesOf` has them
 * @property {() => import('./macro-values.js').MacroScope} macroScope what the open chat's macros are filled in from
 * @property {string} label
 * @property {Parameters<typeof import('./chat-text/suggest.js').slashSuggestions>[0]} slashParser
 * @property {(text: string) => boolean} slashWanted
 */

const copies = boxCopies(guardedStorage(() => globalThis.localStorage));

/** This page's own, so an edit id of an earlier page of this tab is never taken for one of its own */
const PAGE = Math.random().toString(36).slice(2);

/**
 * @typedef {object} ChatBoxMove a move of the box to another end, made when the person moves (`moveChatBox`)
 * @property {LeftDraft[] | undefined} leaving what the request that moves them carries
 * @property {(draft: Draft | undefined) => void} arrive its answer came, with the new end's draft; nothing when a later
 *   move or undo has taken its place
 * @property {() => void} undo the move was refused: the box is back where it was, with what was typed since; nothing
 *   when a later move has taken its place
 */

/**
 * @typedef {object} Here the end the box's text responds to, its draft as this page last heard it, and the values of the
 *   macros the server sent with it
 * @property {ChatOf} chat
 * @property {DraftOwner | null} owner null while only the answer to a move can name it
 * @property {string} base
 * @property {MacroValues} [values]
 * @property {Moving} [moving] the move that brought the box here, until its answer or refusal
 */

/**
 * @typedef {object} Moving
 * @property {ChatBoxMove} move
 * @property {string | undefined} since the latest edit of the text the move took away: the edits after it were made
 *   here, and are laid over the draft the answer brings
 * @property {string} carried the box's text the move took away, given back on a refusal
 * @property {Here | null} from where the box was
 */

/** @type {Here | null} */
let here = null;

/**
 * @param {string} source a macro as written
 * @returns {string | null | undefined} its value as the server sent it; undefined when it sent none
 */
const macroValue = source => (here?.values && Object.hasOwn(here.values, source) ? here.values[source] : asked?.get(source));

/** @type {AskedValues | undefined} the values of the macros typed since, which the server was asked for */
let asked;

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
    if (!here?.owner) return;
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
    if (!page || !here || here.moving || !chat || !sameChat(chat, here.chat)) return;
    const owner = known?.owner ?? page.endOwner();
    const was = here;
    if (sameOwner(owner, was.owner)) return;
    here = { chat: was.chat, owner, base: was.base, ...(known?.macro_values ? { values: known.macro_values } : {}) };
    rebase(known?.text ?? '');
    editor?.redraw();
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
    asked = new AskedValues(() => dependencies.macroScope());
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') keepLeft();
    });
    window.addEventListener('pagehide', () => keepLeft());
    await loadChatEditor();
    const { chatBoxEditor } = await import('./chat-text/chat-box-editor.js');
    editor = chatBoxEditor({
        parent: page.element,
        text,
        setup: page.setup(() => here?.values),
        macroValue,
        macroValues: asked,
        label: page.label,
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
    const sent = here?.owner ? { ...here.owner, text: taken, changes: unsaved().changes } : null;
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
    if (!here?.owner) return undefined;
    const written = text.text();
    const { base, changes } = unsaved();
    if (written === base) return undefined;
    const latest = change();
    return [{ ...here.chat, owner: here.owner, text: written, changes, tab: tab(), ...(latest ? { change: latest } : {}) }];
}

/**
 * What a request that opens a chat carries: the text it leaves, and every copy the browser kept of text the server
 * hasn't confirmed, from any tab and of any chat, so a copy whose tab is gone lasts only until a chat is opened. A copy
 * already in its draft changes nothing when merged again, so one that a tab still open is writing goes too.
 * @returns {LeftDraft[] | undefined}
 */
export function openingChatBox() {
    const own = tab();
    const live = here;
    const kept = copies.all().filter(copy => !(copy.tab === own && live && sameChat(live.chat, copy.chat) && sameOwner(live.owner, copy.owner)));
    const all = [...leavingChatBox() ?? [], ...kept.map(copy => ({ ...copy.chat, owner: copy.owner, text: copy.text, changes: copy.changes, tab: copy.tab, ...(copy.change ? { change: copy.change } : {}) }))];
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
 * over it. It holds this page's edits up to the one it names, when it came from a save of this page's. While the box
 * moves, the answer to the move brings the draft it shows.
 * @param {{ tree?: { avatar?: string, group?: string }, owner?: DraftOwner, text?: unknown, tab?: unknown, change?: unknown }} frame
 */
export function takeChatBoxPush(frame) {
    const tree = frame.tree;
    if (!tree || !frame.owner || typeof frame.text !== 'string' || !here || here.moving) return;
    const chat = /** @type {ChatOf} */ (typeof tree.group === 'string' ? { group_id: tree.group } : { avatar_url: tree.avatar });
    const greeting = here.owner !== null && 'greeting' in frame.owner && 'greeting' in here.owner;
    if (!(greeting ? sameOwner(here.owner, frame.owner) : isHere(chat, frame.owner))) return;
    const own = frame.tab === tab() && typeof frame.change === 'string' && frame.change.startsWith(`${PAGE}/`);
    here.base = frame.text;
    text.heard(frame.text, own ? /** @type {string} */ (frame.change).slice(PAGE.length + 1) : undefined);
    queueMicrotask(keepCopy);
}

/**
 * The person moves to another end, or another chat, as they make the move: the request that moves them carries the
 * box's text (`leaving`, with every copy the browser kept when it opens a chat), and the box is the new end's at once,
 * empty until the answer brings its draft. Text in the box with no end to go with (written before any chat was open,
 * or while a move whose end only its answer names is still on its way) stays, as the new end's. A copy this tab kept
 * for the new end, which no request got kept, is set apart, so the box's own copy never writes over it; the next open
 * of a chat carries it. A move to where the box is changes nothing but carries its text.
 * @param {object} to
 * @param {ChatOf | null} [to.chat] the chat moved to; the chat open now when not given
 * @param {DraftOwner | null} [to.owner] the end moved to; null when only the answer can name it (the end of a chat being
 *   opened, or of a path the page doesn't have yet); the end the open chat has now when not given
 * @param {boolean} [to.opening] the request opens a chat
 * @returns {ChatBoxMove}
 */
export function moveChatBox({ chat = page?.chat() ?? null, owner, opening = false }) {
    const leaving = opening ? openingChatBox() : leavingChatBox();
    const from = here;
    const target = owner === undefined ? page?.endOwner() ?? null : owner;
    /** @type {ChatBoxMove} */
    const move = {
        leaving,
        arrive: draft => arrived(move, draft),
        undo: () => undone(move),
    };
    if (!chat) return move;
    const stays = Boolean(from?.owner && target && sameChat(from.chat, chat) && sameOwner(from.owner, target));
    const carries = Boolean(from?.owner) && !stays;
    /** @type {Moving} */
    const moving = { move, since: carries || stays ? text.latest() : from?.moving?.since, carried: carries ? text.text() : '', from };
    if (stays && from) {
        here = { ...from, moving };
        return move;
    }
    here = { chat, owner: target, base: '', ...(!carries && from?.values ? { values: from.values } : {}), moving };
    if (target) copies.setApart(chat, target, tab());
    if (carries) text.replace('');
    editor?.redraw();
    return move;
}

/**
 * @param {ChatBoxMove} move
 * @param {Draft | undefined} draft
 */
function arrived(move, draft) {
    if (here?.moving?.move !== move) return;
    const { since, from } = here.moving;
    const owner = draft?.owner ?? here.owner ?? page?.endOwner() ?? null;
    if (!owner) return;
    if (here.owner && !sameOwner(here.owner, owner)) copies.remove(here.chat, here.owner, tab());
    if (!here.owner || !sameOwner(here.owner, owner)) copies.setApart(here.chat, owner, tab());
    const kept = from && sameChat(from.chat, here.chat) && sameOwner(from.owner, owner) ? from.values : undefined;
    const values = draft?.macro_values ? { ...kept, ...draft.macro_values } : kept;
    const base = draft?.text ?? here.base;
    here = { chat: here.chat, owner, base, ...(values ? { values } : {}) };
    if (text.text() === '') {
        writeChatBox(base);
        rebase(base);
    } else if (editor) {
        text.heard(base, since);
    } else {
        rebase(base);
    }
    editor?.redraw();
    queueMicrotask(keepCopy);
}

/**
 * @param {ChatBoxMove} move
 */
function undone(move) {
    if (here?.moving?.move !== move) return;
    const { carried, from } = here.moving;
    const restored = carried + text.text();
    if (here.owner && !(from?.owner && sameChat(from.chat, here.chat) && sameOwner(from.owner, here.owner))) copies.remove(here.chat, here.owner, tab());
    here = from;
    if (here) rebase(here.base);
    if (text.text() !== restored) writeChatBox(restored);
    editor?.redraw();
    queueMicrotask(keepCopy);
}

/**
 * The answer to a request that moved the box to `chat` came, with the end's draft: the move it made is confirmed
 * (`ChatBoxMove.arrive`). With no move on its way there, the box moves to that end now, its text kept as a copy for
 * the end it was written at.
 * @param {ChatOf} chat
 * @param {Draft | undefined} draft the end's draft, as the answer carries it
 */
export function arriveChatBox(chat, draft) {
    if (here?.moving && sameChat(here.chat, chat)) {
        here.moving.move.arrive(draft);
        return;
    }
    if (!draft) return;
    if (here && isHere(chat, draft.owner)) {
        if (draft.macro_values) takeChatBoxMacros(draft.macro_values);
        return;
    }
    moveChatBox({ chat, owner: draft.owner }).arrive(draft);
}

/**
 * A request that moved the box to `chat` was refused: the move it made is undone (`ChatBoxMove.undo`)
 * @param {ChatOf} chat
 */
export function chatBoxMoveRefused(chat) {
    if (here?.moving && sameChat(here.chat, chat)) here.moving.move.undo();
}

/**
 * @returns {string[]} the macros written in the box, for an answer that may change their values to carry them
 */
export function chatBoxMacros() {
    return [...new Set(macrosIn(text.text()))];
}

/**
 * The values of macros in the box, as an answer carries them: the box draws them
 * @param {unknown} values
 */
export function takeChatBoxMacros(values) {
    if (!here || !values || typeof values !== 'object' || Array.isArray(values)) return;
    here.values = { ...here.values, .../** @type {MacroValues} */ (values) };
    editor?.redraw();
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

/** @returns {boolean} whether the chat box has focus */
export function chatBoxFocused() {
    return editor?.view.hasFocus === true;
}

/** @returns {boolean} whether the chat box shows suggestions, which take Enter and the arrows */
export function chatBoxSuggesting() {
    return editor?.suggesting() === true;
}
