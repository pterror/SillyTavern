import { t } from './i18n.js';
import { isStoredNodeId } from './node-identity.js';
import { newUi } from './new-ui-page.js';
import { openCharacterBook, openWorldEntry } from './world-links.js';
import { charactersStore } from './character-store.js';
import { chat } from '/scripts/chat-state.js';
import { loreMarkRanges, loreMarksOf } from './chat-text/lore-marks.js';
import { linkedEntry } from './chat-links.js';

/** @type {Map<() => void, Element>} each listener of a message's marks, and the element its text is shown in */
const listeners = new Map();

/** @type {import('/ui/entry.js').StartOptions['activations']} */
export const activationsOldPage = {
    messageNumber(nodeId) {
        const index = chat.findIndex(message => message?.node_id === nodeId);
        return index === -1 ? null : index;
    },
    openEntry(book, uid) {
        openWorldEntry(book, uid);
    },
    openCardBook(avatar) {
        const thing = charactersStore.get(avatar)?.thing;
        if (thing) openCharacterBook(thing);
    },
};

/**
 * @param {Record<string, any> | undefined} message
 * @returns {boolean}
 */
const isReply = message => !!message && !message.is_user && !message.is_system;

/** @returns {string | null} the chat's latest reply, when it is stored */
function latestReply() {
    const nodeId = chat.findLast(isReply)?.node_id;
    return typeof nodeId === 'string' && isStoredNodeId(nodeId) ? nodeId : null;
}

/** @type {import('./chat-text/lore-marks.js').LoreMarks | null} */
let marking = null;

/**
 * The marks of every reply in the chat, from the activation record each reply came with. Made once for the messages
 * drawn in one run of the page's code, as the chat can change between runs.
 * @returns {import('./chat-text/lore-marks.js').LoreMarks}
 */
function chatMarks() {
    if (!marking) {
        marking = loreMarksOf(chat.filter(message => isReply(message) && message.extra?.activations && isStoredNodeId(message.node_id)), latestReply());
        queueMicrotask(() => { marking = null; });
    }
    return marking;
}

/**
 * The lore keys matched in a message's text, marked over it. It stops hearing changes once the element the text is
 * shown in is taken off the page.
 * @param {Element} shownIn where the message's text is shown
 * @param {() => Record<string, any> | undefined} message the message the text is
 * @returns {import('@pterror/interact-editor/reader').Overlay}
 */
export function loreMarks(shownIn, message) {
    return {
        ranges(from, to, { read }) {
            const shown = message();
            const nodeId = shown?.node_id;
            if (typeof nodeId !== 'string' || !isStoredNodeId(nodeId)) return [];
            const text = read(from, to);
            if (from !== 0 || text !== shown.mes) return [];
            return loreMarkRanges(chatMarks(), nodeId, text);
        },
        watch(listener) {
            listeners.set(listener, shownIn);
            return () => listeners.delete(listener);
        },
    };
}

let queued = false;

function syncLoreMarks() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
        queued = false;
        for (const [listener, shownIn] of listeners) {
            if (shownIn.isConnected) listener();
            else listeners.delete(listener);
        }
    });
}

/**
 * @param {Record<string, any>} message
 * @param {JQuery<HTMLElement>} messageElement
 */
export function updateLoreMark(message, messageElement) {
    const record = message?.is_user ? null : message?.extra?.activations;
    const mark = messageElement.find('.mes_lore');
    const count = Array.isArray(record?.entries) ? record.entries.length : 0;
    mark.prop('hidden', !record);
    mark.find('.mes_lore_count').text(record ? String(count) : '');
    syncLoreMarks();
}

/**
 * @param {Element} mark
 * @returns {{ reply: string, entries: number[] }}
 */
const markOf = mark => ({
    reply: mark.getAttribute('data-lore-reply') ?? '',
    entries: (mark.getAttribute('data-lore') ?? '').split(' ').filter(Boolean).map(Number),
});

/**
 * The entries a marked word brought into its reply, as its reply's activation names them.
 * @param {Element} mark
 * @returns {{ book: string, entry: string }[]}
 */
function broughtUp(mark) {
    const { reply, entries } = markOf(mark);
    const record = chat.findLast(message => message?.node_id === reply)?.extra?.activations;
    if (!Array.isArray(record?.entries)) return [];
    /** @type {Map<string, { book: string, entry: string }>} */
    const found = new Map();
    for (const i of entries) {
        const ref = record.entries[i]?.ref;
        if (ref && typeof ref.book === 'string' && typeof ref.entry === 'string') found.set(`${ref.book}:${ref.entry}`, { book: ref.book, entry: ref.entry });
    }
    return [...found.values()];
}

