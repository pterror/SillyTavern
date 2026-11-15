import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realTmpdir } from './util/temp-run-root.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The page build of the repo's own folder is the one a running server serves; a test server builds its own.
const uiDist = path.join(realTmpdir(), 'st-e2e-ui');
const loopbackOnly = path.join(path.dirname(fileURLToPath(import.meta.url)), 'e2e-loopback-only.js');

/**
 * @param {string} dataRoot
 * @returns {string} the file a test server writes each outgoing request it refused to (`e2e-loopback-only.js`)
 */
export function refusedLogOf(dataRoot) {
    return path.join(dataRoot, 'refused-outgoing.log');
}

/** @returns {Promise<number>} */
function getFreePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = /** @type {net.AddressInfo} */ (probe.address());
            probe.close(() => resolve(port));
        });
    });
}

/**
 * @returns {[string, string[]]}
 */
function pdeathPrefix() {
    if (process.platform === 'linux' && spawnSync('setpriv', ['--version'], { stdio: 'ignore' }).status === 0) {
        return ['setpriv', ['--pdeathsig', 'KILL', '--', process.execPath]];
    }
    return [process.execPath, []];
}

/**
 * @param {string} dataRoot
 * @returns {Promise<{ baseURL: string, stop: () => Promise<void> }>}
 */
export async function startServer(dataRoot) {
    const port = await getFreePort();
    const [command, prefix] = pdeathPrefix();
    const server = spawn(command, [
        ...prefix,
        '--import', pathToFileURL(loopbackOnly).href,
        'server.js',
        '--dataRoot', dataRoot,
        '--configPath', path.join(dataRoot, 'config.yaml'),
        '--port', String(port),
        '--listen', 'false',
        '--browserLaunchEnabled', 'false',
    ], { cwd: repoRoot, stdio: 'inherit', env: { ...process.env, ST_UI_DIST: uiDist, ST_E2E_REFUSED_LOG: refusedLogOf(dataRoot) } });
    const exited = new Promise(resolve => server.once('exit', resolve));
    const isRunning = () => server.exitCode === null && server.signalCode === null;
    const stop = async () => {
        if (isRunning()) {
            server.kill('SIGTERM');
        }
        await exited;
    };

    const baseURL = `http://127.0.0.1:${port}`;
    try {
        while (true) {
            if (!isRunning()) {
                throw new Error(`server.js exited before answering (code ${server.exitCode}, signal ${server.signalCode})`);
            }
            try {
                await fetch(`${baseURL}/`);
                break;
            } catch {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
    } catch (error) {
        await stop();
        throw error;
    }
    return { baseURL, stop };
}
