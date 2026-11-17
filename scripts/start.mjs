import { existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
process.env.NODE_ENV = 'production';

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { stdio: 'inherit', ...options });
    if (result.error) console.error(result.error.message);
    if (result.signal) {
        process.kill(process.pid, result.signal);
        process.exit(1);
    }
    return result.status ?? 1;
}

function install(includeDev) {
    const args = ['install', '--frozen-lockfile', '--loglevel=error', includeDev ? '--prod=false' : '--prod'];
    // Only fixed install arguments go through cmd.exe; server arguments bypass the shell.
    const status = process.platform === 'win32'
        ? run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `scripts\\pnpm.cmd ${args.join(' ')}`])
        : run('bash', ['scripts/pnpm.sh', ...args]);
    if (status !== 0) process.exit(status);
}

// Remove npm-created installs before pnpm installs the workspace dependencies.
for (const modules of ['node_modules', 'engine/node_modules', 'tests/node_modules']) {
    if (existsSync(modules) && !existsSync(`${modules}/.modules.yaml`)) {
        rmSync(modules, { recursive: true, force: true });
    }
}

console.log('Installing Node Modules...');
// Preserve development tools explicitly installed in this checkout.
install(existsSync('node_modules/typescript') || existsSync('node_modules/eslint'));

if (process.platform !== 'win32' && run(process.execPath, ['src/probe-inotify-remastered-plus.js'], { stdio: 'ignore' }) !== 0) {
    console.warn("inotify-remastered-plus isn't built - the local-import directory scanner will fall back to its periodic backstop pass alone (no real-time inotify-queue-overflow detection). Building it needs a C/C++ compiler toolchain and Python 3; with them installed, delete node_modules and start again.");
}

if (run(process.execPath, ['scripts/build-ui.mjs', '--ensure']) !== 0) {
    console.log('Installing the tools to build the new page...');
    install(true);
    const status = run(process.execPath, ['scripts/build-ui.mjs', '--ensure']);
    if (status !== 0) {
        console.error('The new page could not be built; SillyTavern will not start without it.');
        process.exit(status);
    }
}

console.log('Entering SillyTavern...');
process.exit(run(process.execPath, ['server.js', ...process.argv.slice(2)]));
