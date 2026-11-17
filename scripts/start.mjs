import { existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

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

const args = process.argv.slice(2);
const { values, tokens } = parseArgs({
    args,
    options: { update: { type: 'boolean' } },
    strict: false,
    allowPositionals: true,
    tokens: true,
});
if (values.update) {
    const updateIndices = new Set(tokens.filter(token => token.kind === 'option' && token.name === 'update').map(token => token.index));
    const serverArgs = args.filter((_, index) => !updateIndices.has(index));
    console.log('Updating SillyTavern...');
    const status = run('git', ['pull', '--rebase', '--autostash']);
    if (status !== 0) process.exit(status);
    // Run the updated launcher so startup uses the code just pulled.
    process.exit(run(process.execPath, ['scripts/start.mjs', ...serverArgs]));
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
process.exit(run(process.execPath, ['server.js', ...args]));
