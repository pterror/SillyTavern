import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { setConfigFilePath } from '../util.js';
import { USER_DIRECTORY_TEMPLATE } from '../constants.js';
import { probeConfiguredServer } from './cleanup-zztest-leftovers.js';

/**
 * Converts one user's World Info files to the stored format (`sidecar-v2`), through the same import the
 * /api/worldinfo/import route uses: files in upstream's format (entries inline), and files in the previous stored
 * format (`sidecar-v1`: the manifest lists entry uids, each entry in `<name>.entries/<uid>.json`), read back whole
 * first. A one-off: run once on the existing data, then deleted.
 *
 * Each file converted is first copied, with its `<name>.entries/` directory when one is there, to
 * `<user>/backups/_convert-world-info/<timestamp>/`; backups are never deleted. A file that can't be read or parsed,
 * or has no `entries`, is listed and left as it is.
 *
 * Dry run (reads only, writes nothing, may run while the server is running):
 *   node src/migrations/convert-world-info-to-sidecar.js --dry-run [--data-root ./data] [--handle default-user] [--config ./config.yaml]
 * Real run (the server must be stopped):
 *   node src/migrations/convert-world-info-to-sidecar.js --apply --server-stopped [--data-root ./data] [--handle default-user] [--config ./config.yaml]
 */

const LOG_PREFIX = '[convert-world-info]';
const BACKUP_DIR_NAME = '_convert-world-info';
const PREVIOUS_FORMAT = 'sidecar-v1';

/**
 * A `sidecar-v1` book read back whole: the manifest's fields and each entry from `<uid>.json`.
 * @param {Record<string, any>} manifest
 * @param {string} entriesDir
 * @returns {{ book: Record<string, unknown> } | { reason: string }}
 */
function readPreviousFormat(manifest, entriesDir) {
    /** @type {Record<string, unknown>} */
    const entries = {};
    for (const uid of manifest.entries) {
        const file = `${String(uid)}.json`;
        if (path.basename(file) !== file) return { reason: `entry ${uid} has no usable file name` };
        try {
            entries[uid] = JSON.parse(fs.readFileSync(path.join(entriesDir, file), 'utf8'));
        } catch (err) {
            return { reason: `entry ${uid} can't be read: ${/** @type {Error} */ (err).message}` };
        }
    }
    const rest = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'format' && key !== 'entries'));
    return { book: { ...rest, entries } };
}

/**
 * Sorts the World Info files of `worldsDir` by what the conversion does with them.
 * @param {string} worldsDir
 * @param {(worldInfo: unknown) => boolean} isSidecar
 * @returns {{ convert: string[], current: string[], unreadable: { file: string, reason: string }[] }}
 */
export function planConversion(worldsDir, isSidecar) {
    const plan = { convert: /** @type {string[]} */ ([]), current: /** @type {string[]} */ ([]), unreadable: /** @type {{ file: string, reason: string }[]} */ ([]) };
    if (!fs.existsSync(worldsDir)) return plan;
    const files = fs.readdirSync(worldsDir, { withFileTypes: true })
        .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.json')
        .map(entry => entry.name)
        .sort();
    for (const file of files) {
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(path.join(worldsDir, file), 'utf8'));
        } catch (err) {
            plan.unreadable.push({ file, reason: /** @type {Error} */ (err).message });
            continue;
        }
        if (isSidecar(parsed)) {
            plan.current.push(file);
        } else if (parsed?.format === PREVIOUS_FORMAT && Array.isArray(parsed.entries)) {
            const read = readPreviousFormat(parsed, path.join(worldsDir, `${path.parse(file).name}.entries`));
            if ('reason' in read) plan.unreadable.push({ file, reason: read.reason });
            else plan.convert.push(file);
        } else if (parsed && typeof parsed === 'object' && 'entries' in parsed && parsed.format === undefined) {
            plan.convert.push(file);
        } else {
            plan.unreadable.push({ file, reason: 'it is in no format this converts' });
        }
    }
    return plan;
}

/**
 * @param {object} options
 * @param {string} options.dataRoot
 * @param {string} options.handle
 * @param {boolean} options.apply
 * @param {boolean} options.serverStopped
 * @param {() => Promise<{ running: boolean, lines: string[] }>} [options.probeServer]
 * @param {(line: string) => void} [options.log]
 * @param {(line: string) => void} [options.warn]
 * @param {Date} [options.now]
 * @returns {Promise<number>} Process exit code: 0 done (or nothing to do), 1 refused, or a file left as it was.
 */
