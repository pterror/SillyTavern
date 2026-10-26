import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { setConfigFilePath } from '../util.js';
import { USER_DIRECTORY_TEMPLATE } from '../constants.js';
import { loadOneOffEngine, parseOneOffArgs, probeConfiguredServer } from './one-off.js';
import { keyOf } from '../settings-model/keys.js';

/**
 * Converts a user's settings to the settings model (its step 9): the settings files, every sampler preset,
 * template, theme and quick reply set file, made the user record, the catalogs' entities and the user's statements
 * at characters, in the engine store. A one-off: run once with the server stopped, then deleted with its test.
 *
 * Nothing is deleted or rewritten: the files stay, and the server goes on reading them until the model's switch
 * (its step 10). The dry run lists what would be made, every warning, and each value the model wouldn't give back
 * as it is now (past the documented losses, §2.4), and writes nothing. --apply writes the model in one commit (the
 * Extras key into secrets.json), refused when the user is converted already (--again first deletes the model the
 * last run made: only while nothing reads it, before the model's switch), then reads it back and checks that it gives
 * the same settings. The keys it makes (connections, entries without an id of their own) are derived from the
 * handle and what they are (keyOf), so a run again makes the same ones.
 *
 *   node src/migrations/convert-settings-to-model.js --dry-run [--data-root ./data] [--handle default-user] [--config ./config.yaml]
 *   node src/migrations/convert-settings-to-model.js --apply [--again] [the same]
 */

const LOG_PREFIX = '[convert-settings-to-model]';


/**
 * A user's directories under a data root.
 * @param {string} dataRoot
 * @param {string} handle
 * @returns {import('../users.js').UserDirectoryList}
 */
export function directoriesFor(dataRoot, handle) {
    /** @type {Record<string, string>} */
    const out = {};
    for (const [key, sub] of Object.entries(USER_DIRECTORY_TEMPLATE)) out[key] = path.join(dataRoot, handle, sub);
    return /** @type {any} */ (out);
}

/**
 * @param {object} options
 * @param {string} options.dataRoot
 * @param {string} options.handle
 * @param {boolean} options.apply
 * @param {boolean} [options.again] Delete the model a last run made, first.
 * @param {() => Promise<any>} options.engine Loads the engine binding.
 * @param {() => Promise<{ running: boolean, lines: string[] }>} [options.probeServer]
 * @param {(hint: string) => string} [options.newKey] The key of what `hint` names (keyOf()).
 * @param {(line: string) => void} [options.log]
 * @param {(line: string) => void} [options.warn]
 * @returns {Promise<number>} The exit code: 0 done, 1 refused or failed.
 */
