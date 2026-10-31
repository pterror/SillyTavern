import { TYPE } from '../library-codes.js';
import { CONNECTION_PRESET_KEYS } from '../../public/scripts/chat-completion-defaults.js';
import { draft, keyedPart, only, partRecord, without } from './entity-draft.js';

export const PRESET_APIS = Object.freeze(['openai', 'textgenerationwebui', 'novel', 'kobold']);

const SCALAR_LISTS = Object.freeze({
    openai: [],
    textgenerationwebui: ['sampler_order', 'samplers', 'sampler_priority', 'samplers_priorities'],
    novel: ['order'],
    kobold: ['sampler_order'],
});

export const PRESET_PART_LISTS = Object.freeze({ bias: 4, prompts: 5, orders: 6 });
const { bias: BIAS, prompts: PROMPTS, orders: ORDERS } = PRESET_PART_LISTS;

export const CONNECTION_REF = 'connection';

/**
 * @typedef {import('./entity-draft.js').EntityDraft} EntityDraft
 * @typedef {{ preset: EntityDraft, connection: Record<string, unknown> | null, warnings: string[] }} PresetFromUpstream
 */

/**
 * @param {unknown[]} entries
 * @param {string} holder
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
 * @param {string} api
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
 * @param {EntityDraft} preset
 * @param {Record<string, unknown> | null} [connection]
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
