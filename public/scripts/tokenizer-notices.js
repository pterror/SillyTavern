/**
 * @typedef {object} TokenizerWarning
 * @property {string} kind `fallback-copy`, `estimate`, `dropped` or `trim-estimate`.
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