export async function runConvert(options) {
    const log = options.log ?? console.log;
    const warnLine = options.warn ?? console.warn;
    const probeServer = options.probeServer ?? probeConfiguredServer;
    const newKey = options.newKey ?? ((/** @type {string} */ hint) => keyOf(options.handle, hint));
    // Their imports read config when they load: after the config path is set.
    const { setStoreEngine, userStore, closeUserStores, STORE_DIR } = await import('../user-stores.js');
    const { readAllSettings } = await import('../settings-store.js');
    const { bundleFilesOf } = await import('../bundle-files.js');
    const { assemble, importUpstream, lostLeaves } = await import('../settings-model/settings-compat.js');
    const { bundleDraftsFromFiles, statedBundleFiles } = await import('../settings-model/bundle-import.js');
    const { deleteUserModel, readUserModel, writeUserModel } = await import('../settings-model/user-store.js');
    const { TYPE } = await import('../library-codes.js');
    const { SECRET_KEYS, writeSecret } = await import('../endpoints/secrets.js');
    const { canonicalStringify } = await import('../../public/scripts/hash-utils.js');

    const directories = directoriesFor(options.dataRoot, options.handle);
    log(`${LOG_PREFIX} ${options.apply ? 'apply' : 'dry run'} for ${directories.root}`);
    if (!fs.existsSync(path.join(directories.root, STORE_DIR))) {
        warnLine(`${LOG_PREFIX} REFUSED: ${path.join(directories.root, STORE_DIR)} doesn't exist`);
        return 1;
    }
    const probe = await probeServer();
    probe.lines.forEach(line => log(`${LOG_PREFIX} ${line}`));
    if (probe.running) {
        warnLine(`${LOG_PREFIX} REFUSED: the server appears to be running (or the port could not be checked); stop it and rerun`);
        return 1;
    }

    const settings = readAllSettings(directories);
    const fileBundles = bundleFilesOf(directories);
    const model = importUpstream(settings, { bundles: fileBundles, newKey });
    const imported = bundleDraftsFromFiles(directories, model.entities.filter(e => e.type === TYPE.connection), newKey);
    model.entities.push(...imported.connections);
    const warnings = [...model.warnings, ...imported.warnings];

    /** @type {Map<number, number>} */
    const counts = new Map();
    for (const e of [...model.entities, ...imported.bundles]) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    const typeName = new Map(Object.entries(TYPE).map(([name, code]) => [code, name]));
    log(`${LOG_PREFIX} to make: ${[...counts].map(([type, n]) => `${n} ${typeName.get(type)}`).join(', ')}; the user record with ${Object.keys(model.user.overrides).length} override(s) and ${Object.keys(model.user.bundles).length} bundle statement(s)`);
    if (model.secrets.length) log(`${LOG_PREFIX} the Extras key goes to secrets.json (${SECRET_KEYS.EXTRAS}), its connection naming it`);
    for (const w of warnings) warnLine(`${LOG_PREFIX} warning: ${w}`);

    // What the model gives back, against the files as they are.
    const withoutElsewhere = (/** @type {import('../settings-model/settings-compat.js').UserModel} */ m) => ({ ...JSON.parse(JSON.stringify(m)), elsewhere: {} });
    const expected = assemble(withoutElsewhere(model), { bundles: fileBundles, extrasApiKey: model.secrets[0]?.value });
    for (const w of expected.warnings) warnLine(`${LOG_PREFIX} warning: ${w}`);
    const lost = lostLeaves(settings, expected.settings);
    for (const l of lost) warnLine(`${LOG_PREFIX} would read otherwise: ${l.path.join('.')}: ${JSON.stringify(l.before)?.slice(0, 120)} -> ${JSON.stringify(l.after)?.slice(0, 120)}`);
    log(`${LOG_PREFIX} ${lost.length} value(s) past the documented losses would read otherwise`);
    if (!options.apply) return 0;

    const binding = await options.engine();
    setStoreEngine(() => binding);
    const store = await userStore({ root: directories.root });
    try {
        if (await readUserModel(store.lib, options.handle)) {
            if (!options.again) {
                warnLine(`${LOG_PREFIX} REFUSED: ${options.handle} is converted already (--again deletes that model and converts anew; only before the model's switch)`);
                return 1;
            }
            log(`${LOG_PREFIX} deleted the last run's model: ${await deleteUserModel(store.lib, options.handle)} entities (their history kept)`);
        }
        for (const { connection, value } of model.secrets) {
            const id = writeSecret(directories, SECRET_KEYS.EXTRAS, value);
            const entity = model.entities.find(e => e.key === connection);
            if (entity) entity.values.secret = id;
        }
        const written = await writeUserModel(store.lib, options.handle, model, { bundles: imported.bundles });
        for (const w of written.warnings) warnLine(`${LOG_PREFIX} warning: ${w}`);
        const back = await readUserModel(store.lib, options.handle);
        if (!back) {
            warnLine(`${LOG_PREFIX} FAILED: the user record isn't there after the write`);
            return 1;
        }
        const fromStore = assemble(back, { bundles: await statedBundleFiles(store.lib, back), extrasApiKey: model.secrets[0]?.value });
        const same = canonicalStringify(fromStore.settings) === canonicalStringify(expected.settings);
        if (!same) {
            // Both ways: a value read back otherwise or missing, and one read back that wasn't there.
            const differ = [...lostLeaves(expected.settings, fromStore.settings), ...lostLeaves(fromStore.settings, expected.settings)];
            for (const l of differ) warnLine(`${LOG_PREFIX} read back otherwise: ${l.path.join('.')}: ${JSON.stringify(l.before)?.slice(0, 120)} / ${JSON.stringify(l.after)?.slice(0, 120)}`);
            warnLine(`${LOG_PREFIX} FAILED: the model read back doesn't give the settings it was made from (${differ.length} value(s)); the files are as they were, nothing reads the model yet`);
            return 1;
        }
        log(`${LOG_PREFIX} written and read back: the same settings`);
        return 0;
    } finally {
        await closeUserStores();
    }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    const args = parseOneOffArgs(process.argv.slice(2));
    if (args.unknown.length > 0 || Boolean(args.dryRun) === Boolean(args.apply)) {
        console.warn(`${LOG_PREFIX} usage: --dry-run | --apply  [--data-root ./data] [--handle default-user] [--config ./config.yaml]`);
        process.exitCode = 2;
    } else {
        setConfigFilePath(args.config);
        process.exitCode = await runConvert({ dataRoot: args.dataRoot, handle: args.handle, apply: Boolean(args.apply), again: args.again === true, engine: loadOneOffEngine });
    }
}
