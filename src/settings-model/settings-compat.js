import { TYPE } from '../library-codes.js';
import { canonicalStringify } from '../../public/scripts/hash-utils.js';
import { settingsToUpdate } from '../../public/scripts/chat-completion-defaults.js';
import { CONTEXT_TEMPLATE_POWER_USER_KEYS, PRESET_EXCLUDED_KEYS, TEXT_PRESET_LENGTH_KEYS, presetLengthKeys } from '../../public/scripts/preset-file-keys.js';
import { THEME_FIELDS } from '../../public/scripts/theme-fields.js';
import { resolveField } from '../settings-cascade.js';
import { biasListFromUpstream, biasListToUpstream } from './sampler-presets.js';
import { bindingFromUpstream, bindingToUpstream, templateKey } from './templates.js';
import { CC_PREFERENCE_KEYS, COVERED, connectionsFromUpstream, connectionsToUpstream } from './connections.js';
import { capabilitiesFromUpstream, capabilitiesToUpstream } from './capabilities.js';
import { profileToUpstream, profilesFromUpstream, proxiesFromUpstream, proxiesToUpstream, serverHistoryFromUpstream, serverHistoryToUpstream } from './connection-catalogs.js';
import { personasFromUpstream, personasToUpstream } from './personas.js';
import { regexPresetsFromUpstream, regexPresetsToUpstream, regexScriptsFromUpstream, regexScriptsToUpstream } from './regex.js';
import { dataBankFromUpstream, dataBankToUpstream, globalVariablesFromUpstream, globalVariablesToUpstream } from './user-data.js';
import { setListFromUpstream, setListToUpstream } from './quick-replies.js';

/**
 * The compat edge (the settings model §2): upstream's settings file made into the model's statements and entities
 * (`importUpstream`), and the model laid out in upstream's shape again (`assemble`). Compiled from the lists the page
 * itself uses (settingsToUpdate, PRESET_EXCLUDED_KEYS, THEME_FIELDS, …), so a key the page adds lands where its list
 * says.
 *
 * Every upstream path is one of:
 * - a **bundle field** (a sampler preset's, a template's, the theme's): the user level states the selected bundle, and
 *   an override only where the live value isn't the bundle's (an unsaved edit). Field ids are `<group>/<field>`,
 *   the field as the bundle's file names it;
 * - a **selection** (`preset_settings_openai`, `.preset`, `theme`, …): the bundle statement;
 * - a **connection** or **catalog** entry, through its module;
 * - a **preference**, an override at its upstream path (`power_user.auto_swipe`), its value as it came;
 * - an **extension's settings** not modeled: `ext:<key>`, as it came;
 * - **derived** (from the persona, the model, the session) or the **device's**: not stored;
 * - **dead** (nothing reads it): dropped, warned;
 * - anything else **unknown**: `key:<path>`, as it came, warned.
 */

/** The sampler preset families, their live objects and the key naming the selected preset. */
const FAMILIES = Object.freeze({
    openai: { object: 'oai_settings', selected: 'preset_settings_openai' },
    textgenerationwebui: { object: 'textgenerationwebui_settings', selected: 'preset' },
    novel: { object: 'nai_settings', selected: 'preset_settings_novel' },
    kobold: { object: 'kai_settings', selected: 'preset_settings' },
});

/** The template kinds, and the key of `power_user[kind]` naming the selected template. */
const TEMPLATE_SELECTED = Object.freeze({ instruct: 'preset', context: 'preset', sysprompt: 'name', reasoning: 'name' });

/** KoboldAI's "no preset": its own settings. */
const KOBOLD_NO_PRESET = 'gui';

/** A chat completion preset key → its `oai_settings` key, for the preset's own (not connection) keys. */
const CC_PRESET_KEYS = Object.freeze(Object.fromEntries(Object.entries(settingsToUpdate)
    .filter(([, [, , , isConnection]]) => !isConnection)
    .map(([presetKey, [, settingKey]]) => [presetKey, settingKey])));

/**
 * An override stating the app's default (the page's own value) for a field, over a bundle that holds the field:
 * assembled as nothing at its path, so the page's default applies.
 */
export const APP_DEFAULT = Object.freeze({ $default: true });

/**
 * @param {unknown} value
 */
export function isAppDefault(value) {
    return Boolean(value) && typeof value === 'object' && /** @type {any} */ (value).$default === true && Object.keys(/** @type {object} */ (value)).length === 1;
}

/** Paths nothing reads: dropped on import, warned. */
export const DEAD_PATHS = Object.freeze([
    'selected_button', 'extension_settings.note.wiAddition', 'extension_settings.quickReply',
    'power_user.auto_sort_tags', 'power_user.charGalleryView', 'power_user.guidance_scale', 'power_user.import_card_tags',
    'power_user.negative_prompt', 'power_user.stscript.autocomplete_style', 'power_user.world_import_dialog',
    'power_user.instruct.derived', 'power_user.instruct.separator_sequence', 'power_user.instruct.system_prompt',
    'power_user.reasoning.preset', 'power_user.sysprompt.preset', 'textgenerationwebui_settings.stopping_strings',
    // movingUI is gone from this fork (626f824b0).
    'power_user.movingUI', 'power_user.movingUIState', 'power_user.movingUIPreset',
]);

/** Paths derived from something else (the persona, the model, the session) or the device's own: not stored. */
export const DERIVED_PATHS = Object.freeze([
    'accountStorage', 'background.url', 'power_user.chat_template_hash',
    'power_user.context_size_derived', 'power_user.persona_description', 'power_user.persona_description_depth',
    'power_user.persona_description_lorebook', 'power_user.persona_description_position', 'power_user.persona_description_role',
    'world_info_settings.charLore', 'world_info_settings.world_info.charLore',
]);

/** Top-level keys other stores own (the tag store): handed over as they came. */
const ELSEWHERE = Object.freeze(['tags', 'tag_map']);

