import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

import { getConfigValue, setConfigFilePath } from '../util.js';

/**
 * A one-off for one user's data, run once with the server stopped, then deleted with its test and the server's
 * refusal to open a store that still keeps thumbnails by file name (src/user-stores.js, NAMED_THUMBNAILS).
 *
 *   node src/migrations/image-entities.js --dry-run [--data-root ./data] [--handle default-user] [--config ./config.yaml]
 *   node src/migrations/image-entities.js --apply [the same]
 */

const LOG_PREFIX = '[image-entities]';
const PAGE = 500;

/**
 * @param {string} host
 * @param {number} port
 * @returns {Promise<string>}
 */
function probeBind(host, port) {
    return new Promise(resolve => {
        const server = net.createServer();
        server.once('error', err => {
            const code = /** @type {any} */ (err).code;
            if (code === 'EADDRINUSE') resolve('in-use');
            else if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') resolve('unavailable');
            else resolve(`error ${code ?? err.message}`);
        });
        server.listen({ host, port, exclusive: true }, () => server.close(() => resolve('free')));
    });
}

/**
 * @returns {Promise<{ running: boolean, lines: string[] }>}
 */
export async function probeConfiguredServer() {
    const port = getConfigValue('port', 8000, 'number');
    const listen = getConfigValue('listen', false, 'boolean');
    const v4 = String(getConfigValue('listenAddress.ipv4', '0.0.0.0'));
    const v6 = String(getConfigValue('listenAddress.ipv6', '[::]')).replace(/^\[|\]$/g, '');
    const hosts = [
        listen ? (net.isIPv4(v4) ? v4 : '0.0.0.0') : '127.0.0.1',
        listen ? (net.isIPv6(v6) ? v6 : '::') : '::1',
    ];
    const lines = [];
    let running = false;
    for (const host of hosts) {
        const result = await probeBind(host, port);
        lines.push(`port probe ${host.includes(':') ? `[${host}]` : host}:${port}: ${result}`);
        if (result !== 'free' && result !== 'unavailable') running = true;
    }
    return { running, lines };
}

/**
 * @param {object} options
 * @param {string} options.dataRoot
 * @param {string} options.handle
 * @param {boolean} options.apply
 * @param {() => Promise<any>} options.engine
 * @param {() => Promise<{ running: boolean, lines: string[] }>} [options.probeServer]
 * @param {(line: string) => void} [options.log]
 * @param {(line: string) => void} [options.warn]
 * @returns {Promise<number>}
 */
