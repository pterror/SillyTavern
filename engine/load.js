import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { DIST_DIR, sourceKey } from './source-hash.js';
import { currentPlatform, nativeFileName, wasmFileName } from './platform.js';
import { instantiateWasmBinding } from './wasm.js';

export class EngineLoadError extends Error {}

/** @type {{ kind: 'native'|'wasm', file: string, binding: any }|null} */
let loaded = null;

/**
 * @param {object} [options]
 * @param {string|null} [options.platform]
 * @param {string} [options.distDir]
 * @returns {{ kind: 'native'|'wasm', file: string, binding: any }}
 */
export function loadEngine({ platform = currentPlatform(), distDir = DIST_DIR } = {}) {
    const override = process.env.ST_ENGINE_PATH;
    if (override) {
        if (!fs.existsSync(override)) throw new EngineLoadError(`ST_ENGINE_PATH names no file: ${override}`);
        loaded = override.endsWith('.wasm')
            ? { kind: 'wasm', file: override, binding: instantiateWasmBinding(override) }
            : { kind: 'native', file: override, binding: createRequire(import.meta.url)(override) };
        return loaded;
    }
    const key = sourceKey();
    const native = platform ? path.join(distDir, nativeFileName(key, platform)) : null;
    const wasm = path.join(distDir, wasmFileName(key));
    if (native && fs.existsSync(native)) {
        loaded = { kind: 'native', file: native, binding: createRequire(import.meta.url)(native) };
    } else if (fs.existsSync(wasm)) {
        loaded = { kind: 'wasm', file: wasm, binding: instantiateWasmBinding(wasm) };
    } else {
        throw new EngineLoadError(`No engine build for source hash ${key} in ${distDir}.`);
    }
    return loaded;
}

/**
 * @returns {any}
 */
export function getEngine() {
    if (!loaded) throw new EngineLoadError('The engine is not loaded.');
    return loaded.binding;
}
