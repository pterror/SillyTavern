import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

// Playwright loads this config again in every worker. The data root and port are chosen once in
// the runner process and reach the workers through the environment they inherit.
if (!process.env.ST_E2E_DATA_ROOT) {
    process.env.ST_E2E_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'st-e2e-'));
}
if (!process.env.ST_E2E_PORT) {
    process.env.ST_E2E_PORT = String(await new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = /** @type {net.AddressInfo} */ (probe.address());
            probe.close(() => resolve(port));
        });
    }));
}

const baseURL = `http://127.0.0.1:${process.env.ST_E2E_PORT}`;

export default defineConfig({
    testMatch: '*.e2e.js',
    use: {
        baseURL,
        video: 'only-on-failure',
        screenshot: 'only-on-failure',
    },
    workers: 1,
    fullyParallel: true,
    reporter: [[process.env.CI ? 'dot' : 'list'], ['./e2e-reporter.js']],
    webServer: {
        command: 'node e2e-server.js',
        cwd: path.dirname(new URL(import.meta.url).pathname),
        url: `${baseURL}/`,
        reuseExistingServer: false,
        timeout: 180000,
        stdout: 'pipe',
        gracefulShutdown: { signal: 'SIGTERM', timeout: 30000 },
    },
});
