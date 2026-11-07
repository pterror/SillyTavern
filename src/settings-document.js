import fs from 'node:fs';
import path from 'node:path';

import { setSettingsDocument, settingsDocumentOf } from './settings-documents.js';
import { FILES_ASIDE, legacySettingsPath, readAllSettings, settingsDirPath } from './settings-store.js';
import { userStore } from './user-stores.js';
import { TYPE } from './library-codes.js';
import { SECRET_KEYS, readSecret, writeSecret } from './endpoints/secrets.js';
import { BUNDLE_FOLDERS, bundleFilesOf, bundleFolder, listBundleFiles } from './bundle-files.js';
import { assemble, bundleRef, importUpstream, selectedBundles, unitOfPath } from './settings-model/settings-compat.js';
import { getAtPath, setAtPath } from '../public/scripts/hash-utils.js';
import { writeBundle } from './bundle-store.js';
import { bundleDraftOf, bundleDraftsFromFiles, bundleEntityOf, bundleFileFromStore, statedBundleFiles } from './settings-model/bundle-import.js';
import { readDraft, writeDrafts } from './settings-model/model-store.js';
import { readUserModel, withChosen, writeUserModel } from './settings-model/user-store.js';
import { CHOICE, readChoices } from './settings-model/book-choices.js';
import { importUpstreamWorlds, upstreamImportPending } from './upstream-import.js';
import { userConnections } from './settings-model/settings-compat.js';
import { keyOf } from './settings-model/keys.js';
import { serverDirectory } from './server-directory.js';
import { withinAllowed } from '@st/settings/model-limits';
import { SERVER_OWNED_PATHS } from './settings-hash.js';
import { LIMITS } from '@st/settings/protocol';
import { presetLengthKeys } from '../public/scripts/preset-file-keys.js';
import { modelListOf, modelListsVersion } from './model-lists.js';


/** @type {Map<string, Promise<void>>} */
const opening = new Map();

export const LEVEL_POSITIONS = Object.freeze(['default', 'preset', 'user', 'group', 'character']);

const FULL_RANGE = Object.freeze({ from: 'default', to: 'character' });

const BOOK_CHOICE_PATHS = Object.freeze(['world_info_settings', 'power_user.persona_data']);

/**
 * @param {{ from: string, to: string }} range
 */
