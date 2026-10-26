import { TYPE } from '../library-codes.js';
import { default_settings as ccDefaults } from '../../public/scripts/chat-completion-defaults.js';
import { textgen_connection_defaults as tcDefaults } from '../../public/scripts/textgen-connection-defaults.js';
import { draft } from './entity-draft.js';

/**
 * Connections (§1.4, step 3c): each thing the app sends requests to, a catalog entity (`TYPE.connection`, key a
 * uuid) with its `type`, `model`, `url` and the type's own options. Made from upstream's flat settings, which remember
 * one model, URL and option set per chat completion source and text completion type, and given back as them.
 *
 * - Type: `openai:<source>`, `textgenerationwebui:<type>`, `kobold`, `novel`, `horde`, `extras`.
 * - A source or type gets a connection when it's the selected one or any of its own values isn't the default, so a
 *   user's 26 sources don't become 26 connections, and switching source still finds its own.
 * - A value upstream keeps once for every source of a family (`reverse_proxy`, `bypass_status_check`, …) is each of
 *   the family's connections' own, and is given back from the family's selected one.
 * - The connection text generation uses is one slot (`textGeneration`); `main_api`, `chat_completion_source` and the
 *   text completion `type` are read from its type. The other families' selected connections are remembered
 *   (`remembered`), so switching back to a family finds the one it had.
 */

/** A chat completion key's home: its source (`*` every source's) and its field there. */
const CC_FIELDS = Object.freeze({
    openai_model: ['openai', 'model'],
    claude_model: ['claude', 'model'],
    openrouter_model: ['openrouter', 'model'],
    openrouter_use_fallback: ['openrouter', 'openrouter_use_fallback'],
    openrouter_providers: ['openrouter', 'openrouter_providers'],
    openrouter_quantizations: ['openrouter', 'openrouter_quantizations'],
    openrouter_allow_fallbacks: ['openrouter', 'openrouter_allow_fallbacks'],
    openrouter_middleout: ['openrouter', 'openrouter_middleout'],
    ai21_model: ['ai21', 'model'],
    mistralai_model: ['mistralai', 'model'],
    cohere_model: ['cohere', 'model'],
    perplexity_model: ['perplexity', 'model'],
    groq_model: ['groq', 'model'],
    chutes_model: ['chutes', 'model'],
    siliconflow_model: ['siliconflow', 'model'],
    siliconflow_endpoint: ['siliconflow', 'siliconflow_endpoint'],
    minimax_model: ['minimax', 'model'],
    minimax_endpoint: ['minimax', 'minimax_endpoint'],
    electronhub_model: ['electronhub', 'model'],
    nanogpt_model: ['nanogpt', 'model'],
    nanogpt_provider: ['nanogpt', 'nanogpt_provider'],
    nanogpt_payg_override: ['nanogpt', 'nanogpt_payg_override'],
    deepseek_model: ['deepseek', 'model'],
    aimlapi_model: ['aimlapi', 'model'],
    xai_model: ['xai', 'model'],
    pollinations_model: ['pollinations', 'model'],
    pollinations_endpoint: ['pollinations', 'pollinations_endpoint'],
    moonshot_model: ['moonshot', 'model'],
    fireworks_model: ['fireworks', 'model'],
    cometapi_model: ['cometapi', 'model'],
    custom_model: ['custom', 'model'],
    custom_url: ['custom', 'url'],
    custom_include_body: ['custom', 'custom_include_body'],
    custom_exclude_body: ['custom', 'custom_exclude_body'],
    custom_include_headers: ['custom', 'custom_include_headers'],
    google_model: ['makersuite', 'model'],
    vertexai_model: ['vertexai', 'model'],
    vertexai_auth_mode: ['vertexai', 'vertexai_auth_mode'],
    vertexai_region: ['vertexai', 'vertexai_region'],
    vertexai_express_project_id: ['vertexai', 'vertexai_express_project_id'],
    zai_model: ['zai', 'model'],
    zai_endpoint: ['zai', 'zai_endpoint'],
    workers_ai_model: ['workers_ai', 'model'],
    workers_ai_account_id: ['workers_ai', 'workers_ai_account_id'],
    azure_base_url: ['azure_openai', 'azure_base_url'],
    azure_deployment_name: ['azure_openai', 'azure_deployment_name'],
    azure_api_version: ['azure_openai', 'azure_api_version'],
    azure_openai_model: ['azure_openai', 'model'],
    reverse_proxy: ['*', 'reverse_proxy'],
    proxy_password: ['*', 'proxy_password'],
    bypass_status_check: ['*', 'bypass_status_check'],
    custom_prompt_post_processing: ['*', 'custom_prompt_post_processing'],
});

