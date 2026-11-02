import { defineConfig } from '@playwright/test';
import { openRunRoot } from './util/temp-run-root.js';
import { closeE2ERunRootOnExit } from './e2e-run-root.js';

const openedHere = !process.env.ST_TEST_RUN_ROOT;
process.env.ST_E2E_RUN_ROOT = openRunRoot('net');
if (openedHere) {
    closeE2ERunRootOnExit(process.env.ST_E2E_RUN_ROOT);
}

export default defineConfig({
    testDir: './network',
    testMatch: '*.net.js',
    globalSetup: './e2e-global-setup.js',
    workers: 1,
    fullyParallel: false,
    timeout: 240000,
    reporter: process.env.CI ? 'dot' : 'list',
});
