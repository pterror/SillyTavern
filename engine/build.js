import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { DIST_DIR, ENGINE_DIR, sourceKey } from './source-hash.js';
import { TARGETS, currentPlatform, nativeFileName, wasmFileName } from './platform.js';

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
 * @returns {string}
 */
function libraryName(rustTarget) {
    if (rustTarget.includes('windows')) return 'st_engine.dll';
    if (rustTarget.includes('apple')) return 'libst_engine.dylib';
    return 'libst_engine.so';
}

/**
 * @param {object} [options]
 * @param {string|null} [options.platform]
 * @param {boolean} [options.wasm]
 * @param {string} [options.distDir]
 * @returns {string}
 */
export function buildEngine({ platform = null, wasm = false, distDir = DIST_DIR } = {}) {
    const key = sourceKey();
    let built;
    let name;
    if (wasm) {
        const target = TARGETS.wasm.rust;
        run('cargo', ['build', '--release', '--target', target], { EMNAPI_LINK_DIR: path.join(ENGINE_DIR, 'node_modules', 'emnapi', 'lib', target) });
        built = path.join(ENGINE_DIR, 'target', target, 'release', 'st_engine.wasm');
        name = wasmFileName(key);
    } else if (platform) {
        const target = TARGETS.native.find(t => t.platform === platform);
        if (!target) throw new Error(`No platform ${platform} in targets.json`);
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
        const host = currentPlatform();
        if (!host) throw new Error(`No native target in targets.json for ${process.platform}-${process.arch}; build --wasm`);
        const rustTarget = TARGETS.native.find(t => t.platform === host).rust;
        run('cargo', ['build', '--release']);
        built = path.join(ENGINE_DIR, 'target', 'release', libraryName(rustTarget));
        name = nativeFileName(key, host);
    }

    fs.mkdirSync(distDir, { recursive: true });
    const out = path.join(distDir, name);
    const tmp = `${out}.${process.pid}.tmp`;
    fs.copyFileSync(built, tmp);
    fs.renameSync(tmp, out);
    return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
    const { values } = parseArgs({ options: { platform: { type: 'string' }, wasm: { type: 'boolean' } } });
    console.log(buildEngine({ platform: values.platform ?? null, wasm: values.wasm ?? false }));
}
