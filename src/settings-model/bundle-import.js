import { TYPE } from '../library-codes.js';
import { listBundleFiles } from '../bundle-files.js';
import { CONNECTION_REF, PRESET_APIS, presetFromUpstream, presetToUpstream } from './sampler-presets.js';
import { chatConnectionsFromUpstream, chatConnectionsToUpstream } from './connections.js';
import { TEMPLATE_KINDS, templateFromUpstream, templateToUpstream } from './templates.js';
import { themeFromUpstream, themeToUpstream } from './themes.js';
import { quickReplySetFromUpstream, quickReplySetToUpstream } from './quick-replies.js';
import { readDraft } from './model-store.js';

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
 * Every bundle file of a user as drafts, with the connections their chat completion presets need.
 * @param {import('../users.js').UserDirectoryList} directories
 * @param {EntityDraft[]} connections The user's connections, a preset's found among them.
 * @param {() => string} newKey
 * @returns {{ bundles: EntityDraft[], connections: EntityDraft[], warnings: string[] }}
 */
export function bundleDraftsFromFiles(directories, connections, newKey) {
    /** @type {EntityDraft[]} */
    const bundles = [];
    /** @type {EntityDraft[]} */
    const made = [];
    /** @type {string[]} */
    const warnings = [];
    for (const api of PRESET_APIS) {
        for (const { name, file } of listBundleFiles(directories, PRESET_GROUP[api], { order: 'locale' })) {
            const from = presetFromUpstream(api, name, file);
            warnings.push(...from.warnings);
            if (from.connection) {
                const cc = chatConnectionsFromUpstream(from.connection, newKey);
                const chosen = cc.connections.find(c => c.key === cc.selected);
                if (chosen) {
                    const found = [...connections, ...made].find(c => c.values.type === chosen.values.type && same(c.values, chosen.values));
                    if (!found) made.push(chosen);
                    from.preset.values[CONNECTION_REF] = (found ?? chosen).key;
                }
            }
            bundles.push(from.preset);
        }
    }
    for (const kind of TEMPLATE_KINDS) {
        for (const { name, file } of listBundleFiles(directories, `template.${kind}`)) bundles.push(templateFromUpstream(kind, name, file));
    }
    for (const { name, file } of listBundleFiles(directories, 'theme')) bundles.push(themeFromUpstream(name, file));
    for (const { name, file } of listBundleFiles(directories, 'quickReplies')) {
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
        if (!preset || Object.keys(preset.values).length === 0 && !preset.lists) return undefined;
        const ref = preset.values[CONNECTION_REF];
        const chosen = typeof ref === 'string' ? connections.find(c => c.key === ref) : undefined;
        return presetToUpstream(preset, api === 'openai' && chosen ? chatConnectionsToUpstream(connections.filter(c => String(c.values.type).startsWith('openai:')), chosen) : null);
    }
    if (group.startsWith('template.')) {
        const template = await readDraft(lib, TYPE.template, `${group.slice('template.'.length)}:${name}`);
        return template && Object.keys(template.values).length ? templateToUpstream(template) : undefined;
    }
    if (group === 'theme') {
        const theme = await readDraft(lib, TYPE.theme, name);
        return theme && Object.keys(theme.values).length ? themeToUpstream(theme) : undefined;
    }
    if (group === 'quickReplies') {
        const set = await readDraft(lib, TYPE.quickReplySet, name);
        return set && Object.keys(set.values).length ? quickReplySetToUpstream(set) : undefined;
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
    const connections = model.entities.filter(e => e.type === TYPE.connection);
    /** @type {Map<string, Record<string, unknown> | undefined>} */
    const files = new Map();
    for (const [group, ref] of Object.entries(model.user.bundles)) {
        const name = group === 'theme' ? ref : ref.slice(ref.indexOf(':') + 1);
        files.set(`${group}\u0000${name}`, await bundleFileFromStore(lib, group, name, connections));
    }
    return (group, name) => files.get(`${group}\u0000${name}`);
}
