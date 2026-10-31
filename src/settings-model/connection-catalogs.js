import { TYPE } from '../library-codes.js';
import { buildConnectApiMap } from '../../public/scripts/connect-api-map.js';
import { chat_completion_sources } from '../../public/scripts/chat-completion-defaults.js';
import { textgen_types } from '../../public/scripts/textgen-connection-defaults.js';
import { draft, without } from './entity-draft.js';
import { templateKey } from './templates.js';

const API_NAMES = Object.entries(buildConnectApiMap(textgen_types, chat_completion_sources));

const FAMILY_OF_SELECTED = Object.freeze({ openai: 'openai', textgenerationwebui: 'textgenerationwebui', kobold: 'kobold', novel: 'novel', koboldhorde: 'horde' });

/**
 * @param {string} api
 * @returns {string | undefined}
 */
export function connectionTypeOfApi(api) {
    const entry = API_NAMES.find(([name]) => name === api)?.[1];
    if (!entry) return undefined;
    const family = FAMILY_OF_SELECTED[entry.selected];
    const name = entry.source ?? entry.type;
    return name ? `${family}:${name}` : family;
}

/**
 * @param {string} type
 */
export function apiOfConnectionType(type) {
    return API_NAMES.find(([name]) => connectionTypeOfApi(name) === type)?.[0];
}

/** @typedef {import('./entity-draft.js').EntityDraft} EntityDraft */

/**
 * @param {string} key
 * @param {Set<string>} seen
 * @param {string} what
 * @param {string[]} warnings
 */
function uniqueKey(key, seen, what, warnings) {
    let unique = key;
    for (let n = 2; seen.has(unique); n++) unique = `${key} #${n}`;
    if (unique !== key) warnings.push(`${what} ${JSON.stringify(key)} is repeated; kept as ${JSON.stringify(unique)}`);
    seen.add(unique);
    return unique;
}

/**
 * @param {Record<string, any>[]} proxies
 * @param {Record<string, any> | undefined} selected
 * @returns {{ proxies: EntityDraft[], selected: string | undefined, warnings: string[] }}
 */
export function proxiesFromUpstream(proxies, selected) {
    /** @type {string[]} */
    const warnings = [];
    const seen = new Set();
    const drafts = (Array.isArray(proxies) ? proxies : []).map(proxy => draft(
        TYPE.proxy, uniqueKey(String(proxy?.name ?? ''), seen, 'proxy', warnings), without(proxy ?? {}, ['name']),
    ));
    let selectedKey;
    if (selected && typeof selected === 'object') {
        const same = drafts.find(proxy => proxy.key === selected.name && JSON.stringify(proxy.values) === JSON.stringify(without(selected, ['name'])));
        if (same) {
            selectedKey = same.key;
        } else {
            selectedKey = uniqueKey(String(selected.name ?? ''), seen, 'proxy', warnings);
            warnings.push(`the selected proxy ${JSON.stringify(selected.name)} isn't one of the saved ones; kept as ${JSON.stringify(selectedKey)}`);
            drafts.push(draft(TYPE.proxy, selectedKey, without(selected, ['name'])));
        }
    }
    return { proxies: drafts, selected: selectedKey, warnings };
}

/**
 * @param {EntityDraft[]} proxies
 * @param {string | undefined} selected
 * @returns {{ proxies: Record<string, unknown>[], selected_proxy: Record<string, unknown> | undefined }}
 */
export function proxiesToUpstream(proxies, selected) {
    const entries = proxies.map(proxy => ({ name: proxy.key, ...proxy.values }));
    return { proxies: entries, selected_proxy: entries.find(entry => entry.name === selected) };
}

/**
 * @param {Record<string, any>[]} servers
 * @returns {{ servers: EntityDraft[], warnings: string[] }}
 */