function levelsIn(range) {
    const from = LEVEL_POSITIONS.indexOf(range.from);
    const to = LEVEL_POSITIONS.indexOf(range.to);
    if (from === -1 || to === -1 || from > to) throw new Error(`no level range ${range.from}..${range.to}`);
    return LEVEL_POSITIONS.slice(from, to + 1);
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 */
function filesAside(directories) {
    return path.join(directories.root, FILES_ASIDE);
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 */
export function settingsAreModels(directories) {
    return fs.existsSync(filesAside(directories));
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} handle
 * @returns {Promise<void>}
 */
export function openSettingsDocument(directories, handle) {
    if (settingsDocumentOf(directories)) return Promise.resolve();
    const key = path.resolve(directories.root);
    let found = opening.get(key);
    if (!found) {
        found = open(directories, handle).finally(() => opening.delete(key));
        opening.set(key, found);
    }
    return found;
}

/**
 * @param {import('./library-engine.js').LibraryEngine} lib
 * @param {Record<string, any>} settings
 * @param {import('./settings-model/entity-draft.js').EntityDraft[]} connections
 * @returns {Promise<import('./settings-model/settings-compat.js').BundleFiles>}
 */
/**
 * @param {string} group
 * @param {Record<string, unknown>} file
 */
function ownedFieldsOf(group, file) {
    const lengths = group.startsWith('preset.') && group !== 'preset.openai' ? presetLengthKeys(group, file) : {};
    const object = PRESET_OBJECTS[group];
    return SERVER_OWNED_PATHS.flatMap(path => {
        const unit = unitOfPath(path.split('.'));
        if (unit.kind !== 'field') return [];
        const length = Object.entries(lengths).find(([, setting]) => setting === path)?.[0];
        const key = unit.field.startsWith(`${group}/`) ? unit.field.slice(group.length + 1)
            : length ?? (object !== undefined && path.startsWith(`${object}.`) ? path.slice(object.length + 1) : undefined);
        return key !== undefined && Object.hasOwn(file, key) ? [{ path, key, field: unit.field }] : [];
    });
}

const PRESET_OBJECTS = Object.freeze({ 'preset.kobold': 'kai_settings', 'preset.novel': 'nai_settings' });

async function bundlesOf(lib, settings, connections) {
    /** @type {Map<string, Record<string, unknown> | undefined>} */
    const files = new Map();
    for (const { group, name } of selectedBundles(settings)) {
        files.set(`${group}\u0000${name}`, await bundleFileFromStore(lib, group, name, connections));
    }
    return (group, name) => files.get(`${group}\u0000${name}`);
}

/**
 * @param {import('./users.js').UserDirectoryList} directories
 * @param {string} handle
 */
async function open(directories, handle) {
    const store = await userStore(directories, handle);
    const { lib } = store;
    const newKey = (/** @type {string} */ hint) => keyOf(handle, hint);
    let model = await readUserModel(lib, handle);
    if (model?.choicesByName) {
        const written = await writeUserModel(lib, handle, model);
        for (const warning of [...model.warnings, ...written.warnings]) console.warn(`[settings] ${handle}: ${warning}`);
        model = await readUserModel(lib, handle);
    }
    if (!model) {
        const upstream = fs.existsSync(settingsDirPath(directories)) || fs.existsSync(legacySettingsPath(directories))
            ? readAllSettings(directories)
            : JSON.parse(fs.readFileSync(path.join(serverDirectory, 'default/content/settings.json'), 'utf8'));
        if (await upstreamImportPending(lib)) await importUpstreamWorlds(store, directories);
        await lib.tags.importSettingsTags(directories);
        const made = importUpstream(upstream, { bundles: bundleFilesOf(directories), newKey });
        const imported = bundleDraftsFromFiles(directories, made.entities.filter(e => e.type === TYPE.connection), newKey);
        made.entities.push(...imported.connections);
        for (const { connection, value } of made.secrets) {
            const entity = made.entities.find(e => e.key === connection);
            if (entity) entity.values.secret = writeSecret(directories, SECRET_KEYS.EXTRAS, value);
        }
        const written = await writeUserModel(lib, handle, made, { bundles: imported.bundles });
        for (const warning of [...made.warnings, ...imported.warnings, ...written.warnings]) console.warn(`[settings] ${handle}: ${warning}`);
        model = await readUserModel(lib, handle);
        if (!model) throw new Error(`the settings of ${handle} weren't there after their conversion`);
    }
    /** @type {import('./settings-model/entity-draft.js').EntityDraft[]} */
    const arrived = [];
    for (const group of Object.keys(BUNDLE_FOLDERS)) {
        for (const listed of listBundleFiles(directories, group, { skipped: () => {} })) {
            const name = group === 'quickReplies' && typeof listed.file?.name === 'string' ? listed.file.name : listed.name;
            const file = listed.file;
            const entity = bundleEntityOf(group, name);
            if (!entity || await readDraft(lib, entity.type, entity.key)) continue;
            const made = bundleDraftOf(group, name, file, [...userConnections(model), ...arrived.filter(d => d.type === TYPE.connection)], newKey);
            if (made) arrived.push(...made.drafts);
        }
    }
    if (arrived.length) await writeDrafts(lib, arrived);
    for (const [group, key] of Object.entries(BUNDLE_FOLDERS)) {
        const folder = bundleFolder(directories, group);
        if (!folder || !fs.existsSync(folder)) continue;
        const aside = path.join(filesAside(directories), key);
        for (const file of fs.readdirSync(folder)) {
            fs.mkdirSync(aside, { recursive: true });
            const to = path.join(aside, file);
            fs.renameSync(path.join(folder, file), fs.existsSync(to) ? `${to}.${Date.now()}` : to);
        }
    }

    fs.mkdirSync(filesAside(directories), { recursive: true });
    for (const [from, name] of [[settingsDirPath(directories), 'settings'], [legacySettingsPath(directories), 'settings.json']]) {
        if (!fs.existsSync(from)) continue;
        const to = path.join(filesAside(directories), name);
        fs.renameSync(from, fs.existsSync(to) ? `${to}.${Date.now()}` : to);
    }
    /** @type {import('./settings-model/settings-compat.js').UserModel} */
    let current = model;
    const extrasKey = () => readSecret(directories, SECRET_KEYS.EXTRAS) ?? undefined;

    /** @type {Map<string, Record<string, unknown> | undefined>} */
    let levelBundles = new Map();
    const loadLevelBundles = async () => {
        /** @type {Map<string, Record<string, unknown> | undefined>} */
        const loaded = new Map();
        for (const level of Object.values(current.statements.levels ?? {})) {
            for (const [group, ref] of Object.entries(level.bundles ?? {})) {
                const name = group === 'theme' ? ref : ref.slice(ref.indexOf(':') + 1);
                loaded.set(`${group}\u0000${name}`, await bundleFileFromStore(lib, group, name, userConnections(current)));
            }
        }
        levelBundles = loaded;
        contexts.clear();
    };
    /** @type {Map<string, Record<string, any>>} */
    const contexts = new Map();
    /** @type {import('./settings-model/settings-compat.js').BundleFiles} */
    let userBundles = await statedBundleFiles(lib, current);
    /** @type {import('./settings-model/settings-compat.js').BundleFiles} */
    const allBundles = (group, name) => userBundles(group, name) ?? levelBundles.get(`${group}\u0000${name}`);
    await loadLevelBundles();

    /** @type {Record<string, string> | null} */
    let userSourcesMemo = null;
    const userSources = () => (userSourcesMemo ??= assemble(current, { bundles: userBundles, extrasApiKey: extrasKey() }).sources);

    /**
     * @param {{ avatar?: string | null, groupId?: string | null }} context
     * @param {{ from: string, to: string }} range
     * @param {Record<string, any>} saved
     */
    const saveInContext = async (context, range, saved) => {
        const shown = document.view(context, range).settings;
        /** @type {Map<string, ReturnType<typeof unitOfPath>>} */
        const units = new Map();
        const walk = (/** @type {unknown} */ before, /** @type {unknown} */ after, /** @type {string[]} */ keys) => {
            if (JSON.stringify(before) === JSON.stringify(after)) return;
            const isObject = (/** @type {unknown} */ v) => v !== null && typeof v === 'object' && !Array.isArray(v);
            const unit = keys.length ? unitOfPath(keys) : null;
            if (unit && unit.kind !== 'container' && 'path' in unit && keys.join('.') === unit.path) {
                units.set(unit.path, unit);
                return;
            }
            if (unit && unit.kind !== 'container' && (!isObject(before) || !isObject(after))) {
                units.set(keys.join('.'), unit);
                return;
            }
            for (const key of new Set([...Object.keys(isObject(before) ? before : {}), ...Object.keys(isObject(after) ? after : {})])) {
                walk(isObject(before) ? before[key] : undefined, isObject(after) ? after[key] : undefined, [...keys, key]);
            }
        };
        walk(shown, saved, []);
        const user = structuredClone(document.settings);
        let userChanged = false;
        for (const [path] of units) {
            const value = getAtPath(saved, path);
            if (routeOf(context, range, path).to === 'user') {
                setAtPath(user, path, structuredClone(value));
                userChanged = true;
            } else {
                await writeAt(context, range, path, value);
            }
        }
        for (const [path, unit] of units) {
            const route = routeOf(context, range, path);
            if (unit.kind !== 'selection' || route.to !== 'level') continue;
            const name = getAtPath(saved, path);
            const file = typeof name === 'string' ? await bundleFileFromStore(lib, unit.group, name, userConnections(current)) : undefined;
            const held = file ? ownedFieldsOf(unit.group, file) : [];
            if (held.length) await document.writeLevel(route.holder, { delete: held.map(({ field }) => field) });
        }
        if (userChanged) await document.replace(user);
    };

    /**
     * @param {{ avatar?: string | null, groupId?: string | null }} context
     * @param {{ from: string, to: string }} range
     * @param {string} path
     * @returns {{ to: 'level', holder: string, unit: any } | { to: 'preset', group: string, field: string } | { to: 'user' }}
     */
    const routeOf = (context, range, path) => {
        const unit = unitOfPath(path.split('.'));
        const top = levelsIn(range).at(-1);
        const holder = top === 'character' && context.avatar ? `character:${context.avatar}` : top === 'group' && context.groupId ? `group:${context.groupId}` : null;
        const bundled = unit.kind === 'selection' || (unit.kind === 'field' && unit.field.includes('/'));
        if (bundled && holder) return { to: 'level', holder, unit };
        if (bundled && top === 'preset' && unit.kind === 'field') {
            return { to: 'preset', group: unit.field.slice(0, unit.field.indexOf('/')), field: unit.field.slice(unit.field.indexOf('/') + 1) };
        }
        return { to: 'user' };
    };

    /**
     * @param {{ avatar?: string | null, groupId?: string | null }} context
     * @param {{ from: string, to: string }} range
     * @param {[string, unknown][]} entries
     */
    const writeAll = async (context, range, entries) => {
        /** @type {Map<string, { set: Record<string, unknown>, delete: string[], bundles: Record<string, string | null> }>} */
        const levels = new Map();
        /** @type {Map<string, { name: string, fields: Record<string, unknown> }>} */
        const presets = new Map();
        /** @type {Record<string, any> | null} */
        let user = null;
        for (const [path, value] of entries) {
            const route = routeOf(context, range, path);
            if (route.to === 'level') {
                const change = levels.get(route.holder) ?? { set: {}, delete: [], bundles: {} };
                const { unit } = route;
                if (unit.kind === 'selection') change.bundles[unit.group] = typeof value === 'string' && value !== '' ? bundleRef(unit.group, value) : null;
                else if (value === undefined) change.delete.push(unit.field);
                else change.set[unit.field] = value;
                levels.set(route.holder, change);
            } else if (route.to === 'preset') {
                const ref = current.user.bundles[route.group];
                if (ref === undefined) continue;
                const bundle = presets.get(route.group) ?? { name: route.group === 'theme' ? ref : ref.slice(ref.indexOf(':') + 1), fields: {} };
                bundle.fields[route.field] = value;
                presets.set(route.group, bundle);
            } else {
                user ??= structuredClone(document.settings);
                setAtPath(user, path, structuredClone(value));
            }
        }
        for (const [holder, change] of levels) await document.writeLevel(holder, change);
        for (const [group, { name, fields }] of presets) {
            const file = (await bundleFileFromStore(lib, group, name, userConnections(current))) ?? {};
            await writeBundle(directories, group, name, { ...file, ...fields });
        }
        if (presets.size > 0) {
            userBundles = await statedBundleFiles(lib, current);
            userSourcesMemo = null;
            contexts.clear();
        }
        if (user) await document.replace(user);
    };
    const writeAt = (/** @type {{ avatar?: string | null, groupId?: string | null }} */ context, /** @type {{ from: string, to: string }} */ range, /** @type {string} */ path, /** @type {unknown} */ value) => writeAll(context, range, [[path, value]]);

    /**
     * @param {{ avatar?: string | null, groupId?: string | null }} context
     * @param {{ from: string, to: string }} range
     * @returns {{ settings: Record<string, any>, sources: Record<string, string> }}
     */
    const assembledView = (context, range) => {
        const shown = new Set(levelsIn(range));
        const closer = /** @type {[string, 'character' | 'group'][]} */ ([
            [context.avatar ? `character:${context.avatar}` : '', 'character'],
            [context.groupId ? `group:${context.groupId}` : '', 'group'],
        ])
            .filter(([key, name]) => key && shown.has(name) && current.statements.levels?.[key])
            .map(([key, name]) => ({ level: /** @type {'character'} */ ('character'), name, ...current.statements.levels?.[key] }));
        const whole = shown.has('preset') && shown.has('user');
        if (closer.length === 0 && whole) return { settings: document.settings, sources: userSources() };
        const key = `${context.avatar ?? ''}\u0000${context.groupId ?? ''}\u0000${range.from}\u0000${range.to}`;
        let found = contexts.get(key);
        if (!found) {
            const user = {
                level: /** @type {'user'} */ ('user'),
                bundles: shown.has('preset') ? current.user.bundles : {},
                overrides: shown.has('user') ? current.user.overrides : {},
            };
            const assembled = assemble({ ...current, user }, { bundles: allBundles, extrasApiKey: extrasKey(), levels: closer });
            found = { settings: assembled.settings, sources: assembled.sources };
            contexts.set(key, found);
        }
        return found;
    };
    /** @type {WeakMap<object, { version: number, settings: Record<string, any> }>} */
    const bounded = new WeakMap();

    let writing = Promise.resolve();
    let latest = 0;
    let settled = 0;
    /** @type {import('./settings-documents.js').OpenSettingsDocument} */
    const document = {
        settings: assemble(current, { bundles: userBundles, extrasApiKey: extrasKey() }).settings,
        settingsFor(context) {
            return document.view(context).settings;
        },
        view(context, range = FULL_RANGE) {
            const assembled = assembledView(context, range);
            const version = modelListsVersion(directories);
            let memo = bounded.get(assembled.settings);
            if (memo?.version !== version) {
                memo = { version, settings: withinAllowed(assembled.settings, source => modelListOf(directories, source)) };
                bounded.set(assembled.settings, memo);
            }
            return { settings: memo.settings, sources: assembled.sources };
        },
        saveIn(context, range, saved) {
            return saveInContext(context, range, saved);
        },
        writeAt(context, range, path, value) {
            return writeAt(context, range, path, value);
        },
        writeAll(context, range, entries) {
            return writeAll(context, range, entries);
        },
        writeLevel(holder, change) {
            const run = writing.then(async () => {
                const levels = structuredClone(current.statements.levels ?? {});
                const level = levels[holder] ?? {};
                for (const [group, ref] of Object.entries(change.bundles ?? {})) {
                    level.bundles ??= {};
                    if (ref === null) delete level.bundles[group];
                    else level.bundles[group] = ref;
                }
                for (const [field, value] of Object.entries(change.set ?? {})) (level.overrides ??= {})[field] = value;
                for (const field of change.delete ?? []) delete level.overrides?.[field];
                if (Object.keys(level.bundles ?? {}).length || Object.keys(level.overrides ?? {}).length) levels[holder] = level;
                else delete levels[holder];
                const nextModel = { ...current, statements: { ...current.statements, levels } };
                const written = await writeUserModel(lib, handle, nextModel, { previous: current });
                for (const warning of written.warnings) console.warn(`[settings] ${handle}: ${warning}`);
                current = withChosen({ ...nextModel, kept: written.kept }, written.chosen);
                userSourcesMemo = null;
                await loadLevelBundles();
            });
            writing = run.catch(() => {});
            return run;
        },
        replace(next) {
            const before = document.settings;
            const shown = structuredClone(next);
            document.settings = shown;
            const mine = ++latest;
            const run = writing.then(async () => {
                const bundles = await bundlesOf(lib, shown, userConnections(current));
                const was = new Map(selectedBundles(before).map(({ group, name }) => [group, name]));
                const lengthsSet = new Set();
                for (const { group, name } of selectedBundles(shown)) {
                    const file = was.get(group) === name ? undefined : bundles(group, name);
                    for (const { path, key } of file ? ownedFieldsOf(group, file) : []) {
                        setAtPath(shown, path, structuredClone(file?.[key]));
                        lengthsSet.add(path);
                    }
                }
                const needsUnlock = (lengthsSet.has('amount_gen') && Number(shown.amount_gen) > LIMITS.response.locked.max)
                    || (lengthsSet.has('max_context') && Number(shown.max_context) > LIMITS.context.locked.max);
                if (needsUnlock) setAtPath(shown, 'power_user.max_context_unlocked', true);
                const nextModel = importUpstream(structuredClone(shown), { bundles, newKey });
                nextModel.statements.levels = current.statements.levels;
                for (const { connection, value } of nextModel.secrets) {
                    const entity = nextModel.entities.find(e => e.key === connection);
                    if (!entity) continue;
                    entity.values.secret = value === extrasKey()
                        ? current.entities.find(e => e.key === connection)?.values.secret ?? writeSecret(directories, SECRET_KEYS.EXTRAS, value)
                        : writeSecret(directories, SECRET_KEYS.EXTRAS, value);
                }
                const written = await writeUserModel(lib, handle, nextModel, { previous: current });
                for (const warning of written.warnings) console.warn(`[settings] ${handle}: ${warning}`);
                current = withChosen({ ...nextModel, elsewhere: {}, kept: written.kept }, written.chosen);
                userBundles = bundles;
                userSourcesMemo = null;
                contexts.clear();
                if (mine === latest) document.settings = assemble(current, { bundles, extrasApiKey: extrasKey() }).settings;
            });
            writing = run.catch(() => {}).then(() => {
                settled = mine;
            });
            return run;
        },
        booksChanged(change) {
            const run = writing.then(async () => {
                const result = await change();
                const user = result.choosers.filter(c => c.type === TYPE.user && c.key === handle);
                const personas = result.choosers.filter(c => c.type === TYPE.persona);
                if (!user.length && !personas.length) return { ...result, settings: {} };
                const read = await readChoices(lib, [...user, ...personas].map(c => c.holder));
                /** @type {import('./settings-model/book-choices.js').Chosen} */
                const chosen = { personas: new Map(personas.map(c => [c.key, read.get(c.holder)?.get(CHOICE.lorebook)?.[0] ?? ''])) };
                if (user.length) chosen.selected = read.get(user[0].holder)?.get(CHOICE.selected) ?? [];
                current = withChosen(current, chosen);
                userSourcesMemo = null;
                contexts.clear();
                const before = document.settings;
                if (settled === latest) document.settings = assemble(current, { bundles: userBundles, extrasApiKey: extrasKey() }).settings;
                /** @type {Record<string, unknown>} */
                const settings = {};
                for (const path of BOOK_CHOICE_PATHS) {
                    const after = getAtPath(document.settings, path);
                    if (JSON.stringify(getAtPath(before, path)) !== JSON.stringify(after)) settings[path] = structuredClone(after);
                }
                return { ...result, settings };
            });
            writing = run.then(() => {}, () => {});
            return run;
        },
        model: () => current,
        async reset() {
            await document.replace(JSON.parse(fs.readFileSync(path.join(serverDirectory, 'default/content/settings.json'), 'utf8')));
        },
    };
    setSettingsDocument(directories, document);
}

/** @type {import('express').RequestHandler} */
export async function settingsDocumentMiddleware(request, response, next) {
    try {
        if (request.user?.directories && request.user?.profile?.handle) {
            await openSettingsDocument(request.user.directories, request.user.profile.handle);
        }
        next();
    } catch (err) {
        next(err);
    }
}
