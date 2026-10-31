import { localforage } from '../lib.js';
import { newUi, newUiStarted } from './new-ui-page.js';

/**
 * @param {string} [tcApiType]
 * @returns {{ manual: boolean, shown: readonly string[] }}
 */
const select = tcApiType => (newUiStarted() ? newUi().settings.samplers(tcApiType || undefined) : { manual: false, shown: [] });

export async function initCustomSelectedSamplers() { }

/**
 * The new page shows the panel's samplers as the server's select says, redrawn as it changes.
 * @param {boolean} [_redraw]
 */
export async function validateDisabledSamplers(_redraw = false) { }

export async function loadApiSelectedSamplers() { }

export async function saveApiSelectedSamplers() { }

/**
 * @param {string} [tcApiType]
 * @param {boolean} [silent]
 */
export async function resetApiSelectedSamplers(tcApiType = '', silent = false) {
    const reset = await newUi().settings.resetSamplers(tcApiType || undefined);
    if (reset && !silent) toastr.success('Selected samplers cleared.');
}

/**
 * @param {string} samplerName
 * @param {string|boolean} state
 * @param {string} [tcApiType]
 */
export function setApiSamplersState(samplerName, state, tcApiType = '') {
    const backend = tcApiType || undefined;
    const shown = select(backend).shown.filter(name => name !== samplerName);
    void newUi().settings.setSamplers({ backend, shown: String(state) === 'true' ? [...shown, samplerName] : shown });
}

/**
 * @param {string} [tcApiType]
 * @returns {Record<string, boolean>}
 */
export function getAllManualApiSamplers(tcApiType = '') {
    const { manual, shown } = select(tcApiType);
    return { ...Object.fromEntries(shown.map(name => [name, true])), st_manual_priority: manual };
}

/**
 * @param {string} [tcApiType]
 * @returns {string[]}
 */
export function getActiveManualApiSamplers(tcApiType = '') {
    return [...select(tcApiType).shown];
}

/**
 * @param {string|boolean} [state]
 * @param {string} [tcApiType]
 */
export function toggleSamplerManualPriority(state = false, tcApiType = '') {
    void newUi().settings.setSamplers({ backend: tcApiType || undefined, manual: String(state) === 'true' });
}

/** @param {string} [tcApiType] */
export function isSamplerManualPriorityEnabled(tcApiType = '') {
    return select(tcApiType).manual;
}

export async function importBrowserSamplerSelect() {
    const store = localforage.createInstance({ name: 'SillyTavern_TextCompletions' });
    const stored = await store.getItem('selectedSamplers');
    if (!stored || typeof stored !== 'object') return;
    /** @type {Record<string, { manual: boolean, shown: string[] }>} */
    const byBackend = {};
    for (const [backend, samplers] of Object.entries(stored)) {
        if (!samplers || typeof samplers !== 'object') continue;
        byBackend[backend] = {
            manual: samplers.st_manual_priority === true,
            shown: Object.entries(samplers).filter(([name, on]) => on === true && name !== 'st_manual_priority').map(([name]) => name),
        };
    }
    if (await newUi().settings.importSamplers(byBackend)) await store.removeItem('selectedSamplers');
}