/** Whether the page has mobile-styles.css's layout, where a word is tapped for its card rather than pointed at. */
const isPhone = () => window.matchMedia('screen and (max-width: 1000px)').matches;

/**
 * What a word in a message names, or what it brought into the marked reply.
 * @param {HTMLElement} word a name's box or a marked word
 * @returns {{ entries: { book: string, entry: string }[], reply: string | null, latest: boolean } | null}
 */
function peekOf(word) {
    const latest = latestReply();
    if (word.matches('.chat-name')) {
        const thing = word.querySelector('[data-thing]')?.getAttribute('data-thing');
        const world = thing ? linkedEntry(thing)?.world : null;
        const reply = latest !== null && chat.findLast(isReply)?.extra?.activations ? latest : null;
        return thing && world ? { entries: [{ book: world, entry: thing }], reply, latest: reply !== null } : null;
    }
    const { reply } = markOf(word);
    return { entries: broughtUp(word), reply, latest: reply === latest };
}

/**
 * Shows the card of a word: by the word while it's pointed at, or on a phone from the bottom.
 * @param {HTMLElement} word
 * @param {boolean} tapped
 */
function peekAt(word, tapped) {
    const wanted = peekOf(word);
    if (!wanted) return;
    if (tapped) newUi().worldbuilding.tap(word, wanted);
    else newUi().worldbuilding.peek(word, wanted);
}

/**
 * Opens the entry a name in a message names.
 * @param {Element} name its box
 */
function openNamed(name) {
    const thing = name.querySelector('[data-thing]')?.getAttribute('data-thing');
    const world = thing ? linkedEntry(thing)?.world : null;
    if (thing && world) newUi().worldbuilding.openEntryAt(world, thing);
}

/** @type {Map<string, import('@st/activations/protocol').PanelView>} */
const peeked = new Map();

/**
 * @param {string} reply
 * @returns {Promise<import('@st/activations/protocol').PanelView | null>}
 */
async function peek(reply) {
    const view = await newUi().activations.peek(reply);
    if (view) {
        peeked.delete(reply);
        peeked.set(reply, view);
        newUi().names.hold(`peeked:${reply}`, view.looks);
        while (peeked.size > 8) {
            const oldest = /** @type {string} */ (peeked.keys().next().value);
            peeked.delete(oldest);
            newUi().names.drop(`peeked:${oldest}`);
        }
    }
    return view;
}

/**
 * @param {Element} mark
 */
async function openMarked(mark) {
    const { reply, entries } = markOf(mark);
    if (!reply) return;
    if (entries.length !== 1) {
        newUi().activations.open(reply);
        return;
    }
    const view = peeked.get(reply) ?? await peek(reply);
    const opener = view?.entries[entries[0]]?.open;
    if (!opener) {
        newUi().activations.open(reply);
        return;
    }
    if ('card' in opener) activationsOldPage.openCardBook(opener.card);
    else activationsOldPage.openEntry(opener.book, opener.uid);
}

export function initLoreMarks() {
    /** @param {JQuery.TriggeredEvent} event */
    function onMark(event) {
        event.preventDefault();
        event.stopPropagation();
        const message = chat[Number($(event.currentTarget).closest('.mes').attr('mesid'))];
        if (!isStoredNodeId(message?.node_id)) {
            toastr.info(t`This message isn't saved yet.`);
            return;
        }
        newUi().activations.open(String(message.node_id));
    }
    $(document).on('click', '.mes_lore', onMark);
    $(document).on('keydown', '.mes_lore', function (event) {
        if (event.key === ' ' || event.key === 'Enter') onMark(event);
    });

    $(document).on('click', '.mes_text .lore-mark', function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (isPhone()) peekAt(this, true);
        else void openMarked(this);
    });
    $(document).on('keydown', '.mes_text .lore-mark', function (event) {
        if (event.key !== ' ' && event.key !== 'Enter') return;
        event.preventDefault();
        void openMarked(this);
    });

    $(document).on('click', '.mes_text .chat-name', function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (isPhone()) peekAt(this, true);
        else openNamed(this);
    });
    $(document).on('keydown', '.mes_text .chat-name', function (event) {
        if (event.key !== ' ' && event.key !== 'Enter') return;
        event.preventDefault();
        openNamed(this);
    });
    $(document).on('mouseover', '.mes_text .chat-name, .mes_text .lore-mark', function (event) {
        const inner = event.target instanceof Element ? event.target.closest('.chat-name, .lore-mark') : null;
        if (inner === this && !isPhone()) peekAt(this, false);
    });
    $(document).on('mouseout', '.mes_text .chat-name, .mes_text .lore-mark', function (event) {
        newUi().worldbuilding.unpeek(event.relatedTarget ?? null);
    });
}
