import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Worker } from 'node:worker_threads';

import { instantiateNapiModuleSync } from '@napi-rs/wasm-runtime';
import { createContext } from '@emnapi/runtime';

/**
 * The WASI every wasm thread of the engine runs with (this one and wasi-worker.js's), all seeing the same files.
 * @returns {import('node:wasi').WASI}
 */
export function createWasi() {
    // Not imported at the top: importing node:wasi prints an experimental warning, and only the wasm build uses it.
    const { WASI } = process.getBuiltinModule('node:wasi');
    const cwd = process.cwd();
    const root = path.parse(cwd).root;
    // Termux can't open '/', so Android maps the root onto the working directory.
    const hostRoot = process.platform === 'android' ? cwd : root;
    return new WASI({ version: 'preview1', env: process.env, preopens: { [root]: hostRoot, [hostRoot]: hostRoot } });
}

/**
 * Instantiates the wasm32-wasip1-threads build of st-engine on its own threads (worker_threads running
 * wasi-worker.js).
 * @param {string} file Path of the .wasm
 * @returns {any} The binding's exports
 */
export function instantiateWasmBinding(file) {
    // Pages of 64 KiB. The module's own minimum (its 64 MB stack, set by napi-build's link args) fits in the
    // initial size; the maximum is the module's declared 4 GiB.
    const memory = new WebAssembly.Memory({ initial: 4000, maximum: 65536, shared: true });
    const wasi = createWasi();
    const { napiModule } = instantiateNapiModuleSync(fs.readFileSync(file), {
        context: createContext(),
        asyncWorkPoolSize: 4,
        reuseWorker: true,
        wasi,
        onCreateWorker() {
            const worker = new Worker(new URL('./wasi-worker.js', import.meta.url), { env: process.env });
            // Rust threads are never joined at exit, so their workers must not keep the process alive.
            worker.unref();
            return worker;
        },
        overwriteImports(importObject) {
            importObject.env = { ...importObject.env, ...importObject.napi, ...importObject.emnapi, memory };
            return importObject;
        },
        beforeInit({ instance }) {
            for (const name of Object.keys(instance.exports)) {
                if (name.startsWith('__napi_register__')) instance.exports[name]();
            }
        },
    });
    return napiModule.exports;
}
