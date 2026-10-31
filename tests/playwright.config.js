import { defineConfig } from '@playwright/test';
import { openRunRoot } from './util/temp-run-root.js';
import { closeE2ERunRootOnExit } from './e2e-run-root.js';

const openedHere = !process.env.ST_TEST_RUN_ROOT;
process.env.ST_E2E_RUN_ROOT = openRunRoot('e2e');
if (openedHere) {
    closeE2ERunRootOnExit(process.env.ST_E2E_RUN_ROOT);
}

export default defineConfig({
    testMatch: '*.e2e.js',
    globalSetup: './e2e-global-setup.js',
    use: {
        video: 'only-on-failure',
        screenshot: 'only-on-failure',
    },
    workers: 8,
    fullyParallel: true,
    reporter: process.env.CI ? 'dot' : 'list',
});
