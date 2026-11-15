import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test as base, expect } from '@playwright/test';
import { refusedLogOf, startServer } from '../e2e-st-server.js';
import { leavesMachine } from '../e2e-loopback-only.js';
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

/** @type {string[]} what a page of this worker's test asked for past loopback, which the browser's proxy refused */
const refusedByPages = [];

/**
 * The proxy the browser sends everything but loopback to: it ends each connection unanswered
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
function refusingProxy() {
    const server = net.createServer(socket => socket.destroy());
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = /** @type {net.AddressInfo} */ (server.address());
            resolve({ port, close: () => new Promise(done => server.close(() => done(undefined))) });
        });
    });
}

/** @param {import('@playwright/test').BrowserContext} context */
async function installInContext(context) {
    if (installedContexts.has(context)) return;
    installedContexts.add(context);
    context.on('request', request => {
        if (leavesMachine(new URL(request.url()))) refusedByPages.push(request.url());
    });
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

/**
 * @typedef {object} PastLoopback what the test's page and server asked for past loopback, all of it refused; a test
 *   ends failed when any is left untaken
 * @property {() => string[]} take what was asked since the last take
 */

export const test = base.extend({
    freshAccount: [false, { scope: 'worker', option: true }],
    /** @type {[Record<string, string | Buffer> | null, any]} */
    upstreamFiles: [null, { scope: 'worker', option: true }],

    stServer: [async ({ freshAccount, upstreamFiles }, use) => {
        const runRoot = process.env.ST_E2E_RUN_ROOT;
        if (!runRoot) {
            throw new Error('ST_E2E_RUN_ROOT must be set (by playwright.config.js)');
        }
        const seedRoot = path.join(runRoot, 'seed');
        const dataRoot = fs.mkdtempSync(path.join(runRoot, 'worker-'));
        if (!freshAccount) {
            fs.cpSync(seedRoot, dataRoot, { recursive: true, preserveTimestamps: true });
        }
        if (upstreamFiles) {
            if (!freshAccount) throw new Error('upstreamFiles are imported only by a store made at the start: use them with freshAccount');
            for (const [file, content] of Object.entries(upstreamFiles)) {
                const at = path.join(dataRoot, 'default-user', file);
                fs.mkdirSync(path.dirname(at), { recursive: true });
                fs.writeFileSync(at, content);
            }
        }

        const server = await startServer(dataRoot);
        try {
            await use({ baseURL: server.baseURL, dataRoot });
        } finally {
            await server.stop();
        }
        fs.writeFileSync(path.join(dataRoot, WORKER_DONE_MARKER), '');
    }, { scope: 'worker', auto: true, timeout: 180000 }],

    launchOptions: [async ({ launchOptions }, use) => {
        const proxy = await refusingProxy();
        try {
            await use({
                ...launchOptions,
                proxy: { server: `http://127.0.0.1:${proxy.port}`, bypass: 'localhost,127.0.0.1,[::1]' },
                args: [...(launchOptions.args ?? []), '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]'],
            });
        } finally {
            await proxy.close();
        }
    }, { scope: 'worker' }],

    pastLoopback: [async ({ stServer }, use) => {
        const log = refusedLogOf(stServer.dataRoot);
        const sizeOf = () => (fs.existsSync(log) ? fs.statSync(log).size : 0);
        let from = sizeOf();
        refusedByPages.length = 0;
        const take = () => {
            const size = sizeOf();
            const byServer = size > from ? fs.readFileSync(log).subarray(from, size).toString().split('\n').filter(Boolean) : [];
            from = size;
            return [...refusedByPages.splice(0).map(url => `the page asked for ${url}`), ...byServer.map(target => `the server asked for ${target}`)];
        };
        await use({ take });
        const left = take();
        if (left.length) throw new Error(`The test reached past loopback, which the e2e harness refuses (\`e2e-loopback-only.js\`): ${left.join('; ')}`);
    }, { auto: true }],

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
