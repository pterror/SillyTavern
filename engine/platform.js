import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { ENGINE_DIR } from './source-hash.js';

/**
 * @typedef {object} NativeTarget
 * @property {string} platform Key this file is released under
 * @property {string} rust Rust target triple
 * @property {string} runner GitHub Actions runner it builds on
 * @property {'cargo'|'zigbuild'|'android'} build How it builds (engine/build.js)
 * @property {string} [zigTarget] cargo-zigbuild's target, with the glibc version for gnu
 * @property {string} [ndkClang] The NDK clang it links with
 * @property {string} [rustflags]
 * @property {boolean} [optional] Shipped only where it builds; a failed build doesn't hold back the release
 */

/** @type {{ native: NativeTarget[], wasm: { rust: string, runner: string } }} */
export const TARGETS = JSON.parse(fs.readFileSync(path.join(ENGINE_DIR, 'targets.json'), 'utf8'));

/**
 * @returns {string|null} This process's key in targets.json's native list, or null when it has none
 */
export function currentPlatform() {
    const { platform, arch } = process;
    let key;
    if (platform === 'linux') {
        // @ts-ignore - header is untyped
        const libc = process.report.getReport().header.glibcVersionRuntime ? 'gnu' : 'musl';
        key = arch === 'arm' ? `linux-arm-${libc}eabihf` : `linux-${arch}-${libc}`;
    } else if (platform === 'win32') {
        key = `win32-${arch}-msvc`;
    } else if (platform === 'android') {
        key = arch === 'arm' ? 'android-arm-eabi' : `android-${arch}`;
    } else {
        key = `${platform}-${arch}`;
    }
    return TARGETS.native.some(t => t.platform === key) ? key : null;
}

/**
 * @param {string} key Release key (16 hex)
 * @param {string} platform targets.json native platform
 * @returns {string} File name of that native build, in engine/dist/ and in the release
 */
export function nativeFileName(key, platform) {
    return `st-engine-${key}-${platform}.node`;
}

/**
 * @param {string} key Release key (16 hex)
 * @returns {string} File name of the wasm build, in engine/dist/ and in the release
 */
export function wasmFileName(key) {
    return `st-engine-${key}-${TARGETS.wasm.rust}.wasm`;
}