/** Top-level keys that are preferences as a whole (their values as they came). */
const TOP_PREFERENCES = Object.freeze(['firstRun', 'currentVersion', 'swipes', 'active_character', 'active_group']);

/**
 * @typedef {import('./entity-draft.js').EntityDraft} EntityDraft
 * @typedef {(group: string, name: string) => Record<string, any> | undefined} BundleFiles A bundle's upstream file
 *   by its group (`preset.<family>`, `template.<kind>`, `theme`) and name.
 * @typedef {object} UserModel What an upstream settings file is in the model.
 * @property {{ level: 'user', bundles: Record<string, string>, overrides: Record<string, unknown> }} user
 * @property {EntityDraft[]} entities Its catalogs' entries (connections, proxies, profiles, personas, …).
 * @property {Record<string, unknown>} ext `extension_settings` keys no module models, as they came.
 * @property {Record<string, unknown>} unknown Paths not modeled, as they came.
 * @property {Record<string, unknown>} elsewhere Keys other stores own.
 * @property {Record<string, any>} statements The statements the catalog modules made (connections' slots,
 *   capabilities, personas' character-level lists, …).
 * @property {{ connection: string, value: string }[]} secrets
 * @property {string[]} warnings
 * @property {string[]} [kept] As read from the store: the characters and groups not in the library whose statements
 *   are kept as they came (already warned of).
 */

/**
 * @param {Record<string, any>} object
 * @param {string} path Dotted.
 */
function at(object, path) {
    return path.split('.').reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), object);
}

/**
 * @param {Record<string, any>} object
 * @param {string} path
 * @param {unknown} value
 */
function put(object, path, value) {
    const keys = path.split('.');
    let target = object;
    for (const key of keys.slice(0, -1)) {
        if (!target[key] || typeof target[key] !== 'object') target[key] = {};
        target = target[key];
    }
    target[keys[keys.length - 1]] = value;
}

/**
 * @param {Record<string, any>} object
 * @param {string} path
 */
