import fs from 'node:fs';
import path from 'node:path';
import { test as base, expect } from '@playwright/test';
import { startServer } from '../e2e-st-server.js';
import { FAILED_MARKER, WORKER_DONE_MARKER } from '../e2e-run-root.js';

export const test = base.extend({
    freshAccount: [false, { scope: 'worker', option: true }],

    stServer: [async ({ freshAccount }, use) => {
        const runRoot = process.env.ST_E2E_RUN_ROOT;
        if (!runRoot) {
            throw new Error('ST_E2E_RUN_ROOT must be set (by playwright.config.js)');
        }
        const seedRoot = path.join(runRoot, 'seed');
        const dataRoot = fs.mkdtempSync(path.join(runRoot, 'worker-'));
        if (!freshAccount) {
            fs.cpSync(seedRoot, dataRoot, { recursive: true, preserveTimestamps: true });
        }

        const server = await startServer(dataRoot);
        try {
            await use({ baseURL: server.baseURL, dataRoot });
        } finally {
            await server.stop();
        }
        fs.writeFileSync(path.join(dataRoot, WORKER_DONE_MARKER), '');
    }, { scope: 'worker', auto: true, timeout: 180000 }],

    failureMarker: [async ({ stServer }, use, testInfo) => {
        await use(undefined);
        if (testInfo.status !== testInfo.expectedStatus) {
            fs.appendFileSync(path.join(stServer.dataRoot, FAILED_MARKER), `${testInfo.titlePath.join(' > ')} (${testInfo.status})\n`);
        }
    }, { auto: true }],

    baseURL: async ({ stServer }, use) => {
        await use(stServer.baseURL);
    },
});

export { expect };
