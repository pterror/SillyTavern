import { t } from './i18n.js';
import { isStoredNodeId } from './node-identity.js';
import { attachActions, newUi } from './new-ui-page.js';
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
    openEntryAt(book, entry) {
        newUi().worldbuilding.openEntryAt(book, entry);
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
    return { entries: [], reply, latest: reply === latest };
}

/**
 * Shows the card of a word: by the word while it's pointed at, or on a phone from the bottom.
 * @param {HTMLElement} word
 * @param {boolean} tapped
 */
async function peekAt(word, tapped) {
    const wanted = peekOf(word);
    if (!wanted) return;
    const request = ++peekRequest;
    if (wanted.reply && !word.matches('.chat-name')) {
        const view = await peek(wanted.reply);
        if (request !== peekRequest || !word.isConnected) return;
        wanted.entries = targetsOf(word, view);
    }
    if (tapped) newUi().worldbuilding.tap(word, wanted);
    else newUi().worldbuilding.peek(word, wanted);
}

let peekRequest = 0;

/**
 * Opens the entry a name in a message names.
 * @param {Element} name its box
 */
function openNamed(name) {
    const thing = name.querySelector('[data-thing]')?.getAttribute('data-thing');
    const world = thing ? linkedEntry(thing)?.world : null;
    if (thing && world) newUi().worldbuilding.openEntryAt(world, thing);
}

/**
 * @param {Element} mark
 * @param {import('@st/activations/protocol').PanelView | null} view
 * @returns {{ book: string, entry: string }[]}
 */
function targetsOf(mark, view) {
    const { reply, entries } = markOf(mark);
    if (view?.message !== reply) return [];
    const targets = new Map();
    for (const index of entries) {
        const target = view.entries[index]?.open;
        if (target) targets.set(`${target.book}:${target.entry}`, target);
    }
    return [...targets.values()];
}

/**
 * @param {string} reply
 * @returns {Promise<import('@st/activations/protocol').PanelView | null>}
 */
async function peek(reply) {
    const view = await newUi().activations.peek(reply);
    if (view) newUi().names.hold('activation-peek', view.looks);
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
    const targets = targetsOf(mark, await peek(reply));
    if (targets.length === 1) {
        const target = targets[0];
        activationsOldPage.openEntryAt(target.book, target.entry);
    } else newUi().activations.open(reply);
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

    $(document).on('click', '.mes_text .lore-mark', function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (isPhone()) peekAt(this, true);
        else void openMarked(this);
    });

    $(document).on('click', '.mes_text .chat-name', function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (isPhone()) peekAt(this, true);
        else openNamed(this);
    });
    const focusedMark = () => document.activeElement?.closest('.mes_text .lore-mark') ?? null;
    const focusedName = () => document.activeElement?.closest('.mes_text .chat-name') ?? null;
    attachActions(document.getElementById('chat'), {
        when: () => focusedMark() !== null || focusedName() !== null,
        activate: () => {
            const mark = focusedMark();
            if (mark) void openMarked(mark);
            else openNamed(focusedName());
        },
    });
    $(document).on('mouseover', '.mes_text .chat-name, .mes_text .lore-mark', function (event) {
        const inner = event.target instanceof Element ? event.target.closest('.chat-name, .lore-mark') : null;
        if (inner === this && !isPhone()) peekAt(this, false);
    });
    $(document).on('mouseout', '.mes_text .chat-name, .mes_text .lore-mark', function (event) {
        peekRequest++;
        newUi().worldbuilding.unpeek(event.relatedTarget ?? null);
    });
}
