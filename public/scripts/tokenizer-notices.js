import { getRequestHeaders } from './request-headers.js';

/**
 * @typedef {object} TokenizerWarning
 * @property {string} kind
 * @property {string} key
 * @property {string} message
 * @property {string[]} [entries]
 * @property {string} [generation_id]
 */

export const REPLY_NOT_SAVED_EVENT = 'st:reply-not-saved';
export const REPLY_STORED_EVENT = 'st:reply-stored';

/**
 * @param {TokenizerWarning} warning
 */
function showReplyNotSaved(warning) {
    const generationId = warning.generation_id;
    window.dispatchEvent(new CustomEvent(REPLY_NOT_SAVED_EVENT, { detail: { generationId } }));
    const toast = toastr.error(warning.message, 'Reply not saved', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, closeButton: true });
    const text = $('<div></div>').text(warning.message);
    const button = $('<button type="button" class="menu_button"></button>').text('Save it again');
    toast.find('.toast-message').empty().append(text, button);
    button.on('click', async () => {
        button.prop('disabled', true);
        try {
            const response = await fetch(`/api/generation/store/${encodeURIComponent(String(generationId))}`, {
                method: 'POST',
                headers: getRequestHeaders(),
            });
            const result = response.ok || response.status === 404 ? await response.json().catch(() => null) : null;
            if (result?.state === 'saved') {
                window.dispatchEvent(new CustomEvent(REPLY_STORED_EVENT, { detail: { generationId, node_id: result.node_id, mes: result.mes, extra: result.extra } }));
                toastr.clear(toast, { force: true });
                toastr.success('The reply is saved now.');
                return;
            }
            if (response.status === 404) {
                text.text('This reply can no longer be saved: the server no longer has it. Copy its text if you want to keep it.');
                button.remove();
                return;
            }
            text.text(`Saving it again didn't work${result?.reason ? ` (${result.reason})` : ''}. It's still shown, but it will be gone after a reload.`);
        } catch {
            text.text('Saving it again didn\'t work: the server couldn\'t be reached. It\'s still shown, but it will be gone after a reload.');
        }
        button.prop('disabled', false);
    });
}

const SHOWN_KEY = 'tokenizerNoticesShown';

const ONCE_PER_SESSION_KINDS = new Set(['fallback-copy', 'estimate']);

/**
 * @returns {string[]|null}
 */
function readShown() {
    try {
        const raw = sessionStorage.getItem(SHOWN_KEY);
        if (raw === null) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * @param {string[]} shown
 */
function writeShown(shown) {
    try {
        sessionStorage.setItem(SHOWN_KEY, JSON.stringify(shown));
    } catch {
        // Not deduped then.
    }
}

/**
 * @param {TokenizerWarning[]|unknown} warnings
 */
export function showTokenizerWarnings(warnings) {
    if (!Array.isArray(warnings)) return;

    for (const warning of warnings) {
        if (typeof warning?.message !== 'string') continue;

        if (warning.kind === 'reply-not-saved' && typeof warning.generation_id === 'string') {
            showReplyNotSaved(warning);
            continue;
        }

        if (ONCE_PER_SESSION_KINDS.has(warning.kind)) {
            const id = `${warning.kind}|${warning.key}`;
            const shown = readShown();
            if (shown) {
                if (shown.includes(id)) continue;
                shown.push(id);
                writeShown(shown);
            }
        }

        toastr.warning(warning.message);
    }
}

/**
 * @param {Element|JQuery} countElement
 * @param {{ name?: string, basis?: string, messages?: { unknownModel?: string } }|null|undefined} tokenizer
 * @param {{ omitCopyLabel?: boolean }} [options]
 */
export function renderCountBasis(countElement, tokenizer, { omitCopyLabel = false } = {}) {
    const count = $(countElement);

    let approx = count.prev('span.token_count_approx');
    if (approx.length === 0) {
        approx = $('<span class="token_count_approx"></span>');
        count.before(approx);
    }
    let basis = count.next('span.token_count_basis');
    if (basis.length === 0) {
        basis = $('<span class="token_count_basis"></span>');
        count.after(basis);
    }

    const estimated = tokenizer?.basis === 'unknown' || tokenizer?.basis === 'failed';
    approx.text(estimated ? '~' : '');
    basis.empty();
    if (tokenizer?.basis === 'fallback' && !omitCopyLabel) {
        basis.text(`(${tokenizer.name})`);
    } else if (estimated) {
        const marker = $('<i class="fa-solid fa-circle-question"></i>');
        const title = tokenizer.messages?.unknownModel;
        if (typeof title === 'string') {
            marker.attr('title', title);
        }
        basis.append(marker);
    }
}
