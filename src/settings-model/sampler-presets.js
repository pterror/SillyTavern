import { TYPE } from '../library-codes.js';
import { CONNECTION_PRESET_KEYS } from '../../public/scripts/chat-completion-defaults.js';
import { draft, keyedPart, only, partRecord, without } from './entity-draft.js';

/**
 * Sampler presets, their chat completion prompts and prompt orders, and logit bias lists, as the settings model holds
 * them (§1.3, step 3a), made from upstream's preset files and given back as them.
 *
 * - A preset is a bundle (`TYPE.samplerPreset`, key `<api>:<name>`), one value per key of its file, named as the file
 *   names them.
 * - A list of scalars (`sampler_order`, `samplers`, …) is one of its lists, each item the value as JSON text, so a
 *   number stays a number.
 * - Its logit bias entries (text completion, NovelAI) are parts (`TYPE.biasEntry`, key `<preset key>:<entry id>`).
 *   A part's id is its key's (entity-draft.js keyedPart), not kept again among its values.
 * - A chat completion preset's prompts are parts (`TYPE.chatPrompt`, key `<preset key>:<identifier>`) in list 5, and
 *   its prompt orders parts (`TYPE.chatPromptOrder`, key `<preset key>:<character id>`) in list 6, each order's list 0
 *   its identifiers in order and list 1 those turned off.
 * - The keys of a chat completion file that are its connection's (`CONNECTION_PRESET_KEYS`) aren't the preset's: the
 *   preset refers to a connection holding them, and they go back into the file on the way out.
 * - `extensions` and any key that isn't modeled are kept as they came.
 */

/** The API families a sampler preset is for. */
export const PRESET_APIS = Object.freeze(['openai', 'textgenerationwebui', 'novel', 'kobold']);

/** Each family's keys that are lists of scalars, by list number. */
const SCALAR_LISTS = Object.freeze({
    openai: [],
    textgenerationwebui: ['sampler_order', 'samplers', 'sampler_priority', 'samplers_priorities'],
    novel: ['order'],
    kobold: ['sampler_order'],
});

/**
 * The lists of a preset holding parts, numbered after every family's scalar lists (0-3) so a list number means one
 * thing for every sampler preset (the store reads a list's items as parts by its number); an entity has lists 0-7.
 */
export const PRESET_PART_LISTS = Object.freeze({ bias: 4, prompts: 5, orders: 6 });
const { bias: BIAS, prompts: PROMPTS, orders: ORDERS } = PRESET_PART_LISTS;

/** The value of a preset that refers to its connection (a ref). */
export const CONNECTION_REF = 'connection';

/**
 * @typedef {import('./entity-draft.js').EntityDraft} EntityDraft
 * @typedef {{ preset: EntityDraft, connection: Record<string, unknown> | null, warnings: string[] }} PresetFromUpstream
 */

/**
 * @param {unknown[]} entries Logit bias entries, `{ id, text, value }`.
 * @param {string} holder The key of what holds them.
 * @param {string[]} warnings
 */
function biasParts(entries, holder, warnings) {
    const seen = new Set();
    return entries.map((entry, index) => keyedPart(TYPE.biasEntry, holder, /** @type {any} */ (entry), { idField: 'id', index, seen, warnings, what: 'logit bias entry' }));
}

/**
 * @param {EntityDraft[]} parts
 * @param {string} holder
 * @returns {Record<string, unknown>[]}
 */
function biasEntries(parts, holder) {
    return parts.map(part => partRecord(part, holder, 'id'));
}

/**
 * A sampler preset made from its upstream file.
 * @param {string} api One of PRESET_APIS.
 * @param {string} name
 * @param {Record<string, any>} file
 * @returns {PresetFromUpstream}
 */
