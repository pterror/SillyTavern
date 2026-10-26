import fs from 'node:fs';
import path from 'node:path';

import { setSettingsDocument, settingsDocumentOf } from './settings-documents.js';
import { FILES_ASIDE, legacySettingsPath, readAllSettings, settingsDirPath } from './settings-store.js';
import { userStore } from './user-stores.js';
import { TYPE } from './library-codes.js';
import { SECRET_KEYS, readSecret, writeSecret } from './endpoints/secrets.js';
import { BUNDLE_FOLDERS, bundleFilesOf, bundleFolder, listBundleFiles } from './bundle-files.js';
import { assemble, importUpstream, selectedBundles } from './settings-model/settings-compat.js';
import { bundleDraftOf, bundleDraftsFromFiles, bundleEntityOf, bundleFileFromStore, statedBundleFiles } from './settings-model/bundle-import.js';
import { readDraft, writeDrafts } from './settings-model/model-store.js';
import { readUserModel, writeUserModel } from './settings-model/user-store.js';
import { userConnections } from './settings-model/settings-compat.js';
import { keyOf } from './settings-model/keys.js';
import { serverDirectory } from './server-directory.js';

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

    let writing = Promise.resolve();
    let latest = 0;
    /** @type {import('./settings-documents.js').OpenSettingsDocument} */
    const document = {
        settings: assemble(current, { bundles: userBundles, extrasApiKey: extrasKey() }).settings,
        settingsFor(context) {
            const levels = [context.avatar && `character:${context.avatar}`, context.groupId && `group:${context.groupId}`]
                .filter(Boolean)
                .map(key => current.statements.levels?.[/** @type {string} */ (key)])
                .filter(Boolean)
                .map(level => ({ level: /** @type {'character'} */ ('character'), ...level }));
            if (levels.length === 0) return document.settings;
            const key = `${context.avatar ?? ''}\u0000${context.groupId ?? ''}`;
            let found = contexts.get(key);
            if (!found) {
                found = assemble(current, { bundles: allBundles, extrasApiKey: extrasKey(), levels }).settings;
                contexts.set(key, found);
            }
            return found;
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
                await loadLevelBundles();
            });
            writing = run.catch(() => {});
            return run;
        },
        replace(next) {
            const shown = structuredClone(next);
            document.settings = shown;
            const mine = ++latest;
            const run = writing.then(async () => {
                const bundles = await bundlesOf(lib, shown, userConnections(current));
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
