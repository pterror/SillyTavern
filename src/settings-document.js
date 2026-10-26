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
import { readUserModel, writeUserModel } from './settings-model/user-store.js';
import { userConnections } from './settings-model/settings-compat.js';
import { keyOf } from './settings-model/keys.js';
import { serverDirectory } from './server-directory.js';
import { withinLimits } from '@st/settings/model-limits';
import { SERVER_OWNED_PATHS } from './settings-hash.js';
import { modelListOf, modelListsVersion } from './model-lists.js';

/**
 * A user's settings as the model holds them (the settings model's step 10): opened once per user, they are what
 * settings-store.js reads and writes. The model is read from the store, or made from the user's settings files the
 * first time (the conversion, settings-model/), and the files then moved aside (`settings.before-model/`), so
 * nothing reads a stale copy.
 *
 * The settings are held as upstream's shape, so every reader stays synchronous. A write is that shape anew: shown
 * at once, then imported into the model and the entities that changed written, one write after another.
 */


/** @type {Map<string, Promise<void>>} */
const opening = new Map();

/**
 * The levels a context's settings are shown and edited over, farthest first (the settings model §1.1, closest
 * first there): the app's default, the user's preset, the user's own, a group, the speaking character.
 */
export const LEVEL_POSITIONS = Object.freeze(['default', 'preset', 'user', 'group', 'character']);

/** Every level. */
const FULL_RANGE = Object.freeze({ from: 'default', to: 'character' });

/**
 * The levels from `range.from` to `range.to`.
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
 * Whether a user's settings are the model's (their files moved aside).
 * @param {import('./users.js').UserDirectoryList} directories
 */
export function settingsAreModels(directories) {
    return fs.existsSync(filesAside(directories));
}

/**
 * Opens a user's settings document, converting the user's settings files the first time; at most once per user.
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
 * The bundles settings select, read from the store.
 * @param {import('./library-engine.js').LibraryEngine} lib
 * @param {Record<string, any>} settings
 * @param {import('./settings-model/entity-draft.js').EntityDraft[]} connections
 * @returns {Promise<import('./settings-model/settings-compat.js').BundleFiles>}
 */
/**
 * The fields of a bundle the server owns (packages/areas/settings/protocol.ts SERVER_FAMILIES): each one's settings path,
 * its key in the bundle's file, and its field id in the model.
 * @param {string} group
 * @param {Record<string, unknown>} file
 */
