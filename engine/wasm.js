import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Worker } from 'node:worker_threads';

import { instantiateNapiModuleSync } from '@napi-rs/wasm-runtime';
import { createContext } from '@emnapi/runtime';

/**
 * @returns {import('node:wasi').WASI}
 */
export function createWasi() {
    const { WASI } = process.getBuiltinModule('node:wasi');
    const cwd = process.cwd();
    const root = path.parse(cwd).root;
    const hostRoot = process.platform === 'android' ? cwd : root;
    return new WASI({ version: 'preview1', env: process.env, preopens: { [root]: hostRoot, [hostRoot]: hostRoot } });
}

/**
 * @param {string} file
 * @returns {any}
 */
export function instantiateWasmBinding(file) {
    const memory = new WebAssembly.Memory({ initial: 4000, maximum: 65536, shared: true });
    const wasi = createWasi();
    const { napiModule } = instantiateNapiModuleSync(fs.readFileSync(file), {
        context: createContext(),
        asyncWorkPoolSize: 4,
        reuseWorker: true,
        wasi,
        onCreateWorker() {
            const worker = new Worker(new URL('./wasi-worker.js', import.meta.url), { env: process.env });
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
