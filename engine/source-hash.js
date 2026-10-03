import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ENGINE_DIR = import.meta.dirname;
export const DIST_DIR = path.join(ENGINE_DIR, 'dist');

// Every input that changes what the build produces. CI keys the release by this same hash, so it must come
// out identical on every checkout: paths are sorted and '/'-separated, and CRLF is read as LF (a Windows
// checkout with autocrlf, or a zip download, has CRLF where CI's checkout has LF).
const INPUT_FILES = ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'build.rs', 'targets.json', 'package.json', 'package-lock.json'];
const INPUT_DIRS = ['src'];

/**
 * @param {string} dir Directory relative to the engine directory
 * @returns {string[]} Every file under it, relative to the engine directory, '/'-separated
 */
function listFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(path.join(ENGINE_DIR, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) out.push(...listFiles(rel));
        else if (entry.isFile()) out.push(rel);
    }
    return out;
}

/**
 * @returns {string} The full sha256 hex of the crate's build inputs
 */
export function sourceHash() {
    const files = [...INPUT_FILES, ...INPUT_DIRS.flatMap(listFiles)].sort();
    const hash = crypto.createHash('sha256');
    for (const file of files) {
        const content = Buffer.from(fs.readFileSync(path.join(ENGINE_DIR, file), 'latin1').replaceAll('\r\n', '\n'), 'latin1');
        hash.update(`${file}\0${content.length}\0`);
        hash.update(content);
    }
    return hash.digest('hex');
}

/**
 * @returns {string} The release key: the first 16 hex of the source hash
 */
export function sourceKey() {
    return sourceHash().slice(0, 16);
}
