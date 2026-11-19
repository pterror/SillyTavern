import sanitize from 'sanitize-filename';
import { listBundles, writeBundle, renameBundle, deleteBundle } from './bundle-store.js';
import { bundleFolder } from './bundle-files.js';
import { settingsDocumentOf } from './settings-documents.js';
import { getDefaultPresets, getDefaultPresetFile } from './endpoints/content-manager.js';
import { settingsToUpdate } from '../public/scripts/chat-completion-defaults.js';
import { PRESET_EXCLUDED_KEYS, TEXT_PRESET_LENGTH_KEYS, presetLengthKeys } from '../public/scripts/preset-file-keys.js';
import { seedKeyHashes } from '../public/scripts/hash-utils.js';
import { pageSettings } from './settings-hash.js';

const fields = {
    kobold: ['kai_settings', 'preset_settings'],
    novel: ['nai_settings', 'preset_settings_novel'],
    openai: ['oai_settings', 'preset_settings_openai'],
    textgenerationwebui: ['textgenerationwebui_settings', 'preset'],
};

/** @param {import('@st/server-ui').User} user */
function documentOf(user) {
    const document = settingsDocumentOf(user.directories);
    if (!document) throw new Error('The settings are not open.');
    return document;
}

/** @type {import('@st/presets/server').Ports} */
export const presetPorts = {
    async binding(user) {
        return Boolean(documentOf(user).settingsFor({}).oai_settings?.bind_preset_to_connection);
    },
    async bind(user, enabled) {
        await documentOf(user).writeAt({}, { from: 'default', to: 'user' }, 'oai_settings.bind_preset_to_connection', enabled);
    },
    async settingsHashes(user) {
        const settings = pageSettings(documentOf(user).settingsFor({}));
        const hashes = {};
        for (const [object] of Object.values(fields)) seedKeyHashes(hashes, settings[object], object);
        seedKeyHashes(hashes, settings.power_user?.preset_order, 'power_user.preset_order');
        return hashes;
    },
    async list(user, family) {
        const [object, key] = fields[family];
        const settings = documentOf(user).settingsFor({});
        const order = settings.power_user?.preset_order?.[family] ?? [];
        const rows = await listBundles(/** @type {any} */ (user.directories), `preset.${family}`, { order: 'locale' });
        const rank = new Map(order.map((/** @type {string} */ name, /** @type {number} */ index) => [name, index]));
        rows.sort((a, b) => (rank.get(a.name) ?? Infinity) - (rank.get(b.name) ?? Infinity));
        return { selected: settings[object]?.[key] ?? (family === 'kobold' ? 'gui' : ''), presets: rows.map(({ name, file }) => ({ name, data: file })) };
    },
    async select(user, family, name) {
        const document = documentOf(user);
        const settings = structuredClone(document.settingsFor({}));
        const [object, key] = fields[family];
        settings[object] ??= {};
        // Changing or reloading a preset discards its user-level overrides; narrower levels remain intact.
        const catalog = await presetPorts.list(user, family);
        const preset = catalog.presets.find(preset => preset.name === name)?.data;
        if (preset) {
            if (family === 'openai') {
                for (const [presetKey, [, settingsKey, , isConnection]] of Object.entries(settingsToUpdate)) {
                    if (isConnection && !settings[object].bind_preset_to_connection) continue;
                    if (Object.hasOwn(preset, presetKey)) settings[object][settingsKey] = structuredClone(preset[presetKey]);
                }
            } else {
                Object.assign(settings[object], structuredClone(preset));
                for (const [presetKey, setting] of Object.entries(presetLengthKeys(`preset.${family}`, preset))) {
                    if (typeof preset[presetKey] === 'number') settings[setting] = preset[presetKey];
                }
            }
        }
        settings[object][key] = name;
        await document.replace(settings);
    },
    async current(user, family) {
        const settings = documentOf(user).settingsFor({});
        const [object] = fields[family];
        if (family === 'openai') {
            return Object.fromEntries(Object.entries(settingsToUpdate).map(([key, [, setting]]) => [key, structuredClone(settings[object]?.[setting])]));
        }
        const data = structuredClone(settings[object] ?? {});
        for (const key of PRESET_EXCLUDED_KEYS) delete data[key];
        for (const [key, setting] of Object.entries(TEXT_PRESET_LENGTH_KEYS)) data[key] = settings[setting];
        return data;
    },
    async save(user, family, { name, data }) {
        if (sanitize(name) !== name) return null;
        return await writeBundle(/** @type {any} */ (user.directories), `preset.${family}`, name, data) ?? null;
    },
    async rename(user, family, name, to) {
        const result = await renameBundle(/** @type {any} */ (user.directories), `preset.${family}`, name, to);
        return result === 'renamed' ? sanitize(to) : null;
    },
    remove: (user, family, name) => deleteBundle(/** @type {any} */ (user.directories), `preset.${family}`, name),
    async defaults(user, family, name) {
        const directories = /** @type {any} */ (user.directories);
        const folder = bundleFolder(directories, `preset.${family}`);
        const preset = getDefaultPresets(directories).find(preset => preset.folder === folder && preset.name === name);
        return preset ? getDefaultPresetFile(preset.filename) ?? null : null;
    },
    async order(user, family, names) {
        const document = documentOf(user);
        const order = document.settingsFor({}).power_user?.preset_order ?? {};
        await document.writeAt({}, { from: 'default', to: 'user' }, 'power_user.preset_order', { ...order, [family]: names });
    },
};
