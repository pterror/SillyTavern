// Builds the seed data root once per run: a server on it compiles the frontend webpack build, and a
// browser goes through the first-run dialog with the default name. Workers copy the seed into their own
// data roots (see frontend/fixtures.js), so their servers boot into a warm webpack cache and an account
// that has already been through the dialog.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { startServer } from './e2e-st-server.js';

export default async function globalSetup() {
    const seedRoot = path.join(/** @type {string} */ (process.env.ST_E2E_RUN_ROOT), 'seed');
    fs.mkdirSync(seedRoot);
    const server = await startServer(seedRoot);
    try {
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage({ baseURL: server.baseURL });
            await page.goto('/');
            await page.locator('dialog[open] .onboarding').waitFor({ state: 'visible' });
            const saved = page.waitForResponse(response => response.url().endsWith('/api/settings/save-partial')
                && response.ok()
                && Object.hasOwn(JSON.parse(response.request().postData() ?? '{}').keys ?? {}, 'firstRun'));
            await page.locator('dialog[open] .popup-button-ok').click();
            await saved;
        } finally {
            await browser.close();
        }
    } finally {
        await server.stop();
    }
}