/** The chat completion connection keys that are the user's preferences, not a connection's (slots, default level user). */
export const CC_PREFERENCE_KEYS = Object.freeze(['group_models', 'sort_models', 'show_external_models']);

/** A text completion key's home, as CC_FIELDS; `server_urls` holds each type's URL. */
const TC_FIELDS = Object.freeze({
    mancer_model: ['mancer', 'model'],
    togetherai_model: ['togetherai', 'model'],
    infermaticai_model: ['infermaticai', 'model'],
    ollama_model: ['ollama', 'model'],
    openrouter_model: ['openrouter', 'model'],
    openrouter_providers: ['openrouter', 'openrouter_providers'],
    openrouter_quantizations: ['openrouter', 'openrouter_quantizations'],
    openrouter_allow_fallbacks: ['openrouter', 'openrouter_allow_fallbacks'],
    vllm_model: ['vllm', 'model'],
    aphrodite_model: ['aphrodite', 'model'],
    dreamgen_model: ['dreamgen', 'model'],
    tabby_model: ['tabby', 'model'],
    llamacpp_model: ['llamacpp', 'model'],
    custom_model: ['ooba', 'model'],
    featherless_model: ['featherless', 'model'],
    generic_model: ['generic', 'model'],
    bypass_status_check: ['*', 'bypass_status_check'],
});

/** Horde's connection values, named as `horde_settings` names them. */
const HORDE_FIELDS = Object.freeze(['models', 'auto_adjust_response_length', 'auto_adjust_context_length', 'trusted_workers_only']);

/** `main_api` by family, and back. */
const MAIN_API = Object.freeze({ openai: 'openai', textgenerationwebui: 'textgenerationwebui', kobold: 'kobold', novel: 'novel', horde: 'koboldhorde' });

