import { defineConfig } from '@playwright/test';
import { openRunRoot } from './util/temp-run-root.js';
import { closeE2ERunRootOnExit } from './e2e-run-root.js';

// Playwright loads this config again in every worker. The run root is opened once in the runner process
// and reaches the workers and their servers through the environment they inherit (TMPDIR points into it
// too); each worker makes its own data root under it (see frontend/fixtures.js). e2e-run-root.js removes it when the
// runner exits; only the process that opened it (the runner, which loads this first) removes it.
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
