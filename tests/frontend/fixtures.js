import fs from 'node:fs';
import path from 'node:path';
import { test as base, expect } from '@playwright/test';
import { startServer } from '../e2e-st-server.js';
import { FAILED_MARKER, WORKER_DONE_MARKER } from '../e2e-run-root.js';
import { installTestContext } from './test-context.js';

/**
 * @param {import('@playwright/test').Page} page
 */
function awaitTestContextOnNavigation(page) {
    for (const name of /** @type {const} */ (['goto', 'reload'])) {
        const navigate = page[name].bind(page);
        page[name] = async (...args) => {
            const response = await navigate(...args);
            await page.waitForFunction(() => !window['stTest'] || window['stTest'].ready());
            return response;
        };
    }
}

/** @type {WeakSet<import('@playwright/test').BrowserContext>} */
const installedContexts = new WeakSet();

/** @param {import('@playwright/test').BrowserContext} context */
async function installInContext(context) {
    if (installedContexts.has(context)) return;
    installedContexts.add(context);
    await context.addInitScript(installTestContext);
    context.pages().forEach(awaitTestContextOnNavigation);
    context.on('page', awaitTestContextOnNavigation);
}

/**
 * @param {import('@playwright/test').Browser} browser
 * @returns {import('@playwright/test').Browser}
 */
function installInBrowser(browser) {
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (options) => {
        const context = await newContext(options);
        await installInContext(context);
        return context;
    };
    return browser;
}

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

    browser: [async ({ browser }, use) => {
        await use(installInBrowser(browser));
    }, { scope: 'worker' }],

    playwright: [async ({ playwright }, use) => {
        for (const type of [playwright.chromium, playwright.firefox, playwright.webkit]) {
            const launch = type.launch.bind(type);
            type.launch = async (options) => installInBrowser(await launch(options));
        }
        await use(playwright);
    }, { scope: 'worker' }],

    context: async ({ context }, use) => {
        await installInContext(context);
        await use(context);
    },
});

export { expect };
