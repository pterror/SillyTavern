import { localforage } from '../lib.js';
import { newUi } from './new-ui-page.js';

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