function drop(object, path) {
    const keys = path.split('.');
    const parent = at(object, keys.slice(0, -1).join('.')) ?? (keys.length === 1 ? object : undefined);
    if (parent && typeof parent === 'object' && Object.hasOwn(parent, keys[keys.length - 1])) {
        delete parent[keys[keys.length - 1]];
        return true;
    }
    return false;
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function same(a, b) {
    return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Each bundle group's fields in a settings object: `[group, field, path]`, the field as the bundle's file names it
 * and the path of its live value. A group's selection path is listed apart.
 * @param {Record<string, any>} settings
 * @returns {{ fields: [string, string, string][], selections: [string, string, string][] }}
 */
function bundleLayout(settings) {
    /** @type {[string, string, string][]} */
    const fields = [];
    /** @type {[string, string, string][]} selections `[group, path, family or kind]` */
    const selections = [];
    for (const [family, { object, selected }] of Object.entries(FAMILIES)) {
        const group = `preset.${family}`;
        selections.push([group, `${object}.${selected}`, family]);
        if (family === 'openai') {
            for (const [presetKey, settingKey] of Object.entries(CC_PRESET_KEYS)) fields.push([group, presetKey, `${object}.${settingKey}`]);
            continue;
        }
        for (const key of Object.keys(settings[object] ?? {})) {
            if (!PRESET_EXCLUDED_KEYS.includes(key)) fields.push([group, key, `${object}.${key}`]);
        }
    }
    for (const kind of Object.keys(TEMPLATE_SELECTED)) {
        const group = `template.${kind}`;
        selections.push([group, `power_user.${kind}.${TEMPLATE_SELECTED[kind]}`, kind]);
        for (const key of Object.keys(settings.power_user?.[kind] ?? {})) {
            if (!PRESET_EXCLUDED_KEYS.includes(key) && key !== 'name') fields.push([group, key, `power_user.${kind}.${key}`]);
        }
        if (kind === 'context') {
            for (const key of CONTEXT_TEMPLATE_POWER_USER_KEYS) fields.push([group, key, `power_user.${key}`]);
        }
    }
    selections.push(['theme', 'power_user.theme', 'theme']);
    for (const key of THEME_FIELDS) fields.push(['theme', key, `power_user.${key}`]);
    return { fields, selections };
}

/**
 * The bundle a group's selection names, as a key of its catalog.
 * @param {string} group
 * @param {string} name
 */
export function bundleRef(group, name) {
    if (group.startsWith('preset.')) return `${group.slice('preset.'.length)}:${name}`;
    if (group.startsWith('template.')) return templateKey(group.slice('template.'.length), name);
    return name;
}

/**
 * @param {string} group
 * @param {string} ref
 */
function bundleName(group, ref) {
    return group === 'theme' ? ref : ref.slice(ref.indexOf(':') + 1);
}

/**
 * The bundle's fields by field id, a text preset's lengths as the settings they are.
 * @param {BundleFiles} files
 * @param {string} group
 * @param {string} ref
 * @returns {Record<string, unknown> | undefined}
 */
function bundleFields(files, group, ref) {
    const file = files(group, bundleName(group, ref));
    if (!file) return undefined;
    /** @type {Record<string, unknown>} */
    const fields = {};
    const lengths = presetLengthKeys(group, file);
    for (const [key, value] of Object.entries(file)) {
        const length = group.startsWith('preset.') && group !== 'preset.openai' ? lengths[key] : undefined;
        fields[length ?? `${group}/${key}`] = value;
    }
    return fields;
}

/**
 * The text family whose preset carries `amount_gen` and `max_context`: the selected API's, when it's a text API.
 * @param {unknown} mainApi
 */
function lengthFamily(mainApi) {
    if (mainApi === 'koboldhorde') return 'kobold';
    return mainApi === 'textgenerationwebui' || mainApi === 'novel' || mainApi === 'kobold' ? mainApi : undefined;
}

/**
 * Upstream's settings file in the model.
 * @param {Record<string, any>} upstream
 * @param {{ bundles: BundleFiles, newKey: (hint: string) => string }} options
 * @returns {UserModel}
 */
export function importUpstream(upstream, { bundles, newKey }) {
    const settings = structuredClone(upstream);
    /** @type {string[]} */
    const warnings = [];
    /** @type {UserModel['user']} */
    const user = { level: 'user', bundles: {}, overrides: {} };
    /** @type {EntityDraft[]} */
    const entities = [];
    /** @type {Record<string, any>} */
    const statements = {};

    for (const path of DEAD_PATHS) {
        if (at(settings, path) !== undefined && drop(settings, path)) warnings.push(`${path} is no longer read; dropped`);
    }
    for (const path of DERIVED_PATHS) drop(settings, path);

    // Bundles: the selection, then an override per field whose live value isn't the bundle's.
    const { fields, selections } = bundleLayout(settings);
    for (const [group, path] of selections) {
        const name = at(settings, path);
        drop(settings, path);
        // KoboldAI's own settings are a choice of no preset: kept as stated (absent, the page reads a fallback).
        if (group === 'preset.kobold' && name === KOBOLD_NO_PRESET) {
            user.overrides[path] = name;
            continue;
        }
        if (typeof name !== 'string') continue;
        user.bundles[group] = bundleRef(group, name);
        if (!bundles(group, name)) warnings.push(`${path} names ${JSON.stringify(name)}, which isn't there; kept by name`);
    }
    /** @type {Set<string>} */
    const seen = new Set();
    for (const [group, field, path] of fields) {
        const value = at(settings, path);
        if (value === undefined) continue;
        seen.add(`${group}/${field}`);
        drop(settings, path);
        const ref = user.bundles[group];
        const held = ref !== undefined ? bundleFields(bundles, group, ref) : undefined;
        if (!held || !same(held[`${group}/${field}`], value)) user.overrides[`${group}/${field}`] = value;
    }
    // A field the settings lack is the page's default, not the selected bundle's (upstream applies a bundle's values
    // only when it's selected): stated as the app's default, over the bundle.
    for (const [group, ref] of Object.entries(user.bundles)) {
        for (const id of Object.keys(bundleFields(bundles, group, ref) ?? {})) {
            if (!id.includes('/') || id === `${group}/name` || seen.has(id)) continue;
            user.overrides[id] = APP_DEFAULT;
        }
    }
    const family = lengthFamily(settings.main_api);
    const ref = family ? user.bundles[`preset.${family}`] : undefined;
    const held = ref !== undefined ? bundles(`preset.${family}`, bundleName(`preset.${family}`, ref)) : undefined;
    for (const [key, setting] of Object.entries(presetLengthKeys(`preset.${family}`, held))) {
        if (!Object.hasOwn(settings, setting)) {
            if (held && Object.hasOwn(held, key)) user.overrides[setting] = APP_DEFAULT;
            continue;
        }
        if (!held || !same(held[key], settings[setting])) user.overrides[setting] = settings[setting];
        delete settings[setting];
    }

    // Connections and capabilities.
    const ext = settings.extension_settings ?? {};
    const fromConnections = connectionsFromUpstream({
        main_api: settings.main_api,
        oai_settings: settings.oai_settings,
        textgenerationwebui_settings: settings.textgenerationwebui_settings,
        kai_settings: settings.kai_settings,
        nai_settings: settings.nai_settings,
        horde_settings: settings.horde_settings,
        extras: { apiUrl: ext.apiUrl, apiKey: ext.apiKey, autoConnect: ext.autoConnect },
    }, newKey);
    entities.push(...fromConnections.connections);
    statements.textGeneration = fromConnections.textGeneration;
    statements.remembered = fromConnections.remembered;
    // The connection keys go; the chat completion preference keys among them stay, preferences like any other.
    for (const key of COVERED.chat.filter(k => !CC_PREFERENCE_KEYS.includes(k))) drop(settings, `oai_settings.${key}`);
    for (const key of [...COVERED.text, 'type']) drop(settings, `textgenerationwebui_settings.${key}`);
    drop(settings, 'kai_settings.api_server');
    drop(settings, 'nai_settings.model_novel');
    delete settings.horde_settings;
    delete settings.main_api;
    for (const key of ['apiUrl', 'apiKey', 'autoConnect']) delete ext[key];
    const fromCapabilities = capabilitiesFromUpstream(ext, entities, newKey);
    entities.push(...fromCapabilities.connections);
    statements.capabilities = fromCapabilities.capabilities;
    statements.sources = [...fromConnections.sources, ...fromCapabilities.connections.map(c => c.key)];
    Object.assign(ext, fromCapabilities.settings);
    statements.secrets = fromConnections.secrets;

    // Catalogs.
    const proxies = proxiesFromUpstream(settings.proxies, settings.selected_proxy);
    entities.push(...proxies.proxies);
    statements.proxy = proxies.selected;
    warnings.push(...proxies.warnings);
    delete settings.proxies;
    delete settings.selected_proxy;

    const servers = serverHistoryFromUpstream(at(settings, 'power_user.servers'));
    entities.push(...servers.servers);
    // Arrays upstream keeps in an order of their own, kept: a catalog reads in key order.
    statements.order = { serverHistory: servers.servers.map(e => e.key) };
    warnings.push(...servers.warnings);
    drop(settings, 'power_user.servers');

    const bindings = at(settings, 'power_user.model_templates_mappings');
    if (bindings && typeof bindings === 'object') {
        entities.push(...Object.entries(bindings).map(([model, binding]) => bindingFromUpstream(model, binding)));
        drop(settings, 'power_user.model_templates_mappings');
    }

    if (ext.connectionManager) {
        const connectionOf = (/** @type {string} */ type) => entities.find(e => e.values.type === type)?.key;
        const profiles = profilesFromUpstream(ext.connectionManager, connectionOf);
        entities.push(...profiles.profiles);
        statements.order.connectionProfile = profiles.profiles.map(e => e.key);
        statements.profile = profiles.selected;
        warnings.push(...profiles.warnings);
        delete ext.connectionManager;
    }

    const personas = personasFromUpstream({
        personas: at(settings, 'power_user.personas'),
        persona_descriptions: at(settings, 'power_user.persona_descriptions'),
        persona_data: at(settings, 'power_user.persona_data'),
        default_persona: at(settings, 'power_user.default_persona'),
        user_avatar: settings.user_avatar,
        username: settings.username,
    });
    entities.push(...personas.personas);
    statements.persona = personas.userPersona;
    statements.currentPersona = personas.currentPersona;
    statements.personasConnected = personas.connected;
    if (personas.username !== undefined) statements.username = personas.username;
    warnings.push(...personas.warnings);
    for (const path of ['power_user.personas', 'power_user.persona_descriptions', 'power_user.persona_data', 'power_user.default_persona', 'user_avatar', 'username']) drop(settings, path);

    if (Array.isArray(ext.regex)) {
        const scripts = regexScriptsFromUpstream(ext.regex, { newKey });
        entities.push(...scripts.scripts);
        statements.regexScripts = scripts.scripts.map(s => s.key);
        warnings.push(...scripts.warnings);
        delete ext.regex;
    }
    if (Array.isArray(ext.regex_presets)) {
        const presets = regexPresetsFromUpstream(ext.regex_presets, newKey);
        entities.push(...presets.presets);
        statements.regexPreset = presets.selected;
        statements.regexPresets = presets.presets.map(p => p.key);
        warnings.push(...presets.warnings);
        delete ext.regex_presets;
    }
    if (ext.variables && typeof ext.variables === 'object') {
        const variables = globalVariablesFromUpstream(ext.variables.global);
        entities.push(...variables);
        const rest = { ...ext.variables };
        delete rest.global;
        if (Object.keys(rest).length) user.overrides['ext:variables'] = rest;
        delete ext.variables;
    }
    if (ext.attachments || ext.character_attachments || ext.disabled_attachments) {
        const bank = dataBankFromUpstream(ext);
        entities.push(...bank.files);
        statements.dataBank = { user: bank.user, characters: bank.characters, disabledElsewhere: bank.disabledElsewhere };
        warnings.push(...bank.warnings);
        for (const key of ['attachments', 'character_attachments', 'disabled_attachments']) delete ext[key];
    }
    if (ext.quickReplyV2 && typeof ext.quickReplyV2 === 'object') {
        const { config, characterConfigs, ...options } = ext.quickReplyV2;
        statements.quickReplies = {
            user: setListFromUpstream(config),
            characters: Object.entries(characterConfigs ?? {}).map(([avatar, c]) => ({ avatar, ...setListFromUpstream(c) })),
        };
        for (const [key, value] of Object.entries(options)) user.overrides[`extension_settings.quickReplyV2.${key}`] = value;
        delete ext.quickReplyV2;
    }
    const biasPresets = at(settings, 'oai_settings.bias_presets');
    if (biasPresets && typeof biasPresets === 'object') {
        for (const [name, list] of Object.entries(biasPresets)) {
            const bias = biasListFromUpstream(name, /** @type {any} */ (list));
            entities.push(bias.list);
            warnings.push(...bias.warnings);
        }
        drop(settings, 'oai_settings.bias_presets');
    }

    // What's left: preferences at their paths, extensions' own settings, keys other stores own, and the unknown.
    /** @type {Record<string, unknown>} */
    const extOut = {};
    for (const [key, value] of Object.entries(ext)) extOut[key] = value;
    delete settings.extension_settings;
    /** @type {Record<string, unknown>} */
    const elsewhere = {};
    for (const key of ELSEWHERE) {
        if (Object.hasOwn(settings, key)) {
            elsewhere[key] = settings[key];
            delete settings[key];
        }
    }
    /** @type {Record<string, unknown>} */
    const unknown = {};
    for (const [key, value] of Object.entries(settings)) {
        if (TOP_PREFERENCES.includes(key)) {
            user.overrides[key] = value;
        } else if (value && typeof value === 'object' && !Array.isArray(value) && ['power_user', 'oai_settings', 'textgenerationwebui_settings', 'nai_settings', 'kai_settings', 'world_info_settings', 'background'].includes(key)) {
            for (const [inner, innerValue] of Object.entries(value)) {
                // A template object's leftovers are its own unknown keys; any other object's are preferences.
                if (key === 'power_user' && Object.hasOwn(TEMPLATE_SELECTED, inner) && innerValue && typeof innerValue === 'object') {
                    for (const [k, v] of Object.entries(innerValue)) user.overrides[`power_user.${inner}.${k}`] = v;
                    continue;
                }
                user.overrides[`${key}.${inner}`] = innerValue;
            }
        } else {
            unknown[key] = value;
            warnings.push(`${key} isn't a setting this app knows; kept as it came`);
        }
    }
    return { user, entities, ext: extOut, unknown, elsewhere, statements, secrets: statements.secrets, warnings };
}

/**
 * The user's own connections (`statements.sources`); every connection when the model doesn't say.
 * @param {UserModel} model
 */
export function userConnections(model) {
    const sources = model.statements.sources ? new Set(model.statements.sources) : null;
    return model.entities.filter(e => e.type === TYPE.connection && (!sources || sources.has(e.key)));
}

/**
 * The statements one level makes of the bundle groups (a character's or group's, §1.1).
 * @typedef {{ level: 'character', name?: 'character' | 'group' | 'chat', bundles?: Record<string, string>, overrides?: Record<string, unknown> }} ContextLevel
 *   `name`: which of the closer levels it is, for where a value comes from (`sources`).
 */

/**
 * The model laid out as upstream's settings file, for a context: the levels closer than the user's (a speaking
 * character's, then its group's), the user's, the app's default.
 * @param {UserModel} model
 * @param {{ bundles: BundleFiles, extrasApiKey?: string, levels?: ContextLevel[] }} options `bundles` holds every
 *   bundle a level states.
 * @returns {{ settings: Record<string, any>, warnings: string[], sources: Record<string, string> }} `sources`: the
 *   level each bundle field's and selection's value comes from, by path ('preset' for the user's bundle's, 'user'
 *   for the user's own, a closer level's name).
 */
export function assemble(model, { bundles, extrasApiKey, levels: closer = [] }) {
    /** @type {string[]} */
    const warnings = [];
    /** @type {Record<string, any>} */
    const settings = {};
    const { user, entities, statements } = model;
    const byType = (/** @type {number} */ type) => entities.filter(e => e.type === type);

    // Connections first: the bundles and preferences then lay over the objects they fill. The user's own; a preset's
    // connection of its own isn't the user's choice for its source.
    const connections = userConnections(model);
    const flat = connectionsToUpstream(connections, { textGeneration: statements.textGeneration, remembered: statements.remembered, extrasApiKey });
    const mainApi = flat.main_api;
    settings.main_api = flat.main_api;
    for (const object of ['oai_settings', 'textgenerationwebui_settings', 'kai_settings', 'nai_settings', 'horde_settings']) settings[object] = flat[object];
    settings.extension_settings = { ...flat.extras };

    // Bundles through the cascade: the context's closer levels, the user's, then the default.
    const { fields, selections } = bundleLayout({});
    const family = lengthFamily(mainApi);
    /** @type {import('../settings-cascade.js').Catalog} */
    const catalog = {
        groupOf: field => (field.includes('/') ? field.slice(0, field.indexOf('/')) : Object.values(TEXT_PRESET_LENGTH_KEYS).includes(field) && family ? `preset.${family}` : null),
        // The theme is the reader's (a chat or character doesn't change it); the rest is generation's.
        kindOf: field => (field.startsWith('theme/') ? 'reader' : 'generation'),
        bundle: (ref, group) => bundleFields(bundles, group, ref),
        profile: () => undefined,
    };
    const levels = [...closer, user, { level: 'default' }];
    const stating = [...closer, user];
    /** The bundle a group resolves to: the closest level's that may state it. */
    const statedFor = (/** @type {string} */ group) => stating
        .filter(l => group !== 'theme' || l === user)
        .map(l => l.bundles?.[group])
        .find(ref => ref !== undefined);
    /** @type {Record<string, string>} */
    const sources = {};
    /** @param {import('../settings-cascade.js').Resolution} r */
    const sourceOf = (r) => {
        const level = levels[r.index];
        if (level === user) return r.from === 'bundle' ? 'preset' : 'user';
        return /** @type {ContextLevel} */ (level).name ?? 'character';
    };
    /**
     * @param {string} id
     * @param {string} [path] Where the value goes, to note its source.
     */
    const resolved = (id, path) => {
        const r = resolveField(levels, id, catalog);
        if (path && r.from !== 'none' && !isAppDefault(r.value)) sources[path] = sourceOf(r);
        return r.value;
    };
    const layoutPaths = new Map(fields.map(([group, field, path]) => [`${group}/${field}`, path]));
    // A bundle's fields the settings object didn't list (the page's own keys of a text family are the file's).
    for (const [group, ref] of stating.flatMap(l => Object.entries(l.bundles ?? {}))) {
        for (const id of Object.keys(bundleFields(bundles, group, ref) ?? {})) {
            if (layoutPaths.has(id) || !id.includes('/')) continue;
            const field = id.slice(id.indexOf('/') + 1);
            if (field === 'name') continue;
            const family = group.slice('preset.'.length);
            if (group.startsWith('preset.') && family !== 'openai') layoutPaths.set(id, `${FAMILIES[family].object}.${field}`);
            else if (group.startsWith('template.')) layoutPaths.set(id, `power_user.${group.slice('template.'.length)}.${field}`);
        }
    }
    for (const id of stating.flatMap(l => Object.keys(l.overrides ?? {}))) {
        if (!id.includes('/') || layoutPaths.has(id)) continue;
        const [group, field] = [id.slice(0, id.indexOf('/')), id.slice(id.indexOf('/') + 1)];
        if (group.startsWith('preset.') && FAMILIES[group.slice('preset.'.length)]) layoutPaths.set(id, `${FAMILIES[group.slice('preset.'.length)].object}.${field}`);
        else if (group.startsWith('template.')) layoutPaths.set(id, `power_user.${group.slice('template.'.length)}.${field}`);
    }
    for (const [id, path] of layoutPaths) {
        const value = resolved(id, path);
        if (value !== undefined && !isAppDefault(value)) put(settings, path, structuredClone(value));
    }
    for (const [group, path] of selections) {
        const ref = statedFor(group);
        if (ref === undefined) continue;
        put(settings, path, bundleName(group, ref));
        const by = stating.filter(l => group !== 'theme' || l === user).find(l => l.bundles?.[group] !== undefined);
        sources[path] = by === user ? 'user' : /** @type {ContextLevel} */ (by).name ?? 'character';
    }
    for (const setting of Object.values(TEXT_PRESET_LENGTH_KEYS)) {
        const value = resolved(setting, setting);
        if (value !== undefined && !isAppDefault(value)) settings[setting] = value;
    }

    // Preferences at their paths.
    for (const [path, value] of Object.entries(user.overrides)) {
        if (path.includes('/') || path.startsWith('ext:') || Object.values(TEXT_PRESET_LENGTH_KEYS).includes(path)) continue;
        put(settings, path, structuredClone(value));
    }
    if (user.overrides['ext:variables']) settings.extension_settings.variables = structuredClone(user.overrides['ext:variables']);

    // Catalogs.
    const { proxies, selected_proxy } = proxiesToUpstream(byType(TYPE.proxy), statements.proxy);
    settings.proxies = proxies;
    if (selected_proxy) settings.selected_proxy = selected_proxy;
    const ordered = (/** @type {number} */ type, /** @type {string[] | undefined} */ order) => {
        const all = byType(type);
        return order ? [...all].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)) : all;
    };
    const servers = ordered(TYPE.serverHistory, statements.order?.serverHistory);
    if (servers.length) put(settings, 'power_user.servers', serverHistoryToUpstream(servers));
    // Empty when there are none, as the page holds it.
    put(settings, 'power_user.model_templates_mappings', Object.fromEntries(byType(TYPE.modelTemplateBinding).map(b => [b.key, bindingToUpstream(b)])));
    const profileEntities = ordered(TYPE.connectionProfile, statements.order?.connectionProfile);
    if (profileEntities.length || statements.profile !== undefined) {
        settings.extension_settings.connectionManager = {
            profiles: profileEntities.map(p => profileToUpstream(p, key => entities.find(e => e.key === key))),
            selectedProfile: statements.profile ?? null,
        };
    }
    const persona = personasToUpstream(byType(TYPE.persona), { userPersona: statements.persona, currentPersona: statements.currentPersona, connected: statements.personasConnected, username: statements.username });
    put(settings, 'power_user.persona_data', persona.persona_data);
    put(settings, 'power_user.personas', persona.personas);
    put(settings, 'power_user.persona_descriptions', persona.persona_descriptions);
    if (statements.persona !== undefined) put(settings, 'power_user.default_persona', persona.default_persona);
    if (persona.user_avatar !== undefined) settings.user_avatar = persona.user_avatar;
    if (persona.username !== undefined) settings.username = persona.username;
    if (statements.regexScripts) settings.extension_settings.regex = regexScriptsToUpstream(statements.regexScripts.map(key => entities.find(e => e.key === key)));
    if (statements.regexPresets) settings.extension_settings.regex_presets = regexPresetsToUpstream(statements.regexPresets.map(key => entities.find(e => e.key === key)), statements.regexPreset);
    settings.extension_settings.variables = { ...settings.extension_settings.variables, global: globalVariablesToUpstream(byType(TYPE.globalVariable)) };
    if (statements.dataBank) Object.assign(settings.extension_settings, dataBankToUpstream(byType(TYPE.dataBankFile), statements.dataBank));
    if (statements.quickReplies) {
        const qr = settings.extension_settings.quickReplyV2 ?? {};
        qr.config = setListToUpstream(statements.quickReplies.user);
        qr.characterConfigs = Object.fromEntries(statements.quickReplies.characters.map(({ avatar, ...list }) => [avatar, setListToUpstream(list)]));
        settings.extension_settings.quickReplyV2 = qr;
    }
    const biasLists = byType(TYPE.biasList);
    if (biasLists.length) settings.oai_settings.bias_presets = Object.fromEntries(biasLists.map(list => [list.key, biasListToUpstream(list)]));

    // Extensions' own settings, with the capabilities' provider fields.
    const caps = capabilitiesToUpstream(/** @type {any} */ (model.ext), statements.capabilities ?? {}, connections);
    warnings.push(...caps.warnings);
    Object.assign(settings.extension_settings, caps.settings);

    for (const [key, value] of Object.entries(model.unknown)) settings[key] = structuredClone(value);
    for (const [key, value] of Object.entries(model.elsewhere)) settings[key] = structuredClone(value);
    return { settings, warnings, sources };
}

