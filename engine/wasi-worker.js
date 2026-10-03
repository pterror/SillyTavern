// One wasm thread of the engine's wasm build (see wasm.js).

import { createRequire } from 'node:module';
import { parentPort, Worker } from 'node:worker_threads';
import fs from 'node:fs';

import { instantiateNapiModuleSync, MessageHandler, getDefaultContext } from '@napi-rs/wasm-runtime';

import { createWasi } from './wasm.js';

// emnapi's thread code is written for web workers.
parentPort.on('message', data => globalThis.onmessage({ data }));
Object.assign(globalThis, {
    self: globalThis,
    require: createRequire(import.meta.url),
    Worker,
    importScripts: file => (0, eval)(`${fs.readFileSync(file, 'utf8')}//# sourceURL=${file}`),
    postMessage: message => parentPort.postMessage(message),
});

const handler = new MessageHandler({
    onLoad({ wasmModule, wasmMemory }) {
        const wasi = createWasi();
        return instantiateNapiModuleSync(wasmModule, {
            childThread: true,
            wasi,
            context: getDefaultContext(),
            overwriteImports(importObject) {
                importObject.env = { ...importObject.env, ...importObject.napi, ...importObject.emnapi, memory: wasmMemory };
            },
        });
    },
});

globalThis.onmessage = event => handler.handle(event);
