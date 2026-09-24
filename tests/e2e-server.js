// Started by playwright.config.js's webServer: runs this checkout's server.js on the throwaway data root.
// Playwright SIGTERMs the whole process group on teardown; this process ignores it and exits only once
// server.js (which gets it too) has finished its own shutdown.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataRoot = process.env.ST_E2E_DATA_ROOT;
const port = process.env.ST_E2E_PORT;
if (!dataRoot || !port) {
    console.error('e2e-server.js: ST_E2E_DATA_ROOT and ST_E2E_PORT must be set (by playwright.config.js)');
    process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});

const server = spawn(process.execPath, [
    'server.js',
    '--dataRoot', dataRoot,
    '--configPath', path.join(dataRoot, 'config.yaml'),
    '--globalExtensionsPath', path.join(dataRoot, 'global-extensions'),
    '--port', port,
    '--listen', 'false',
    '--browserLaunchEnabled', 'false',
], { cwd: repoRoot, stdio: 'inherit' });

server.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
