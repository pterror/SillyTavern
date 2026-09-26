import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

// Playwright loads this config again in every worker. The run root is made once in the runner process
// and reaches the workers through the environment they inherit; each worker makes its own data root
// under it (see frontend/fixtures.js).
if (!process.env.ST_E2E_RUN_ROOT) {
    process.env.ST_E2E_RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'st-e2e-'));
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
    reporter: [[process.env.CI ? 'dot' : 'list'], ['./e2e-reporter.js']],
});
