import { t } from './i18n.js';
import { isStoredNodeId } from './node-identity.js';
import { newUi } from './new-ui-page.js';
import { openCharacterBook, openWorldEntry } from './world-links.js';
import { charactersStore } from './character-store.js';
import { chat } from '/scripts/chat-state.js';
import { power_user } from './power-user.js';
import { loreMarkRanges } from './chat-text/lore-marks.js';
import { addTooltipProvider } from './macro-tooltip.js';

/** @type {string | null} */
let panelReply = null;

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
    panelShown(message) {
        panelReply = message;
        syncLoreMarks();
    },
};

/**
 * @returns {Record<string, any> | null}
 */
function markingReply() {
    if (power_user.lore_marks === 'off') return null;
    if (panelReply !== null) {
        const shown = chat.findLast(message => message?.node_id === panelReply);
        if (shown?.extra?.activations) return shown;
    }
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (!message || message.is_user || message.is_system) continue;
        return message.extra?.activations ? message : null;
    }
    return null;
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
            return loreMarkRanges(markingReply(), nodeId, text);
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
        document.body.classList.toggle('lore-marks-hover', power_user.lore_marks === 'hover');
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
 * @param {Element} el
 * @param {() => void} refresh
 * @returns {Node[]}
 */
function loreTooltip(el, refresh) {
    const { reply, entries } = markOf(el);
    const held = peeked.get(reply);
    if (!held) {
        void peek(reply).then(refresh);
        const wait = document.createElement('div');
        wait.textContent = t`Loading…`;
        return [wait];
    }
    return entries.flatMap(i => {
        const entry = held.entries[i];
        if (!entry) return [];
        const box = document.createElement('div');
        box.className = 'lore-tip';
        const head = document.createElement('div');
        const title = document.createElement('strong');
        title.append(labelled(entry.label));
        const book = document.createElement('span');
        book.className = 'lore-tip-book';
        book.append(labelled(entry.world));
        head.append(title, ' ', book);
        box.append(head);
        if (entry.start) {
            const start = document.createElement('div');
            start.className = 'lore-tip-start';
            start.textContent = entry.start;
            box.append(start);
        }
        return [box];
    });
}

/**
 * @param {import('@st/activations/protocol').Label} label
 * @returns {Node}
 */
const labelled = label => (label.thing === null ? document.createTextNode(label.text) : newUi().names.element(label));

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

/**
 * @param {{ save: (key: string) => void }} deps
 */
export function initLoreMarks(deps) {
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
        void openMarked(this);
    });
    $(document).on('keydown', '.mes_text .lore-mark', function (event) {
        if (event.key !== ' ' && event.key !== 'Enter') return;
        event.preventDefault();
        void openMarked(this);
    });
    addTooltipProvider('.mes_text .lore-mark', loreTooltip);

    $('#lore_marks').on('input', function () {
        power_user.lore_marks = String($(this).val());
        deps.save('power_user.lore_marks');
        syncLoreMarks();
    });
}
