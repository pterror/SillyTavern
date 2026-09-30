/**
 * @typedef {object} TokenizerWarning
 * @property {string} kind `fallback-copy`, `estimate`, `dropped`, `trim-estimate`, `license` or `unreadable-reply`.
 * @property {string} key `api|type-or-source|url|model|tokenizer`.
 * @property {string} message Built by the server.
 * @property {string[]} [entries]
 */

const SHOWN_KEY = 'tokenizerNoticesShown';

/** Kinds shown once per browser session per `kind|key`; every other kind is shown on every call. */
const ONCE_PER_SESSION_KINDS = new Set(['fallback-copy', 'estimate']);

/**
 * @returns {string[]|null} null when storage is unavailable or its value is unparseable.
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
 * Shows the tokenizer warnings a server-built send or count reported.
 * @param {TokenizerWarning[]|unknown} warnings
 */
export function showTokenizerWarnings(warnings) {
    if (!Array.isArray(warnings)) return;

    for (const warning of warnings) {
        if (typeof warning?.message !== 'string') continue;

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
 * Marks what an on-screen count is, in two sibling spans kept next to the count element: `~` before
 * it for an estimate, and after it the local copy's name for a fallback count, or a marker for a
 * model no tokenizer is known for. Never touches the count element itself, which callers and
 * extensions read back as a number.
 * @param {Element|JQuery} countElement
 * @param {{ name?: string, basis?: string, messages?: { unknownModel?: string } }|null|undefined} tokenizer The answer the count came from.
 * @param {{ omitCopyLabel?: boolean }} [options] `omitCopyLabel`: leave the fallback copy's name out,
 * for an element that already shows that name.
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
