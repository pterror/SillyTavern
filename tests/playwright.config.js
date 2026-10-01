import { defineConfig } from '@playwright/test';
import { openRunRoot } from './util/temp-run-root.js';

// Playwright loads this config again in every worker. The run root is opened once in the runner process
// and reaches the workers and their servers through the environment they inherit (TMPDIR points into it
// too); each worker makes its own data root under it (see frontend/fixtures.js). e2e-reporter.js removes it.
process.env.ST_E2E_RUN_ROOT = openRunRoot('e2e');

export default defineConfig({
    testMatch: '*.e2e.js',
    globalSetup: './e2e-global-setup.js',
    use: {
        video: 'only-on-failure',
        screenshot: 'only-on-failure',
    },
    workers: 8,
    fullyParallel: true,
    reporter: [[process.env.CI ? 'dot' : 'list'], ['./e2e-reporter.js']],
});
