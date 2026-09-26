// Builds the seed data root once per run: a server booted on it compiles the frontend webpack build, which
// every worker copies into its own data root (see frontend/fixtures.js) so its server's compile hits a warm cache.
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './e2e-st-server.js';

export default async function globalSetup() {
    const seedRoot = path.join(/** @type {string} */ (process.env.ST_E2E_RUN_ROOT), 'seed');
    fs.mkdirSync(seedRoot);
    const server = await startServer(seedRoot);
    await server.stop();
}