/**
 * @typedef {import('./entity-draft.js').EntityDraft} EntityDraft
 * @typedef {object} UpstreamConnectionSettings The parts of upstream's settings that are connections.
 * @property {string} [main_api]
 * @property {Record<string, any>} [oai_settings]
 * @property {Record<string, any>} [textgenerationwebui_settings]
 * @property {Record<string, any>} [kai_settings]
 * @property {Record<string, any>} [nai_settings]
 * @property {Record<string, any>} [horde_settings]
 * @property {{ apiUrl?: string, apiKey?: string, autoConnect?: boolean }} [extras] `extension_settings`' Extras keys.
 * @typedef {object} ConnectionsFromUpstream
 * @property {EntityDraft[]} connections
 * @property {string | undefined} textGeneration The key of the connection text generation uses.
 * @property {Record<string, string>} remembered The other families' selected connections, by family.
 * @property {Record<string, unknown>} preferences The chat completion preference keys there were.
 * @property {string[]} sources The user's own connections: upstream's one per source and backend type (a preset's
 *   connection that isn't one of these is the preset's alone).
 * @property {{ connection: string, value: string }[]} secrets Keys to put in secrets.json, the connection then
 *   referring to their entry (`secret`).
 */

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function same(a, b) {
    return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The family's sources' values, from flat keys.
 * @param {Record<string, any>} flat
 * @param {Readonly<Record<string, readonly string[]>>} fields
 * @param {Record<string, any>} defaults
 * @returns {{ own: Map<string, Record<string, unknown>>, changed: Set<string>, shared: Record<string, unknown> }}
 */
function bySource(flat, fields, defaults) {
    const own = new Map();
    const changed = new Set();
    /** @type {Record<string, unknown>} */
    const shared = {};
    for (const [key, [source, field]] of Object.entries(fields)) {
        if (!Object.hasOwn(flat, key)) continue;
        if (source === '*') {
            shared[field] = flat[key];
            continue;
        }
        if (!own.has(source)) own.set(source, {});
        own.get(source)[field] = flat[key];
        if (!same(flat[key], defaults[key])) changed.add(source);
    }
    return { own, changed, shared };
}

/**
 * One chat completion connection per source in a flat set of upstream's chat completion keys (`oai_settings`, or
 * the connection keys of a chat completion preset) that is `selected` or has a value of its own that isn't the
 * default.
 * @param {Record<string, any>} flat
 * @param {(hint: string) => string} newKey The key of what `hint` names; the same hint, the same key.
 * @returns {{ connections: EntityDraft[], selected: string | undefined, preferences: Record<string, unknown> }}
 */
export function chatConnectionsFromUpstream(flat, newKey) {
    const source = typeof flat.chat_completion_source === 'string' ? flat.chat_completion_source : undefined;
    const { own, changed, shared } = bySource(flat, CC_FIELDS, ccDefaults);
    if (source !== undefined) changed.add(source);
    /** @type {EntityDraft[]} */
    const connections = [];
    let selected;
    for (const name of changed) {
        const key = newKey(`connection openai:${name}`);
        if (name === source) selected = key;
        connections.push(draft(TYPE.connection, key, { type: `openai:${name}`, ...shared, ...own.get(name) }));
    }
    /** @type {Record<string, unknown>} */
    const preferences = {};
    for (const key of CC_PREFERENCE_KEYS) {
        if (Object.hasOwn(flat, key)) preferences[key] = flat[key];
    }
    return { connections, selected, preferences };
}

/**
 * Upstream's settings' connections.
 * @param {UpstreamConnectionSettings} settings
 * @param {(hint: string) => string} newKey Makes the key of what `hint` names (a uuid); the same hint, the same key.
 * @returns {ConnectionsFromUpstream}
 */
export function connectionsFromUpstream(settings, newKey) {
    /** @type {EntityDraft[]} */
    const connections = [];
    /** @type {Record<string, string>} */
    const selected = {};
    /** @type {Record<string, unknown>} */
    let preferences = {};
    if (settings.oai_settings) {
        const cc = chatConnectionsFromUpstream(settings.oai_settings, newKey);
        connections.push(...cc.connections);
        if (cc.selected) selected.openai = cc.selected;
        preferences = cc.preferences;
    }
    const tc = settings.textgenerationwebui_settings;
    if (tc) {
        const type = typeof tc.type === 'string' ? tc.type : undefined;
        const { own, changed, shared } = bySource(tc, TC_FIELDS, tcDefaults);
        const urls = tc.server_urls && typeof tc.server_urls === 'object' ? tc.server_urls : {};
        for (const [name, url] of Object.entries(urls)) {
            if (!own.has(name)) own.set(name, {});
            own.get(name).url = url;
            changed.add(name);
        }
        if (type !== undefined) changed.add(type);
        for (const name of changed) {
            const key = newKey(`connection textgenerationwebui:${name}`);
            if (name === type) selected.textgenerationwebui = key;
            connections.push(draft(TYPE.connection, key, { type: `textgenerationwebui:${name}`, ...shared, ...own.get(name) }));
        }
    }
    /** @type {[string, Record<string, unknown> | undefined][]} */
    const singles = [
        ['kobold', settings.kai_settings && Object.hasOwn(settings.kai_settings, 'api_server') ? { url: settings.kai_settings.api_server } : undefined],
        ['novel', settings.nai_settings && Object.hasOwn(settings.nai_settings, 'model_novel') ? { model: settings.nai_settings.model_novel } : undefined],
        ['horde', settings.horde_settings ? Object.fromEntries(HORDE_FIELDS.filter(f => Object.hasOwn(settings.horde_settings, f)).map(f => [f, settings.horde_settings[f]])) : undefined],
        ['extras', settings.extras && (Object.hasOwn(settings.extras, 'apiUrl') || Object.hasOwn(settings.extras, 'autoConnect'))
            ? Object.fromEntries(Object.entries({ url: settings.extras.apiUrl, autoConnect: settings.extras.autoConnect }).filter(([, v]) => v !== undefined))
            : undefined],
    ];
    /** @type {{ connection: string, value: string }[]} */
    const secrets = [];
    for (const [type, values] of singles) {
        if (!values) continue;
        const key = newKey(`connection ${type}`);
        selected[type] = key;
        connections.push(draft(TYPE.connection, key, { type, ...values }));
        if (type === 'extras' && settings.extras.apiKey) secrets.push({ connection: key, value: settings.extras.apiKey });
    }
    const family = Object.entries(MAIN_API).find(([, api]) => api === settings.main_api)?.[0];
    const textGeneration = family ? selected[family] : undefined;
    const remembered = Object.fromEntries(Object.entries(selected).filter(([f]) => f !== family && (f === 'openai' || f === 'textgenerationwebui')));
    return { connections, textGeneration, remembered, preferences, secrets, sources: connections.map(c => c.key) };
}

/**
 * The family of a connection type, and its source or backend type within it.
 * @param {string} type
 * @returns {{ family: string, name: string | undefined }}
 */
export function connectionFamily(type) {
    const at = type.indexOf(':');
    return at === -1 ? { family: type, name: undefined } : { family: type.slice(0, at), name: type.slice(at + 1) };
}

/**
 * Flat keys of one family from its connections: each source's own values from the connection of its type (the
 * selected one for the selected source, else the first), the shared ones from the selected connection, and the
 * default for a source with none.
 * @param {EntityDraft[]} connections
 * @param {string} family
 * @param {Readonly<Record<string, readonly string[]>>} fields
 * @param {Record<string, any>} defaults
 * @param {EntityDraft | undefined} chosen
 */
function flatFrom(connections, family, fields, defaults, chosen) {
    /** @type {Map<string, EntityDraft>} */
    const byName = new Map();
    for (const connection of connections) {
        const { family: f, name } = connectionFamily(String(connection.values.type));
        if (f === family && name !== undefined && !byName.has(name)) byName.set(name, connection);
    }
    if (chosen) byName.set(String(connectionFamily(String(chosen.values.type)).name), chosen);
    /** @type {Record<string, unknown>} */
    const flat = {};
    for (const [key, [source, field]] of Object.entries(fields)) {
        const from = source === '*' ? chosen : byName.get(source);
        if (from && Object.hasOwn(from.values, field)) flat[key] = from.values[field];
        else if (Object.hasOwn(defaults, key)) flat[key] = structuredClone(defaults[key]);
    }
    return { flat, byName };
}

/**
 * Flat chat completion keys for a selected connection (an export of a chat completion preset re-merges these).
 * @param {EntityDraft[]} connections Every chat completion connection.
 * @param {EntityDraft | undefined} chosen
 * @param {Record<string, unknown>} [preferences]
 * @returns {Record<string, unknown>}
 */
export function chatConnectionsToUpstream(connections, chosen, preferences = {}) {
    const { flat } = flatFrom(connections, 'openai', CC_FIELDS, ccDefaults, chosen);
    if (chosen) flat.chat_completion_source = connectionFamily(String(chosen.values.type)).name;
    for (const key of CC_PREFERENCE_KEYS) {
        if (Object.hasOwn(preferences, key)) flat[key] = preferences[key];
    }
    return flat;
}

/**
 * Upstream's flat settings from the connections.
 * @param {EntityDraft[]} connections
 * @param {{ textGeneration?: string, remembered?: Record<string, string>, preferences?: Record<string, unknown>, extrasApiKey?: string }} slots
 * @returns {Required<Omit<UpstreamConnectionSettings, 'main_api'>> & { main_api: string | undefined }}
 */
export function connectionsToUpstream(connections, slots) {
    const byKey = new Map(connections.map(connection => [connection.key, connection]));
    const current = slots.textGeneration ? byKey.get(slots.textGeneration) : undefined;
    const currentFamily = current ? connectionFamily(String(current.values.type)).family : undefined;
    /** @param {string} family */
    const chosenOf = family => family === currentFamily ? current : byKey.get(slots.remembered?.[family] ?? '');
    /** @param {string} type */
    const single = type => connections.find(connection => connection.values.type === type);

    const oai_settings = chatConnectionsToUpstream(connections, chosenOf('openai'), slots.preferences);
    const tcChosen = chosenOf('textgenerationwebui');
    const { flat: textgenerationwebui_settings, byName } = flatFrom(connections, 'textgenerationwebui', TC_FIELDS, tcDefaults, tcChosen);
    textgenerationwebui_settings.server_urls = Object.fromEntries([...byName]
        .filter(([, connection]) => Object.hasOwn(connection.values, 'url'))
        .map(([name, connection]) => [name, connection.values.url]));
    if (tcChosen) textgenerationwebui_settings.type = connectionFamily(String(tcChosen.values.type)).name;

    const kobold = single('kobold');
    const novel = single('novel');
    const horde = single('horde');
    const extras = single('extras');
    return {
        main_api: currentFamily ? MAIN_API[currentFamily] : undefined,
        oai_settings,
        textgenerationwebui_settings,
        kai_settings: kobold && Object.hasOwn(kobold.values, 'url') ? { api_server: kobold.values.url } : {},
        nai_settings: novel && Object.hasOwn(novel.values, 'model') ? { model_novel: novel.values.model } : {},
        horde_settings: horde ? Object.fromEntries(HORDE_FIELDS.filter(f => Object.hasOwn(horde.values, f)).map(f => [f, horde.values[f]])) : {},
        extras: extras ? {
            ...(Object.hasOwn(extras.values, 'url') ? { apiUrl: /** @type {string} */ (extras.values.url) } : {}),
            ...(Object.hasOwn(extras.values, 'autoConnect') ? { autoConnect: /** @type {boolean} */ (extras.values.autoConnect) } : {}),
            // No key is an empty one, as the page holds it.
            apiKey: slots.extrasApiKey ?? '',
        } : {},
    };
}

/** For tests: the keys the tables cover, to hold them to the shared lists. */
export const COVERED = Object.freeze({
    chat: Object.freeze([...Object.keys(CC_FIELDS), ...CC_PREFERENCE_KEYS, 'chat_completion_source']),
    text: Object.freeze([...Object.keys(TC_FIELDS), 'server_urls']),
});