export function presetFromUpstream(api, name, file) {
    if (!PRESET_APIS.includes(api)) throw new Error(`no sampler preset family ${api}`);
    const key = `${api}:${name}`;
    /** @type {string[]} */
    const warnings = [];
    const scalarLists = SCALAR_LISTS[api];
    const isChat = api === 'openai';
    const connectionKeys = isChat ? CONNECTION_PRESET_KEYS : [];
    // The keys held elsewhere than the preset's values; one that isn't the shape modeled stays a value.
    const taken = new Set(connectionKeys);
    /** @type {Record<number, (string | EntityDraft)[]>} */
    const lists = {};
    scalarLists.forEach((listKey, list) => {
        if (!Array.isArray(file[listKey])) return;
        taken.add(listKey);
        lists[list] = file[listKey].map(value => JSON.stringify(value));
    });
    for (const listKey of isChat ? ['prompts', 'prompt_order'] : ['logit_bias']) {
        if (Array.isArray(file[listKey])) taken.add(listKey);
    }
    const values = without(file, taken);
    if (isChat) {
        if (Array.isArray(file.prompts)) {
            const seen = new Set();
            lists[PROMPTS] = file.prompts.map((prompt, index) => keyedPart(TYPE.chatPrompt, key, prompt, { idField: 'identifier', index, seen, warnings, what: 'prompt' }));
        }
        if (Array.isArray(file.prompt_order)) {
            lists[ORDERS] = file.prompt_order.map(order => draft(
                TYPE.chatPromptOrder, `${key}:${order.character_id}`,
                { character_id: order.character_id, ...without(order, ['character_id', 'order']) },
                {
                    0: (order.order ?? []).map(entry => entry.identifier),
                    1: (order.order ?? []).filter(entry => entry.enabled === false).map(entry => entry.identifier),
                },
            ));
        }
    } else if (Array.isArray(file.logit_bias)) {
        lists[BIAS] = biasParts(file.logit_bias, key, warnings);
    }
    const connectionValues = only(file, connectionKeys);
    return {
        preset: draft(TYPE.samplerPreset, key, values, lists),
        connection: Object.keys(connectionValues).length ? connectionValues : null,
        warnings,
    };
}

/**
 * A sampler preset's upstream file.
 * @param {EntityDraft} preset
 * @param {Record<string, unknown> | null} [connection] The values of the connection it refers to (chat completion).
 * @returns {Record<string, unknown>}
 */
export function presetToUpstream(preset, connection = null) {
    const api = preset.key.slice(0, preset.key.indexOf(':'));
    const isChat = api === 'openai';
    /** @type {Record<string, unknown>} */
    const file = { ...without(preset.values, [CONNECTION_REF]), ...(connection ?? {}) };
    SCALAR_LISTS[api].forEach((listKey, list) => {
        const items = preset.lists?.[list];
        if (items) file[listKey] = items.map(item => JSON.parse(/** @type {string} */ (item)));
    });
    if (isChat) {
        const prompts = preset.lists?.[PROMPTS];
        if (prompts) file.prompts = prompts.map(part => partRecord(/** @type {EntityDraft} */ (part), preset.key, 'identifier'));
        const orders = preset.lists?.[ORDERS];
        if (orders) {
            file.prompt_order = orders.map((part) => {
                const order = /** @type {EntityDraft} */ (part);
                const off = new Set(order.lists?.[1] ?? []);
                return {
                    ...order.values,
                    order: (order.lists?.[0] ?? []).map(identifier => ({ identifier, enabled: !off.has(identifier) })),
                };
            });
        }
    } else if (preset.lists?.[BIAS]) {
        file.logit_bias = biasEntries(/** @type {EntityDraft[]} */ (preset.lists[BIAS]), preset.key);
    }
    return file;
}

/**
 * A chat completion logit bias list (`oai_settings.bias_presets[name]`): a catalog entity (`TYPE.biasList`, key its
 * name), its entries parts in list 0.
 * @param {string} name
 * @param {Record<string, any>[]} entries
 * @returns {{ list: EntityDraft, warnings: string[] }}
 */
export function biasListFromUpstream(name, entries) {
    /** @type {string[]} */
    const warnings = [];
    const parts = biasParts(Array.isArray(entries) ? entries : [], name, warnings);
    return { list: draft(TYPE.biasList, name, {}, parts.length ? { 0: parts } : undefined), warnings };
}

/**
 * @param {EntityDraft} list
 * @returns {Record<string, unknown>[]}
 */
export function biasListToUpstream(list) {
    return biasEntries(/** @type {EntityDraft[]} */ (list.lists?.[0] ?? []), list.key);
}