/** The containers whose keys are each one preference (`power_user.<key>`, …), as import stores them. */
const PREFERENCE_CONTAINERS = Object.freeze(['power_user', 'oai_settings', 'textgenerationwebui_settings', 'nai_settings', 'kai_settings', 'world_info_settings', 'background']);

/** Paths a catalog module holds: a write to one is the catalog's, not a field's. */
const CATALOG_PATHS = Object.freeze([
    'proxies', 'selected_proxy', 'power_user.servers', 'power_user.model_templates_mappings', 'power_user.personas',
    'power_user.persona_descriptions', 'power_user.persona_data', 'power_user.default_persona', 'user_avatar', 'username',
    'oai_settings.bias_presets', 'extension_settings.connectionManager', 'extension_settings.regex',
    'extension_settings.regex_presets', 'extension_settings.variables', 'extension_settings.attachments',
    'extension_settings.character_attachments', 'extension_settings.disabled_attachments', 'extension_settings.quickReplyV2',
]);

/**
 * What an upstream path is in the model: the unit a write to it (or to anything under it) changes.
 * @param {string[]} keys The path's keys.
 * @returns {{ kind: 'field', field: string, path: string } | { kind: 'selection', group: string, path: string } | { kind: 'connection', path: string } | { kind: 'catalog', path: string } | { kind: 'ext', key: string } | { kind: 'ignored', path: string } | { kind: 'unknown', key: string } | { kind: 'container' }}
 *   A container holds units of its own (`power_user`, `power_user.instruct`, `extension_settings`).
 */
