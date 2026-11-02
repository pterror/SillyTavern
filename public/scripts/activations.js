import { t } from './i18n.js';
import { isStoredNodeId } from './node-identity.js';
import { newUi } from './new-ui-page.js';
import { openEmbeddedLoreEditor, openWorldInfoEntry } from './world-info.js';
import { chat } from '/scripts/chat-state.js';
import { power_user } from './power-user.js';
import { getStringHash } from './hash-utils.js';
import { renderMarked } from './lore-mark-render.js';
import { addTooltipProvider } from './macro-tooltip.js';

/** @type {string | null} */
let panelReply = null;

/** @type {Map<string, string>} */
const drawn = new Map();

/** @typedef {{ rerender: (messageId: number) => void, editing: () => number | undefined, save: (key: string) => void }} LoreMarksPage */

/** @type {LoreMarksPage | null} */
let page = null;

/** @type {import('/ui/entry.js').StartOptions['activations']} */
export const activationsOldPage = {
    messageNumber(nodeId) {
        const index = chat.findIndex(message => message?.node_id === nodeId);
        return index === -1 ? null : index;
    },
    openEntry(book, uid) {
        void openWorldInfoEntry(book, uid);
    },
    openCardBook(avatar) {
        void openEmbeddedLoreEditor(avatar);
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
 * @param {Record<string, any> | null} reply
 * @param {string} nodeId
 * @param {string} text
 * @returns {import('./lore-mark-render.js').MarkSpan[]}
 */
function spansFor(reply, nodeId, text) {
    const entries = reply?.extra?.activations?.entries;
    if (!Array.isArray(entries)) return [];
    /** @type {Map<string, import('./lore-mark-render.js').MarkSpan>} */
    const spans = new Map();
    let hash = null;
    entries.forEach((entry, index) => {
        for (const key of Array.isArray(entry?.keys) ? entry.keys : []) {
            for (const source of Array.isArray(key?.in) ? key.in : []) {
                if (source?.node !== nodeId || !Array.isArray(source.spans)) continue;
                hash ??= getStringHash(text);
                if (source.of !== hash) continue;
                for (const [from, to] of source.spans) {
                    const at = `${from}:${to}`;
                    const span = spans.get(at) ?? { from, to, entries: [] };
                    if (!span.entries.includes(index)) span.entries.push(index);
                    spans.set(at, span);
                }
            }
        }
    });
    return [...spans.values()].sort((a, b) => a.from - b.from || a.to - b.to);
}

/**
 * @param {Record<string, any> | null} reply
 * @param {string} nodeId
 * @param {import('./lore-mark-render.js').MarkSpan[]} spans
 */
const drawKey = (reply, nodeId, spans) => (spans.length ? `${reply?.node_id}|${nodeId}|${JSON.stringify(spans)}` : '');

/**
 * @param {Record<string, any>} message
 * @param {string} text what is being shown
 * @param {(text: string) => string} render
 * @returns {string}
 */
export function chatMessageHtml(message, text, render) {
    const nodeId = message?.node_id;
    if (typeof nodeId !== 'string' || !isStoredNodeId(nodeId)) return render(text);
    const reply = text === message.mes ? markingReply() : null;
    const spans = reply ? spansFor(reply, nodeId, text) : [];
    const { html, drawn: count } = spans.length
        ? renderMarked(text, spans, render, document, { 'data-lore-reply': String(reply?.node_id), tabindex: '0' })
        : { html: render(text), drawn: 0 };
    const key = count ? drawKey(reply, nodeId, spans) : '';
    if (key) drawn.set(nodeId, key); else drawn.delete(nodeId);
    return html;
}

let queued = false;

export function syncLoreMarks() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
        queued = false;
        redraw();
    });
}

function redraw() {
    document.body.classList.toggle('lore-marks-hover', power_user.lore_marks === 'hover');
    if (!page) return;
    const reply = markingReply();
    /** @type {Set<string>} */
    const nodes = new Set(drawn.keys());
    for (const entry of Array.isArray(reply?.extra?.activations?.entries) ? reply.extra.activations.entries : []) {
        for (const key of Array.isArray(entry?.keys) ? entry.keys : []) {
            for (const source of Array.isArray(key?.in) ? key.in : []) {
                if (typeof source?.node === 'string') nodes.add(source.node);
            }
        }
    }
    const editing = page.editing();
    for (const nodeId of nodes) {
        const index = chat.findLastIndex(message => message?.node_id === nodeId);
        if (index === -1) {
            drawn.delete(nodeId);
            continue;
        }
        if (editing !== undefined && Number(editing) === index) continue;
        const message = chat[index];
        const shown = message.extra?.display_text || message.mes;
        const want = shown === message.mes ? drawKey(reply, nodeId, spansFor(reply, nodeId, message.mes)) : '';
        if ((drawn.get(nodeId) ?? '') !== want) page.rerender(index);
    }
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
        title.textContent = entry.title;
        const book = document.createElement('span');
        book.className = 'lore-tip-book';
        book.textContent = entry.book;
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
        while (peeked.size > 8) peeked.delete(/** @type {string} */ (peeked.keys().next().value));
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
 * @param {LoreMarksPage} deps
 */
export function initLoreMarks(deps) {
    page = deps;
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