export async function runMigration(options) {
    const log = options.log ?? console.log;
    const warnLine = options.warn ?? console.warn;
    const probeServer = options.probeServer ?? probeConfiguredServer;
    const { STORE_DIR, NAMED_THUMBNAILS } = await import('../user-stores.js');
    const { LibraryEngine } = await import('../library-engine.js');
    const { HASH, TYPE } = await import('../library-codes.js');
    const { USER_DIRECTORY_TEMPLATE } = await import('../constants.js');
    const { importImageFiles } = await import('../image-entities.js');
    const { stillHash } = await import('../image-identity.js');
    const { getImages } = await import('../util.js');
    const { removeImageMetadataFiles } = await import('../background-folders.js');

    const root = path.join(options.dataRoot, options.handle);
    const storeDir = path.join(root, STORE_DIR);
    /** @type {import('../users.js').UserDirectoryList} */
    const directories = /** @type {any} */ (Object.fromEntries(Object.entries(USER_DIRECTORY_TEMPLATE).map(([k, v]) => [k, path.join(root, v)])));
    log(`${LOG_PREFIX} ${options.apply ? 'apply' : 'dry run'} for ${root}`);
    if (!fs.existsSync(storeDir)) {
        warnLine(`${LOG_PREFIX} REFUSED: ${storeDir} doesn't exist`);
        return 1;
    }
    const probe = await probeServer();
    probe.lines.forEach(line => log(`${LOG_PREFIX} ${line}`));
    if (probe.running) {
        warnLine(`${LOG_PREFIX} REFUSED: the server appears to be running (or the port could not be checked); stop it and rerun`);
        return 1;
    }

    const lib = await LibraryEngine.open(await options.engine(), storeDir);
    try {
        await lib.store.ready();
        /** @type {{ id: bigint, key: string }[]} */
        const unhashed = [];
        /** @type {string | null} */
        let after = null;
        for (;;) {
            const { entities, more } = await lib.store.libraryOfType(TYPE.character, after, PAGE);
            const stored = await lib.entities(entities.map((/** @type {{ id: bigint }} */ e) => e.id));
            for (const e of stored) {
                if (e && !e.hashes.some(h => h.which === HASH.avatarIdentity)) unhashed.push({ id: e.id, key: e.key });
            }
            if (!more || entities.length === 0) break;
            after = entities[entities.length - 1].key;
        }
        const withFile = unhashed.filter(c => fs.existsSync(path.join(directories.characters, c.key)));
        log(`${LOG_PREFIX} characters without an image hash: ${unhashed.length}, ${withFile.length} of them with an image file`);
        const missing = async (/** @type {string} */ dir, /** @type {number} */ type) => {
            const files = fs.existsSync(dir) ? getImages(dir) : [];
            const ids = files.length ? await lib.ids(type, files) : [];
            return files.filter((_, i) => ids[i] === null);
        };
        log(`${LOG_PREFIX} backgrounds not in the store: ${(await missing(directories.backgrounds, TYPE.background)).length}`);
        log(`${LOG_PREFIX} persona images not in the store: ${(await missing(directories.avatars, TYPE.personaImage)).length}`);
        const named = NAMED_THUMBNAILS.filter(d => fs.existsSync(path.join(root, d)));
        log(`${LOG_PREFIX} thumbnail folders kept by file name: ${named.length ? named.join(', ') : 'none'}`);
        if (!options.apply) {
            log(`${LOG_PREFIX} dry run done; nothing was written`);
            return 0;
        }

        for (const c of withFile) {
            const hex = stillHash(await fs.promises.readFile(path.join(directories.characters, c.key)));
            await lib.store.commit([{ kind: 'cardHash', entity: c.id, which: HASH.avatarIdentity, hash: Buffer.from(hex, 'hex') }]);
        }
        const images = await importImageFiles(lib, directories);
        log(`${LOG_PREFIX} written: ${withFile.length} character image hash(es), ${images.backgrounds} background(s), ${images.personas} persona image(s)`);
        for (const f of images.failed) warnLine(`${LOG_PREFIX} NOT AN IMAGE (left out): ${f.file}: ${f.why}`);

        const left = [
            ...(await missing(directories.backgrounds, TYPE.background)).map(f => `backgrounds/${f}`),
            ...(await missing(directories.avatars, TYPE.personaImage)).map(f => `User Avatars/${f}`),
        ].filter(f => !images.failed.some(x => x.file.endsWith(f)));
        if (left.length) {
            warnLine(`${LOG_PREFIX} FAILED: ${left.length} image(s) still not in the store: ${left.slice(0, 20).join(', ')}`);
            return 1;
        }
        for (const d of named) fs.rmSync(path.join(root, d), { recursive: true, force: true });
        removeImageMetadataFiles(root);
        log(`${LOG_PREFIX} removed the thumbnail folders kept by file name and the per-image metadata files`);
    } finally {
        await lib.close();
    }
    log(`${LOG_PREFIX} done`);
    return 0;
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
    const out = { dataRoot: './data', handle: 'default-user', config: './config.yaml', dryRun: false, apply: false, unknown: /** @type {string[]} */ ([]) };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--dry-run') out.dryRun = true;
        else if (arg === '--apply') out.apply = true;
        else if ((arg === '--data-root' || arg === '--handle' || arg === '--config') && argv[i + 1] !== undefined) {
            out[/** @type {'dataRoot' | 'handle' | 'config'} */ ({ '--data-root': 'dataRoot', '--handle': 'handle', '--config': 'config' }[arg])] = argv[++i];
        } else out.unknown.push(arg);
    }
    return out;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
    const args = parseArgs(process.argv.slice(2));
    if (args.unknown.length > 0 || args.dryRun === args.apply) {
        console.warn(`${LOG_PREFIX} usage: --dry-run | --apply  [--data-root ./data] [--handle default-user] [--config ./config.yaml]`);
        process.exitCode = 2;
    } else {
        setConfigFilePath(args.config);
        await import('../fetch-patch.js');
        process.exitCode = await runMigration({
            ...args,
            engine: async () => {
                const { ensureEngine } = await import('../../engine/fetch.js');
                await ensureEngine();
                const { loadEngine } = await import('../../engine/load.js');
                return loadEngine().binding;
            },
        });
    }
}
