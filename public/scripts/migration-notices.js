import { getRequestHeaders } from './request-headers.js';

// t and escapeHtml are passed in by script.js: i18n.js and utils.js both lead back to script.js, which imports this
// module, so importing them here would add import cycles.

/** How many characters one notice names; the rest are counted. */
const NAMED_LIMIT = 20;

/**
 * @typedef {object} MigrationNoticeHelpers
 * @property {(strings: TemplateStringsArray, ...values: any[]) => string} t i18n.js's t
 * @property {(value: string) => string} escapeHtml utils.js's escapeHtml
 */

/**
 * Shows each boot-migration notice the server holds for this user; each stays until the user dismisses it, which
 * tells the server it was seen.
 * @param {MigrationNoticeHelpers} helpers
 */
export async function showMigrationNotices(helpers) {
    let notices;
    try {
        const response = await fetch('/api/migrations/notices', { method: 'POST', headers: getRequestHeaders() });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        ({ notices } = await response.json());
    } catch (error) {
        console.error('Could not load migration notices', error);
        return;
    }
    for (const notice of Array.isArray(notices) ? notices : []) {
        if (notice?.id === 'unimport-embedded-lore') {
            showUnimportEmbeddedLoreNotice(helpers, notice);
        }
    }
}

/**
 * Shows the embedded-lorebook migration's notice as a warning that stays until dismissed.
 * @param {MigrationNoticeHelpers} helpers
 * @param {any} notice The notice as the server lists it.
 */
function showUnimportEmbeddedLoreNotice(helpers, notice) {
    const { t, escapeHtml } = helpers;
    const failing = notice.failing ?? { total: 0, entries: [] };
    const skipped = notice.skipped ?? { total: 0, entries: [] };
    const parts = [];
    let shown = 0;
    if (failing.total > 0) {
        const names = failing.entries.slice(0, NAMED_LIMIT).map(entry => escapeHtml(String(entry.name ?? entry.avatar)));
        shown += names.length;
        const rest = Math.max(failing.total - names.length, 0);
        parts.push(t`${failing.total} character(s) couldn't be updated. This is retried on the next server start:`
            + (names.length > 0 ? `<br />${names.join(', ')}` : '')
            + (rest > 0 ? `<br />${t`and ${rest} more.`}` : ''));
    }
    if (skipped.total > 0) {
        const lines = skipped.entries.slice(0, Math.max(NAMED_LIMIT - shown, 0)).map(entry => `${escapeHtml(String(entry.name ?? entry.avatar))}: ${reasonText(helpers, entry)}`);
        shown += lines.length;
        const rest = Math.max(skipped.total - lines.length, 0);
        parts.push(t`${skipped.total} character(s) couldn't be checked, so they were left exactly as they were:`
            + (lines.length > 0 ? `<br />${lines.join('<br />')}` : '')
            + (rest > 0 ? `<br />${t`and ${rest} more.`}` : ''));
    }
    const noWorld = notice.noWorld ?? { total: 0, entries: [] };
    if (noWorld.total > 0) {
        parts.push(t`${noWorld.total} character(s) link a lorebook that isn't in your worlds folder, so there was nothing to undo for them. They weren't changed.`);
    }
    if (parts.length === 0) return;
    const reportLink = notice.hasReport
        ? `<br /><br /><a href="/api/migrations/report/${encodeURIComponent(String(notice.id))}" download>${t`Download the full list`}</a>`
        : '';
    const message = t`This undoes an old import that turned characters' embedded lorebooks into separate lorebook files. Nothing was lost.`
        + '<br /><br />' + parts.join('<br /><br />') + reportLink;
    let acknowledged = false;
    const acknowledge = () => {
        if (acknowledged) return;
        acknowledged = true;
        markSeen(notice);
    };
    toastr.warning(message, t`Embedded lorebook migration`, { timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false, onclick: acknowledge, onCloseClick: acknowledge });
}

/**
 * Why a skipped character couldn't be checked, as HTML.
 * @param {MigrationNoticeHelpers} helpers
 * @param {{ world: string, reason: string }} entry
 * @returns {string}
 */
function reasonText({ t, escapeHtml }, entry) {
    const world = escapeHtml(String(entry.world));
    switch (entry.reason) {
        case 'world-missing':
            return t`its lorebook ${world} doesn't exist`;
        case 'world-unreadable':
            return t`its lorebook ${world} couldn't be read`;
        case 'world-snapshot-unusable':
            return t`its lorebook ${world} was imported from an embedded lorebook, but its saved copy of the original is unusable`;
        case 'card-unreadable':
            return t`its card couldn't be read`;
        default:
            return escapeHtml(String(entry.reason));
    }
}

/**
 * Tells the server the user has seen this version of the notice.
 * @param {{ id: string, version: number }} notice
 */
async function markSeen(notice) {
    try {
        const response = await fetch('/api/migrations/notices/seen', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ id: notice.id, version: notice.version }) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
        console.error('Could not mark the migration notice as seen', error);
    }
}