export async function runConversion(options) {
    const { dataRoot, handle, apply, serverStopped } = options;
    const log = options.log ?? console.log;
    const warn = options.warn ?? console.warn;
    const probeServer = options.probeServer ?? probeConfiguredServer;
    const root = path.join(dataRoot, handle);
    const directories = /** @type {import('../users.js').UserDirectoryList} */ (/** @type {unknown} */ (Object.fromEntries(
        Object.entries(USER_DIRECTORY_TEMPLATE).map(([key, dir]) => [key, path.join(root, dir)]))));
    const worldsDir = directories.worlds;

    log(`${LOG_PREFIX} ${apply ? 'real run' : 'dry run'} for ${worldsDir}`);
    if (apply) {
        if (!serverStopped) {
            warn(`${LOG_PREFIX} REFUSED: the real run needs --server-stopped (stop the server first; a --port override is not visible to the port probe)`);
            return 1;
        }
        const probe = await probeServer();
        probe.lines.forEach(line => log(`${LOG_PREFIX} ${line}`));
        if (probe.running) {
            warn(`${LOG_PREFIX} REFUSED: the server appears to be running (or the port could not be checked); stop it and rerun`);
            return 1;
        }
    }

    const { importWorldInfoFromRaw, isSidecarWorldInfo } = await import('../endpoints/worldinfo.js');
    const plan = planConversion(worldsDir, isSidecarWorldInfo);
    log(`${LOG_PREFIX} ${plan.convert.length} file(s) to convert, ${plan.current.length} already in the stored format, ${plan.unreadable.length} left as they are.`);
    for (const file of plan.convert) log(`${LOG_PREFIX}   ${apply ? 'CONVERT' : 'WOULD CONVERT'} ${file}`);
    for (const { file, reason } of plan.unreadable) warn(`${LOG_PREFIX}   LEFT AS IT IS ${file}: ${reason}`);
    if (!apply) {
        log(`${LOG_PREFIX} dry run: nothing was written.`);
        return plan.unreadable.length > 0 ? 1 : 0;
    }
    if (plan.convert.length === 0) {
        log(`${LOG_PREFIX} nothing to convert; nothing was written.`);
        return plan.unreadable.length > 0 ? 1 : 0;
    }

    const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(directories.backups, BACKUP_DIR_NAME, stamp);
    fs.mkdirSync(backupDir, { recursive: true });
    log(`${LOG_PREFIX} backups: ${backupDir}`);
    let failed = 0;
    for (const file of plan.convert) {
        const filePath = path.join(worldsDir, file);
        const entriesDir = path.join(worldsDir, `${path.parse(file).name}.entries`);
        try {
            fs.copyFileSync(filePath, path.join(backupDir, file), fs.constants.COPYFILE_EXCL);
            if (fs.existsSync(entriesDir)) fs.cpSync(entriesDir, path.join(backupDir, path.basename(entriesDir)), { recursive: true, errorOnExist: true, force: false });
            const text = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(text);
            if (parsed?.format === PREVIOUS_FORMAT) {
                const read = readPreviousFormat(parsed, entriesDir);
                if ('reason' in read) throw new Error(read.reason);
                importWorldInfoFromRaw(directories, file, JSON.stringify(read.book));
            } else {
                importWorldInfoFromRaw(directories, file, text);
            }
        } catch (err) {
            failed++;
            warn(`${LOG_PREFIX}   FAILED ${file}: ${/** @type {Error} */ (err).message}`);
        }
    }
    log(`${LOG_PREFIX} converted ${plan.convert.length - failed} file(s).`);
    return failed > 0 || plan.unreadable.length > 0 ? 1 : 0;
}

/**
 * @param {string[]} argv
 * @returns {{ dataRoot: string, handle: string, config: string, dryRun: boolean, apply: boolean, serverStopped: boolean, unknown: string[] }}
 */
export function parseArgs(argv) {
    const out = { dataRoot: './data', handle: 'default-user', config: './config.yaml', dryRun: false, apply: false, serverStopped: false, unknown: /** @type {string[]} */ ([]) };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--dry-run') out.dryRun = true;
        else if (arg === '--apply') out.apply = true;
        else if (arg === '--server-stopped') out.serverStopped = true;
        else if ((arg === '--data-root' || arg === '--handle' || arg === '--config') && argv[i + 1] !== undefined) {
            out[{ '--data-root': 'dataRoot', '--handle': 'handle', '--config': 'config' }[arg]] = argv[++i];
        } else out.unknown.push(arg);
    }
    return out;
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 * @param {() => Promise<{ running: boolean, lines: string[] }>} [deps.probeServer]
 * @param {(line: string) => void} [deps.log]
 * @param {(line: string) => void} [deps.warn]
 * @param {Date} [deps.now]
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
    const args = parseArgs(argv);
    const warn = deps.warn ?? console.warn;
    if (args.unknown.length > 0 || args.dryRun === args.apply) {
        warn(`${LOG_PREFIX} usage: --dry-run | --apply --server-stopped  [--data-root ./data] [--handle default-user] [--config ./config.yaml]`);
        if (args.unknown.length > 0) warn(`${LOG_PREFIX} unknown argument(s): ${args.unknown.join(' ')}`);
        return 2;
    }
    return runConversion({ ...deps, dataRoot: args.dataRoot, handle: args.handle, apply: args.apply, serverStopped: args.serverStopped });
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    const args = parseArgs(process.argv.slice(2));
    setConfigFilePath(args.config);
    process.exitCode = await main(process.argv.slice(2));
}
