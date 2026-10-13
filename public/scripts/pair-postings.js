import { getRequestHeaders } from './request-headers.js';

/** How often the option is read again while its build or delete runs. */
const PENDING_POLL_MS = 5000;

let pollTimer = null;

/**
 * Shows the option as the server has it: on or off, and "building…" while its index is built or deleted.
 * @param {{ on: boolean, pending: boolean }} state
 */
function show(state) {
    $('#pair_postings').prop('checked', state.on);
    $('#pair_postings_pending').toggleClass('displayNone', !state.pending);
    clearTimeout(pollTimer);
    pollTimer = state.pending ? setTimeout(() => void readState(), PENDING_POLL_MS) : null;
}

async function readState() {
    try {
        const response = await fetch('/api/search/pair-postings/state', { method: 'POST', headers: getRequestHeaders() });
        if (response.ok) show(await response.json());
    } catch (error) {
        console.error('Could not read the quoted phrases option:', error);
    }
}

/**
 * The search option "Faster quoted phrases (uses more disk)": an index of adjacent word pairs, which the server
 * builds (or deletes) over the existing text in the background when it changes.
 * @param {(strings: TemplateStringsArray, ...values: any[]) => string} t i18n's tagged template, the caller's (this module
 *   stays a leaf).
 */
export function initPairPostings(t) {
    $('#pair_postings').on('change', async function () {
        const on = $(this).prop('checked') === true;
        try {
            const response = await fetch('/api/search/pair-postings', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ on }) });
            if (!response.ok) throw new Error(`/api/search/pair-postings responded ${response.status}`);
            show(await response.json());
        } catch (error) {
            console.error('Could not change the quoted phrases option:', error);
            toastr.error(t`Could not change the option. Check your connection and try again.`);
            await readState();
        }
    });
    void readState();
}