export function unitOfPath(keys) {
    const dotted = keys.join('.');
    if ((keys.length === 1 && [...PREFERENCE_CONTAINERS, 'extension_settings'].includes(keys[0]))
        || (keys.length === 2 && keys[0] === 'power_user' && Object.hasOwn(TEMPLATE_SELECTED, keys[1]))) {
        return { kind: 'container' };
    }
    const under = (/** @type {string} */ path) => dotted === path || dotted.startsWith(`${path}.`);
    for (const path of [...DEAD_PATHS, ...DERIVED_PATHS]) if (under(path)) return { kind: 'ignored', path };
    for (const path of CATALOG_PATHS) if (under(path)) return { kind: 'catalog', path };
    const { selections } = bundleLayout({});
    for (const [group, path] of selections) if (dotted === path) return { kind: 'selection', group, path };
    const [top, second, third] = keys;
    if (Object.values(TEXT_PRESET_LENGTH_KEYS).includes(top) && keys.length === 1) return { kind: 'field', field: top, path: top };
    if (top === 'main_api' || top === 'horde_settings') return { kind: 'connection', path: top };
    if (top === 'oai_settings' && second !== undefined) {
        if (COVERED.chat.includes(second) && !CC_PREFERENCE_KEYS.includes(second)) return { kind: 'connection', path: `oai_settings.${second}` };
        const presetKey = Object.keys(CC_PRESET_KEYS).find(key => CC_PRESET_KEYS[key] === second);
        if (presetKey) return { kind: 'field', field: `preset.openai/${presetKey}`, path: `oai_settings.${second}` };
    }
    if (top === 'textgenerationwebui_settings' && (COVERED.text.includes(second) || second === 'type')) return { kind: 'connection', path: `${top}.${second}` };
    if ((top === 'kai_settings' && second === 'api_server') || (top === 'nai_settings' && second === 'model_novel')) return { kind: 'connection', path: `${top}.${second}` };
    const family = Object.keys(FAMILIES).find(f => f !== 'openai' && FAMILIES[f].object === top);
    if (family && second !== undefined && !PRESET_EXCLUDED_KEYS.includes(second)) return { kind: 'field', field: `preset.${family}/${second}`, path: `${top}.${second}` };
    if (top === 'power_user' && second !== undefined) {
        if (Object.hasOwn(TEMPLATE_SELECTED, second) && third !== undefined && !PRESET_EXCLUDED_KEYS.includes(third) && third !== 'name') {
            return { kind: 'field', field: `template.${second}/${third}`, path: `power_user.${second}.${third}` };
        }
        if (Object.hasOwn(TEMPLATE_SELECTED, second) && third !== undefined) return { kind: 'field', field: `power_user.${second}.${third}`, path: `power_user.${second}.${third}` };
        if (CONTEXT_TEMPLATE_POWER_USER_KEYS.includes(second)) return { kind: 'field', field: `template.context/${second}`, path: `power_user.${second}` };
        if (THEME_FIELDS.includes(second)) return { kind: 'field', field: `theme/${second}`, path: `power_user.${second}` };
    }
    if (top === 'extension_settings' && second !== undefined) {
        if (['apiUrl', 'apiKey', 'autoConnect'].includes(second)) return { kind: 'connection', path: `extension_settings.${second}` };
        return { kind: 'ext', key: second };
    }
    if (PREFERENCE_CONTAINERS.includes(top) && second !== undefined) return { kind: 'field', field: `${top}.${second}`, path: `${top}.${second}` };
    if (TOP_PREFERENCES.includes(top)) return { kind: 'field', field: top, path: top };
    if (ELSEWHERE.includes(top)) return { kind: 'ignored', path: top };
    return { kind: 'unknown', key: top };
}