function ownedFieldsOf(group, file) {
    return SERVER_OWNED_PATHS.flatMap(path => {
        const unit = unitOfPath(path.split('.'));
        if (unit.kind !== 'field' || !unit.field.startsWith(`${group}/`)) return [];
        const key = unit.field.slice(group.length + 1);
        return Object.hasOwn(file, key) ? [{ path, key, field: unit.field }] : [];
    });
}

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
    const { lib } = await userStore(directories, handle);
    const newKey = (/** @type {string} */ hint) => keyOf(handle, hint);
    let model = await readUserModel(lib, handle);
    if (!model) {
        // The conversion: the settings files (a new user has the shipped ones) and every bundle file.
        const upstream = fs.existsSync(settingsDirPath(directories)) || fs.existsSync(legacySettingsPath(directories))
            ? readAllSettings(directories)
            : JSON.parse(fs.readFileSync(path.join(serverDirectory, 'default/content/settings.json'), 'utf8'));
        // The tags in the files are the tag store's: imported (once) before the files go.
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
    // Bundle files in the folders (the conversion's, or new content the content manager copied in since): one the
    // store has no bundle of is imported, never over one it has (a bundle deleted stays deleted); then all go aside.
    /** @type {import('./settings-model/entity-draft.js').EntityDraft[]} */
    const arrived = [];
    for (const group of Object.keys(BUNDLE_FOLDERS)) {
        for (const listed of listBundleFiles(directories, group, { skipped: () => {} })) {
            // A quick reply set is named by its own name, as the conversion names it.
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

    // The files go aside, every time some are there (a reset or new content may have put one back): one moved
    // before keeps its place, a later one gets the time beside it.
    fs.mkdirSync(filesAside(directories), { recursive: true });
    for (const [from, name] of [[settingsDirPath(directories), 'settings'], [legacySettingsPath(directories), 'settings.json']]) {
        if (!fs.existsSync(from)) continue;
        const to = path.join(filesAside(directories), name);
        fs.renameSync(from, fs.existsSync(to) ? `${to}.${Date.now()}` : to);
    }
    /** @type {import('./settings-model/settings-compat.js').UserModel} */
    let current = model;
    const extrasKey = () => readSecret(directories, SECRET_KEYS.EXTRAS) ?? undefined;

    // The bundles the characters' and groups' levels state, loaded with the model, so a context resolves at once.
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
    /** The settings of each context asked, until the model changes. */
    /** @type {Map<string, Record<string, any>>} */
    const contexts = new Map();
    /** The user's own bundles, then the levels'. */
    /** @type {import('./settings-model/settings-compat.js').BundleFiles} */
    let userBundles = await statedBundleFiles(lib, current);
    /** @type {import('./settings-model/settings-compat.js').BundleFiles} */
    const allBundles = (group, name) => userBundles(group, name) ?? levelBundles.get(`${group}\u0000${name}`);
    await loadLevelBundles();

    /** @type {Record<string, string> | null} */
    let userSourcesMemo = null;
    const userSources = () => (userSourcesMemo ??= assemble(current, { bundles: userBundles, extrasApiKey: extrasKey() }).sources);

    /**
     * A save made while the page shows a context's settings over a range of levels: each change the save makes to
     * what was shown is the range's top level's (a bundle's field or selection), or the user's (anything else).
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
        // Each change where its route says; the user's own ones in one write.
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
        // A bundle a chat's level selects: that level's own values of the fields the server owns go, so the bundle's
        // show (the user's selections do the same in replace()).
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
     * Where an edit of one path goes, for a page showing a context over a range: the range's top level when the path
     * is a bundle's field or selection (a character's or group's statement, or the user's preset's field), else the
     * user's own settings.
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
     * Writes one path where routeOf() says. `undefined` takes the path away (back to what's under it).
     * @param {{ avatar?: string | null, groupId?: string | null }} context
     * @param {{ from: string, to: string }} range
     * @param {string} path
     * @param {unknown} value
     */
    const writeAt = async (context, range, path, value) => {
        const route = routeOf(context, range, path);
        if (route.to === 'level') {
            const { holder, unit } = route;
            if (unit.kind === 'selection') await document.writeLevel(holder, { bundles: { [unit.group]: typeof value === 'string' && value ? bundleRef(unit.group, value) : null } });
            else if (value === undefined) await document.writeLevel(holder, { delete: [unit.field] });
            else await document.writeLevel(holder, { set: { [unit.field]: value } });
            return;
        }
        if (route.to === 'preset') {
            const ref = current.user.bundles[route.group];
            if (ref === undefined) return;
            const name = route.group === 'theme' ? ref : ref.slice(ref.indexOf(':') + 1);
            const file = (await bundleFileFromStore(lib, route.group, name, userConnections(current))) ?? {};
            await writeBundle(directories, route.group, name, { ...file, [route.field]: value });
            userBundles = await statedBundleFiles(lib, current);
            userSourcesMemo = null;
            contexts.clear();
            return;
        }
        const user = structuredClone(document.settings);
        setAtPath(user, path, structuredClone(value));
        await document.replace(user);
    };

    /**
     * A context's settings over a range as the levels state them, and the level each bundle field's value comes from.
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
            // The user's level as far as the range goes: its preset (bundles), its own (overrides), or both.
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
    /** Each assembled settings object within its limits, for the model lists' version it was bounded at. */
    /** @type {WeakMap<object, { version: number, settings: Record<string, any> }>} */
    const bounded = new WeakMap();

    let writing = Promise.resolve();
    let latest = 0;
    /** @type {import('./settings-documents.js').OpenSettingsDocument} */
    const document = {
        settings: assemble(current, { bundles: userBundles, extrasApiKey: extrasKey() }).settings,
        settingsFor(context) {
            return document.view(context).settings;
        },
        view(context, range = FULL_RANGE) {
            const assembled = assembledView(context, range);
            // Within what the chat completion source and model allow, as everything reads them; stored as stated.
            const version = modelListsVersion(directories);
            let memo = bounded.get(assembled.settings);
            if (memo?.version !== version) {
                memo = { version, settings: withinLimits(assembled.settings, source => modelListOf(directories, source)) };
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
                current = nextModel;
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
                // A bundle the write selects: the fields of it the server owns take its values, as the old page wrote
                // them with the selection (only settings.set writes them now).
                const was = new Map(selectedBundles(before).map(({ group, name }) => [group, name]));
                for (const { group, name } of selectedBundles(shown)) {
                    const file = was.get(group) === name ? undefined : bundles(group, name);
                    for (const { path, key } of file ? ownedFieldsOf(group, file) : []) setAtPath(shown, path, structuredClone(file?.[key]));
                }
                const nextModel = importUpstream(structuredClone(shown), { bundles, newKey });
                // The characters' and groups' statements are the model's own: upstream's settings don't carry them.
                nextModel.statements.levels = current.statements.levels;
                // The Extras key stays in secrets.json, its connection naming it.
                for (const { connection, value } of nextModel.secrets) {
                    const entity = nextModel.entities.find(e => e.key === connection);
                    if (!entity) continue;
                    entity.values.secret = value === extrasKey()
                        ? current.entities.find(e => e.key === connection)?.values.secret ?? writeSecret(directories, SECRET_KEYS.EXTRAS, value)
                        : writeSecret(directories, SECRET_KEYS.EXTRAS, value);
                }
                const written = await writeUserModel(lib, handle, nextModel, { previous: current });
                for (const warning of written.warnings) console.warn(`[settings] ${handle}: ${warning}`);
                // What was written is the model now: the store isn't read back.
                current = { ...nextModel, elsewhere: {} };
                userBundles = bundles;
                userSourcesMemo = null;
                contexts.clear();
                // The settings as the model gives them, unless a later write is showing its own already.
                if (mine === latest) document.settings = assemble(current, { bundles, extrasApiKey: extrasKey() }).settings;
            });
            writing = run.catch(() => {});
            return run;
        },
        model: () => current,
        async reset() {
            await document.replace(JSON.parse(fs.readFileSync(path.join(serverDirectory, 'default/content/settings.json'), 'utf8')));
        },
    };
    setSettingsDocument(directories, document);
}

/**
 * Express middleware: the user's settings document open before a route reads or writes settings.
 * @type {import('express').RequestHandler}
 */
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
