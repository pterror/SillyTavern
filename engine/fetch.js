// Makes sure engine/dist/ has a build of this checkout's crate, downloading it from the crate's release if not.
// The server runs this before loading the engine; `node engine/fetch.js` runs it alone (the Docker image build
// does, so the image never fetches at start).

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { DIST_DIR, sourceKey } from './source-hash.js';
import { currentPlatform, nativeFileName, wasmFileName } from './platform.js';

export const RELEASE_BASE = 'https://github.com/pterror/SillyTavern/releases/download';

export class EngineFetchError extends Error {}

/**
 * @param {string} url
 * @returns {Promise<Buffer|null>} The body, or null on 404
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
 * Leaves engine/dist/ with a file for this checkout's source hash: the platform's native build if the release has
 * one, else the wasm build. Never a file of another hash.
 * @param {object} [options]
 * @param {string|null} [options.platform] targets.json native platform, or null to take the wasm
 * @param {string} [options.releaseBase] URL the `engine-<key>/<file>` paths are under
 * @param {string} [options.distDir]
 * @returns {Promise<string>} Path of the file in the dist directory
 */
export async function ensureEngine({ platform = currentPlatform(), releaseBase = RELEASE_BASE, distDir = DIST_DIR } = {}) {
    const key = sourceKey();
    const names = [...(platform ? [nativeFileName(key, platform)] : []), wasmFileName(key)];
    for (const name of names) {
        const file = path.join(distDir, name);
        if (fs.existsSync(file)) return file;
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
        return path.join(distDir, name);
    }
    throw new EngineFetchError(`The engine for source hash ${key} has no release yet (engine-${key}). Retry once CI has finished building it.`);
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
