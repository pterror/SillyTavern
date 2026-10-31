import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { DIST_DIR, sourceKey } from './source-hash.js';
import { currentPlatform, nativeFileName, wasmFileName } from './platform.js';
import { buildEngine } from './build.js';

export const RELEASE_BASE = 'https://github.com/pterror/SillyTavern/releases/download';

export class EngineFetchError extends Error {}

/**
 * @param {string} url
 * @returns {Promise<Buffer|null>}
 */
async function download(url) {
    const response = await fetch(url);
    if (response.status === 404) return null;
    if (!response.ok) throw new EngineFetchError(`${url}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
}

/**
 * @param {string} distDir
 * @param {string} name
 * @param {Buffer} data
 */
function writeDist(distDir, name, data) {
    fs.mkdirSync(distDir, { recursive: true });
    const tmp = path.join(distDir, `${name}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, path.join(distDir, name));
}

/**
 * @param {string} distDir
 * @param {string} key
 */
function removeOtherHashes(distDir, key) {
    for (const name of fs.readdirSync(distDir)) {
        const match = /^st-engine-([0-9a-f]{16})-/.exec(name);
        if (match && match[1] !== key) fs.rmSync(path.join(distDir, name));
    }
}

/**
 * @param {object} [options]
 * @param {string|null} [options.platform]
 * @param {string} [options.releaseBase]
 * @param {string} [options.distDir]
 * @returns {Promise<string>}
 */
export async function ensureEngine({ platform = currentPlatform(), releaseBase = RELEASE_BASE, distDir = DIST_DIR } = {}) {
    const key = sourceKey();
    const names = [...(platform ? [nativeFileName(key, platform)] : []), wasmFileName(key)];
    for (const name of names) {
        const file = path.join(distDir, name);
        if (fs.existsSync(file)) {
            removeOtherHashes(distDir, key);
            return file;
        }
    }
    for (const name of names) {
        const url = `${releaseBase}/engine-${key}/${name}`;
        let data;
        try {
            data = await download(url);
        } catch (error) {
            throw new EngineFetchError(`Could not download the engine for source hash ${key} (${error.message}).`, { cause: error });
        }
        if (!data) continue;
        writeDist(distDir, name, data);
        console.log(`Downloaded the engine for source hash ${key}: ${name}`);
        removeOtherHashes(distDir, key);
        return path.join(distDir, name);
    }
    const noRelease = `The engine for source hash ${key} has no release yet (engine-${key})`;
    if (!platform) {
        throw new EngineFetchError(`${noRelease}, and this machine has no native target to build here. Run \`node engine/build.js --wasm\` (after \`npm ci\` in engine/), or retry once CI has finished building it.`);
    }
    console.log(`${noRelease}; building it here with cargo. This can take a few minutes.`);
    let file;
    try {
        file = buildEngine({ platform: platform === currentPlatform() ? null : platform, distDir });
    } catch (error) {
        const why = error?.code === 'ENOENT' ? 'cargo was not found' : error.message;
        throw new EngineFetchError(`${noRelease}, and building it here failed (${why}). Install cargo and run \`node engine/build.js\`, or retry once CI has finished building it.`, { cause: error });
    }
    console.log(`Built the engine for source hash ${key}: ${path.basename(file)}`);
    removeOtherHashes(distDir, key);
    return file;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
    try {
        await ensureEngine();
    } catch (error) {
        if (!(error instanceof EngineFetchError)) throw error;
        console.error(error.message);
        process.exit(1);
    }
}
