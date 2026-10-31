import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { ENGINE_DIR } from './source-hash.js';

/**
 * @typedef {object} NativeTarget
 * @property {string} platform
 * @property {string} rust
 * @property {string} runner
 * @property {'cargo'|'zigbuild'|'android'} build
 * @property {string} [zigTarget]
 * @property {string} [ndkClang]
 * @property {string} [rustflags]
 * @property {boolean} [optional]
 */

/** @type {{ native: NativeTarget[], wasm: { rust: string, runner: string } }} */
export const TARGETS = JSON.parse(fs.readFileSync(path.join(ENGINE_DIR, 'targets.json'), 'utf8'));

/**
 * @returns {string|null}
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
 * @param {string} key
 * @param {string} platform
 * @returns {string}
 */
export function nativeFileName(key, platform) {
    return `st-engine-${key}-${platform}.node`;
}

/**
 * @param {string} key
 * @returns {string}
 */
export function wasmFileName(key) {
    return `st-engine-${key}-${TARGETS.wasm.rust}.wasm`;
}
