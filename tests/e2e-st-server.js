import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
 * Starts this checkout's server.js on the given data root and resolves once it answers HTTP.
 * @param {string} dataRoot
 * @returns {Promise<{ baseURL: string, stop: () => Promise<void> }>}
 */
export async function startServer(dataRoot) {
    const port = await getFreePort();
    const server = spawn(process.execPath, [
        'server.js',
        '--dataRoot', dataRoot,
        '--configPath', path.join(dataRoot, 'config.yaml'),
        '--globalExtensionsPath', path.join(dataRoot, 'global-extensions'),
        '--port', String(port),
        '--listen', 'false',
        '--browserLaunchEnabled', 'false',
    ], { cwd: repoRoot, stdio: 'inherit' });
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
