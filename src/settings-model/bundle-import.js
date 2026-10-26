import { TYPE } from '../library-codes.js';
import { listBundleFiles } from '../bundle-files.js';
import { CONNECTION_REF, PRESET_APIS, presetFromUpstream, presetToUpstream } from './sampler-presets.js';
import { chatConnectionsFromUpstream, chatConnectionsToUpstream } from './connections.js';
import { TEMPLATE_KINDS, templateFromUpstream, templateToUpstream } from './templates.js';
import { themeFromUpstream, themeToUpstream } from './themes.js';
import { quickReplySetFromUpstream, quickReplySetToUpstream } from './quick-replies.js';
import { readDraft } from './model-store.js';
import { userConnections } from './settings-compat.js';

/**
 * The bundles' files as the settings model's entities (step 9), and back: every sampler preset, template, theme
 * and quick reply set a user has. A chat completion preset's connection keys are its connection (Q4, §2.4.9): the
 * user's connection of that source when its values are the same, else a connection of its own.
 */

/** A sampler preset family's group. */
const PRESET_GROUP = Object.freeze({ openai: 'preset.openai', textgenerationwebui: 'preset.textgenerationwebui', novel: 'preset.novel', kobold: 'preset.kobold' });

/**
 * @typedef {import('./entity-draft.js').EntityDraft} EntityDraft
 */

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function same(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A sampler preset's file as its draft: a chat completion preset's connection keys the connection among
 * `connections` of its source with the same values, else one of its own (returned, to write with it).
 * @param {string} api
 * @param {string} name
 * @param {Record<string, any>} file
 * @param {EntityDraft[]} connections
 * @param {(hint: string) => string} newKey
 * @returns {{ preset: EntityDraft, connections: EntityDraft[], warnings: string[] }}
 */
export function presetDraft(api, name, file, connections, newKey) {
    const from = presetFromUpstream(api, name, file);
    /** @type {EntityDraft[]} */
    const made = [];
    if (from.connection) {
        // The preset's own connection, if it is one, is keyed by the preset: not the user's of that source.
        const cc = chatConnectionsFromUpstream(from.connection, hint => newKey(`preset ${api}:${name} ${hint}`));
        const chosen = cc.connections.find(c => c.key === cc.selected);
        if (chosen) {
            const found = connections.find(c => c.values.type === chosen.values.type && same(c.values, chosen.values));
            if (!found) made.push(chosen);
            from.preset.values[CONNECTION_REF] = (found ?? chosen).key;
        }
    }
    return { preset: from.preset, connections: made, warnings: from.warnings };
}

/**
 * A bundle's file as its draft (a sampler preset's through presetDraft()).
 * @param {string} group
 * @param {string} name
 * @param {Record<string, any>} file
 * @param {EntityDraft[]} connections
 * @param {(hint: string) => string} newKey
 * @returns {{ drafts: EntityDraft[], warnings: string[] } | undefined} The bundle's and any connection it makes;
 *   undefined for a group there's none of.
 */
export function bundleDraftOf(group, name, file, connections, newKey) {
    if (group.startsWith('preset.')) {
        const api = group.slice('preset.'.length);
        if (!PRESET_APIS.includes(api)) return undefined;
        const one = presetDraft(api, name, file, connections, newKey);
        return { drafts: [one.preset, ...one.connections], warnings: one.warnings };
    }
    if (group.startsWith('template.')) {
        const kind = group.slice('template.'.length);
        return TEMPLATE_KINDS.includes(kind) ? { drafts: [templateFromUpstream(kind, name, file)], warnings: [] } : undefined;
    }
    if (group === 'theme') return { drafts: [themeFromUpstream(name, file)], warnings: [] };
    if (group === 'quickReplies') {
        const set = quickReplySetFromUpstream(name, file);
        return { drafts: [set.set], warnings: set.warnings };
    }
    return undefined;
}

/**
 * The entity type and key of a bundle by group and name; undefined for a group there's none of.
 * @param {string} group
 * @param {string} name
 * @returns {{ type: number, key: string } | undefined}
 */
export function bundleEntityOf(group, name) {
    if (group.startsWith('preset.')) return { type: TYPE.samplerPreset, key: `${group.slice('preset.'.length)}:${name}` };
    if (group.startsWith('template.')) return { type: TYPE.template, key: `${group.slice('template.'.length)}:${name}` };
    if (group === 'theme') return { type: TYPE.theme, key: name };
    if (group === 'quickReplies') return { type: TYPE.quickReplySet, key: name };
    return undefined;
}

/**
 * Every bundle file of a user as drafts, with the connections their chat completion presets need.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {EntityDraft[]} connections The user's connections, a preset's found among them.
 * @param {(hint: string) => string} newKey The key of what `hint` names; the same hint, the same key.
 * @returns {{ bundles: EntityDraft[], connections: EntityDraft[], warnings: string[] }}
 */
export function bundleDraftsFromFiles(directories, connections, newKey) {
    /** @type {EntityDraft[]} */
    const bundles = [];
    /** @type {EntityDraft[]} */
    const made = [];
    /** @type {string[]} */
    const warnings = [];
    // §2.4.8: a file that isn't JSON is listed, and left as it is.
    const skipped = (/** @type {string} */ file) => warnings.push(`${file} isn't valid JSON; left as it is, not imported`);
    for (const api of PRESET_APIS) {
        for (const { name, file } of listBundleFiles(directories, PRESET_GROUP[api], { order: 'locale', skipped })) {
            const one = presetDraft(api, name, file, [...connections, ...made], newKey);
            warnings.push(...one.warnings);
            made.push(...one.connections);
            bundles.push(one.preset);
        }
    }
    for (const kind of TEMPLATE_KINDS) {
        for (const { name, file } of listBundleFiles(directories, `template.${kind}`, { skipped })) bundles.push(templateFromUpstream(kind, name, file));
    }
    for (const { name, file } of listBundleFiles(directories, 'theme', { skipped })) bundles.push(themeFromUpstream(name, file));
    for (const { name, file } of listBundleFiles(directories, 'quickReplies', { skipped })) {
        const set = quickReplySetFromUpstream(String(file?.name ?? name), file);
        warnings.push(...set.warnings);
        bundles.push(set.set);
    }
    return { bundles, connections: made, warnings };
}

/**
 * A bundle's upstream file from the store, by group and name; undefined when there's none. A chat completion
 * preset's connection keys come back from the connection it names (and the user's other connections).
 * @param {import('../library-engine.js').LibraryEngine} lib
 * @param {string} group
 * @param {string} name
 * @param {EntityDraft[]} connections
 * @returns {Promise<Record<string, unknown> | undefined>}
 */
export async function bundleFileFromStore(lib, group, name, connections) {
    if (group.startsWith('preset.')) {
        const api = group.slice('preset.'.length);
        const preset = await readDraft(lib, TYPE.samplerPreset, `${api}:${name}`);
        if (!preset) return undefined;
        const ref = preset.values[CONNECTION_REF];
        const chosen = typeof ref === 'string' ? connections.find(c => c.key === ref) : undefined;
        return presetToUpstream(preset, api === 'openai' && chosen ? chatConnectionsToUpstream(connections.filter(c => String(c.values.type).startsWith('openai:')), chosen) : null);
    }
    if (group.startsWith('template.')) {
        const template = await readDraft(lib, TYPE.template, `${group.slice('template.'.length)}:${name}`);
        return template ? templateToUpstream(template) : undefined;
    }
    if (group === 'theme') {
        const theme = await readDraft(lib, TYPE.theme, name);
        return theme ? themeToUpstream(theme) : undefined;
    }
    if (group === 'quickReplies') {
        const set = await readDraft(lib, TYPE.quickReplySet, name);
        return set ? quickReplySetToUpstream(set) : undefined;
    }
    return undefined;
}

/**
 * The bundles a model's user level states, read from the store, as settings-compat.js's (synchronous) BundleFiles.
 * @param {import('../library-engine.js').LibraryEngine} lib
 * @param {import('./settings-compat.js').UserModel} model
 * @returns {Promise<import('./settings-compat.js').BundleFiles>}
 */
export async function statedBundleFiles(lib, model) {
    const connections = userConnections(model);
    /** @type {Map<string, Record<string, unknown> | undefined>} */
    const files = new Map();
    for (const [group, ref] of Object.entries(model.user.bundles)) {
        const name = group === 'theme' ? ref : ref.slice(ref.indexOf(':') + 1);
        files.set(`${group}\u0000${name}`, await bundleFileFromStore(lib, group, name, connections));
    }
    return (group, name) => files.get(`${group}\u0000${name}`);
}