/**
 * @typedef {{ op: 'set' | 'delete', field: string, value?: unknown }
 *   | { op: 'bundle', group: string, ref: string | undefined, drop: string[] }
 *   | { op: 'ext', key: string, value: unknown }
 *   | { op: 'unknown', key: string, value: unknown }
 *   | { op: 'connection' | 'catalog', path: string, value: unknown }} ModelWrite
 *   `set`/`delete` an override at the user level; `bundle` a statement, dropping the level's overrides of the fields
 *   the bundle holds (selecting a preset discards its unsaved edits, as upstream); `connection`/`catalog` hand the
 *   changed value to that module.
 */

/**
 * A full save routed: each path whose value isn't what `assemble` gives now, as the writes it is (Q13: only changed
 * paths are routed, so a save made from a stale copy changes only what its sender changed).
 * @param {UserModel} model
 * @param {Record<string, any>} saved The upstream-shaped settings saved.
 * @param {{ bundles: BundleFiles, extrasApiKey?: string }} options
 * @returns {ModelWrite[]}
 */
export function routeSave(model, saved, options) {
    const { settings: current } = assemble(model, options);
    // The bundles the save selects: its field values are compared with these, as the page loaded them.
    /** @type {Record<string, string | undefined>} */
    const bundlesAfter = { ...model.user.bundles };
    for (const [group, path] of bundleLayout({}).selections) {
        const name = at(saved, path);
        if (canonicalSame(name, at(current, path))) continue;
        bundlesAfter[group] = typeof name === 'string' && !(group === 'preset.kobold' && name === KOBOLD_NO_PRESET) ? bundleRef(group, name) : undefined;
    }
    /** @type {Map<string, ModelWrite>} */
    const writes = new Map();
    /** @type {(a: unknown, b: unknown) => boolean} */
    const equal = (a, b) => canonicalSame(a, b);
    /**
     * @param {unknown} before
     * @param {unknown} after
     * @param {string[]} keys
     */
    const walk = (before, after, keys) => {
        if (equal(before, after)) return;
        const isObject = (/** @type {unknown} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v);
        const unit = keys.length ? unitOfPath(keys) : null;
        const atUnit = unit && unit.kind !== 'container' && keys.join('.') === unitPath(unit);
        if (unit && unit.kind !== 'container' && (atUnit || !isObject(before) || !isObject(after))) {
            record(unit, after);
            return;
        }
        for (const key of new Set([...Object.keys(isObject(before) ? before : {}), ...Object.keys(isObject(after) ? after : {})])) {
            walk(isObject(before) ? before[key] : undefined, isObject(after) ? after[key] : undefined, [...keys, key]);
        }
    };
    /**
     * @param {ReturnType<typeof unitOfPath>} unit
     * @param {unknown} value
     */
    const record = (unit, value) => {
        switch (unit.kind) {
            case 'ignored':
            case 'container':
                return;
            case 'ext':
                writes.set(`ext:${unit.key}`, { op: 'ext', key: unit.key, value: saved.extension_settings?.[unit.key] });
                return;
            case 'unknown':
                writes.set(`key:${unit.key}`, { op: 'unknown', key: unit.key, value: saved[unit.key] });
                return;
            case 'connection':
            case 'catalog':
                writes.set(`${unit.kind}:${unit.path}`, { op: unit.kind, path: unit.path, value: at(saved, unit.path) });
                return;
            case 'selection': {
                // The new bundle's fields replace the level's edits of them; a field it doesn't hold keeps its value,
                // as upstream keeps a live value the preset lacks.
                const ref = bundlesAfter[unit.group];
                const held = ref !== undefined ? bundleFields(options.bundles, unit.group, ref) ?? {} : {};
                const drop = Object.keys(model.user.overrides).filter(field => field.startsWith(`${unit.group}/`) && Object.hasOwn(held, field));
                writes.set(`bundle:${unit.group}`, { op: 'bundle', group: unit.group, ref: bundlesAfter[unit.group], drop });
                return;
            }
            case 'field': {
                const after = at(saved, unit.path);
                const field = unit.field;
                if (after === undefined) {
                    if (Object.hasOwn(model.user.overrides, field)) writes.set(`field:${field}`, { op: 'delete', field });
                    return;
                }
                // An override equal to what the user's bundle gives is not stored (§1.1 Edits).
                const group = field.includes('/') ? field.slice(0, field.indexOf('/')) : undefined;
                const ref = group ? bundlesAfter[group] : undefined;
                const held = ref !== undefined && group ? bundleFields(options.bundles, group, ref) : undefined;
                if (held && Object.hasOwn(held, field) && canonicalSame(held[field], after)) {
                    if (Object.hasOwn(model.user.overrides, field)) writes.set(`field:${field}`, { op: 'delete', field });
                } else {
                    writes.set(`field:${field}`, { op: 'set', field, value: after });
                }
            }
        }
    };
    walk(current, saved, []);
    // A selection first: it drops the overrides its bundle replaces, and the fields' writes then state what differs.
    const dropped = new Set([...writes.values()].flatMap(write => (write.op === 'bundle' ? write.drop : [])));
    return [...writes.values()]
        .filter(write => !(write.op === 'delete' && dropped.has(write.field)))
        .sort((a, b) => Number(b.op === 'bundle') - Number(a.op === 'bundle'));
}

/**
 * @param {ReturnType<typeof unitOfPath>} unit
 */
function unitPath(unit) {
    if (unit.kind === 'ext') return `extension_settings.${unit.key}`;
    if (unit.kind === 'unknown') return unit.key;
    return 'path' in unit ? unit.path : '';
}

/**
 * Equal as JSON, whatever the key order.
 * @param {unknown} a
 * @param {unknown} b
 */
function canonicalSame(a, b) {
    return a === b || canonicalStringify(a) === canonicalStringify(b);
}

/**
 * The model with writes applied (the user level and the extensions' own settings; connection and catalog writes are
 * their modules').
 * @param {UserModel} model
 * @param {ModelWrite[]} writes
 * @returns {UserModel}
 */
export function applyWrites(model, writes) {
    const next = structuredClone(model);
    for (const write of writes) {
        if (write.op === 'set') next.user.overrides[write.field] = structuredClone(write.value);
        else if (write.op === 'delete') delete next.user.overrides[write.field];
        else if (write.op === 'bundle') {
            if (write.ref === undefined) delete next.user.bundles[write.group];
            else next.user.bundles[write.group] = write.ref;
            for (const field of write.drop) delete next.user.overrides[field];
        } else if (write.op === 'ext') {
            if (write.value === undefined) delete next.ext[write.key];
            else next.ext[write.key] = structuredClone(write.value);
        } else if (write.op === 'unknown') {
            if (write.value === undefined) delete next.unknown[write.key];
            else next.unknown[write.key] = structuredClone(write.value);
        }
    }
    return next;
}

/**
 * The two-way translation's documented losses (§2.4) at a path: why a value there may come back otherwise.
 * @type {Readonly<Record<string, string>>}
 */
export const DOCUMENTED_LOSSES = Object.freeze({});

/**
 * The leaves of upstream settings that `back` (assembled) doesn't give back as they were, less the dead, derived and
 * documented-lossy paths and the keys other stores own; key order aside (§2.4.7).
 * @param {Record<string, any>} settings
 * @param {Record<string, any>} back
 * @returns {{ path: string[], before: unknown, after: unknown }[]}
 */
export function lostLeaves(settings, back) {
    const skipped = [...DEAD_PATHS, ...DERIVED_PATHS, ...Object.keys(DOCUMENTED_LOSSES), ...ELSEWHERE];
    /** @type {{ path: string[], before: unknown, after: unknown }[]} */
    const lost = [];
    /**
     * @param {unknown} value
     * @param {string[]} keys
     */
    const walk = (value, keys) => {
        const dotted = keys.join('.');
        if (keys.length && skipped.some(p => dotted === p || dotted.startsWith(`${p}.`))) return;
        if (value && typeof value === 'object' && !Array.isArray(value) && (keys.length === 0 || Object.keys(value).length > 0)) {
            for (const [key, inner] of Object.entries(value)) walk(inner, [...keys, key]);
            return;
        }
        const after = keys.reduce((v, key) => (v && typeof v === 'object' ? v[key] : undefined), /** @type {any} */ (back));
        if (!canonicalSame(after, value)) lost.push({ path: keys, before: value, after });
    };
    walk(settings, []);
    return lost;
}

/**
 * The bundles upstream settings select, by group and name (KoboldAI's own settings none).
 * @param {Record<string, any>} settings
 * @returns {{ group: string, name: string }[]}
 */
export function selectedBundles(settings) {
    return bundleLayout({}).selections
        .map(([group, path]) => ({ group, name: at(settings, path) }))
        .filter(({ group, name }) => typeof name === 'string' && !(group === 'preset.kobold' && name === KOBOLD_NO_PRESET));
}