export function serverHistoryFromUpstream(servers) {
    /** @type {string[]} */
    const warnings = [];
    const seen = new Set();
    const drafts = (Array.isArray(servers) ? servers : []).map((server) => {
        const keyed = typeof server?.label === 'string' && typeof server?.url === 'string' && !/\s/.test(server.url);
        const key = uniqueKey(keyed ? `${server.label} ${server.url}` : JSON.stringify(server), seen, 'server history entry', warnings);
        return draft(TYPE.serverHistory, key, keyed && key === `${server.label} ${server.url}` ? without(server, ['label', 'url']) : { ...server });
    });
    return { servers: drafts, warnings };
}

/**
 * @param {EntityDraft[]} servers
 * @returns {Record<string, unknown>[]}
 */
export function serverHistoryToUpstream(servers) {
    return servers.map((server) => {
        if (Object.hasOwn(server.values, 'url')) return { ...server.values };
        const at = server.key.lastIndexOf(' ');
        return { label: server.key.slice(0, at), url: server.key.slice(at + 1), ...server.values };
    });
}

const PROFILE_TEMPLATES = Object.freeze({ instruct: 'instruct', context: 'context', sysprompt: 'sysprompt', 'reasoning-template': 'reasoning' });

const PROFILE_PRESET_FAMILY = Object.freeze({ cc: 'openai', tc: 'textgenerationwebui' });

/**
 * @param {Record<string, any>} profile
 * @param {(type: string) => string | undefined} connectionOf
 * @param {Set<string>} seen
 * @param {string[]} warnings
 * @returns {EntityDraft}
 */
export function profileFromUpstream(profile, connectionOf, seen, warnings) {
    const key = uniqueKey(String(profile.id ?? ''), seen, 'connection profile', warnings);
    /** @type {Record<string, unknown>} */
    const values = without(profile, ['id', 'exclude']);
    if (key !== profile.id) values.id = profile.id;
    const family = PROFILE_PRESET_FAMILY[profile.mode];
    if (typeof profile.preset === 'string' && family) values.preset = `${family}:${profile.preset}`;
    for (const [field, kind] of Object.entries(PROFILE_TEMPLATES)) {
        if (typeof profile[field] === 'string') values[field] = templateKey(kind, profile[field]);
    }
    if (typeof profile.api === 'string') {
        const type = connectionTypeOfApi(profile.api);
        const connection = type ? connectionOf(type) : undefined;
        if (connection && apiOfConnectionType(type) === profile.api) {
            delete values.api;
            values.connection = connection;
        }
    }
    return draft(TYPE.connectionProfile, key, values, Array.isArray(profile.exclude) ? { 0: [...profile.exclude] } : undefined);
}

/**
 * @param {EntityDraft} profile
 * @param {(key: string) => EntityDraft | undefined} connection
 * @returns {Record<string, unknown>}
 */
export function profileToUpstream(profile, connection) {
    /** @type {Record<string, any>} */
    const out = { id: profile.key, ...without(profile.values, ['connection']) };
    if (typeof profile.values.connection === 'string') {
        const type = connection(profile.values.connection)?.values.type;
        if (typeof type === 'string') out.api = apiOfConnectionType(type);
    }
    const family = PROFILE_PRESET_FAMILY[out.mode];
    if (typeof out.preset === 'string' && family) out.preset = out.preset.slice(family.length + 1);
    for (const [field, kind] of Object.entries(PROFILE_TEMPLATES)) {
        if (typeof out[field] === 'string') out[field] = out[field].slice(kind.length + 1);
    }
    if (profile.lists?.[0]) out.exclude = [...profile.lists[0]];
    return out;
}

/**
 * @param {{ profiles?: Record<string, any>[], selectedProfile?: string | null }} connectionManager
 * @param {(type: string) => string | undefined} connectionOf
 * @returns {{ profiles: EntityDraft[], selected: string | null | undefined, warnings: string[] }}
 */
export function profilesFromUpstream(connectionManager, connectionOf) {
    /** @type {string[]} */
    const warnings = [];
    const seen = new Set();
    const profiles = (Array.isArray(connectionManager?.profiles) ? connectionManager.profiles : [])
        .map(profile => profileFromUpstream(profile ?? {}, connectionOf, seen, warnings));
    return { profiles, selected: connectionManager?.selectedProfile, warnings };
}
