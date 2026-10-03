// Builds st-engine into engine/dist/, named for this checkout's source hash.
//   node engine/build.js                       native, for this machine, with the host's cargo
//   node engine/build.js --platform <platform> native, for a targets.json platform, the way CI builds it
//   node engine/build.js --wasm                the wasm build (needs `npm ci` in engine/ first, for emnapi)
// Prints the path of the file it wrote.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { DIST_DIR, ENGINE_DIR, sourceKey } from './source-hash.js';
import { TARGETS, currentPlatform, nativeFileName, wasmFileName } from './platform.js';

const { values } = parseArgs({ options: { platform: { type: 'string' }, wasm: { type: 'boolean' } } });

/**
 * @param {string} command
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 */
function run(command, args, env = {}) {
    execFileSync(command, args, { cwd: ENGINE_DIR, stdio: 'inherit', env: { ...process.env, ...env } });
}

/**
 * @param {string} rustTarget
 * @returns {string} The cdylib's file name cargo gives it on that target
 */
function libraryName(rustTarget) {
    if (rustTarget.includes('windows')) return 'st_engine.dll';
    if (rustTarget.includes('apple')) return 'libst_engine.dylib';
    return 'libst_engine.so';
}

const key = sourceKey();
let built;
let name;
if (values.wasm) {
    const target = TARGETS.wasm.rust;
    run('cargo', ['build', '--release', '--target', target], { EMNAPI_LINK_DIR: path.join(ENGINE_DIR, 'node_modules', 'emnapi', 'lib', target) });
    built = path.join(ENGINE_DIR, 'target', target, 'release', 'st_engine.wasm');
    name = wasmFileName(key);
} else if (values.platform) {
    const target = TARGETS.native.find(t => t.platform === values.platform);
    if (!target) throw new Error(`No platform ${values.platform} in targets.json`);
    const env = target.rustflags ? { RUSTFLAGS: target.rustflags } : {};
    if (target.build === 'zigbuild') {
        run('cargo', ['zigbuild', '--release', '--target', target.zigTarget], env);
    } else if (target.build === 'android') {
        const ndk = process.env.ANDROID_NDK_LATEST_HOME || process.env.ANDROID_NDK_HOME;
        if (!ndk) throw new Error('Set ANDROID_NDK_HOME to the Android NDK');
        const linker = path.join(ndk, 'toolchains', 'llvm', 'prebuilt', 'linux-x86_64', 'bin', target.ndkClang);
        run('cargo', ['build', '--release', '--target', target.rust], { ...env, [`CARGO_TARGET_${target.rust.toUpperCase().replaceAll('-', '_')}_LINKER`]: linker });
    } else {
        run('cargo', ['build', '--release', '--target', target.rust], env);
    }
    built = path.join(ENGINE_DIR, 'target', target.rust, 'release', libraryName(target.rust));
    name = nativeFileName(key, target.platform);
} else {
    const platform = currentPlatform();
    if (!platform) throw new Error(`No native target in targets.json for ${process.platform}-${process.arch}; build --wasm`);
    const rustTarget = TARGETS.native.find(t => t.platform === platform).rust;
    run('cargo', ['build', '--release']);
    built = path.join(ENGINE_DIR, 'target', 'release', libraryName(rustTarget));
    name = nativeFileName(key, platform);
}

fs.mkdirSync(DIST_DIR, { recursive: true });
const out = path.join(DIST_DIR, name);
fs.copyFileSync(built, out);
console.log(out);
