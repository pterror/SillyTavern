import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

async function awaitAppReady(page) {
    await page.evaluate(() => new Promise(resolve => {
        const { eventSource, eventTypes } = window['SillyTavern'].getContext();
        eventSource.once(eventTypes.APP_READY, resolve);
    }));
}

/**
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<{network: string[], cached: number}>}
 */
async function loadAndRecord(page) {
    const session = await page.context().newCDPSession(page);
    await session.send('Network.enable');
    /** @type {Map<string, {url: string, cached: boolean}>} */
    const seen = new Map();
    session.on('Network.requestWillBeSent', event => {
        seen.set(event.requestId, { url: event.request.url, cached: false });
    });
    session.on('Network.requestServedFromCache', event => {
        const entry = seen.get(event.requestId);
        if (entry) entry.cached = true;
    });
    session.on('Network.responseReceived', event => {
        const entry = seen.get(event.requestId);
        if (entry && (event.response.fromDiskCache || event.response.fromMemoryCache)) entry.cached = true;
    });

    await page.goto('/');
    await awaitAppReady(page);
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await page.waitForTimeout(3000);
    await session.detach();

    const userData = /^\/(?:api|characters|backgrounds|thumbnail|User%20Avatars|user)(?:\/|$)/;
    const frontend = [...seen.values()].filter(({ url }) => {
        const { pathname } = new URL(url);
        return url.startsWith('http') && !userData.test(pathname) && !['/csrf-token', '/version', '/img/five.png', '/img/ai4.png'].includes(pathname);
    });
    return {
        network: frontend.filter(entry => !entry.cached).map(entry => new URL(entry.url).pathname + new URL(entry.url).search),
        cached: frontend.filter(entry => entry.cached).length,
    };
}

test.describe('frontend cache', () => {
    test.beforeEach(testSetup.awaitST);

    test('a warm load asks the server only for the page', async ({ page }) => {
        await awaitAppReady(page);
        await loadAndRecord(page);
        const second = await loadAndRecord(page);
        console.log(`[frontend-cache] warm load: ${second.network.length} frontend requests to the server, ${second.cached} from cache`);
        console.log(`[frontend-cache] went to the server: ${second.network.slice(0, 40).join(' ')}`);
        expect(second.network).toEqual(['/']);
    });

    test('a changed file is fetched on the next load, alone', async ({ page, stServer }) => {
        await awaitAppReady(page);
        await loadAndRecord(page);
        const userCss = path.join(stServer.dataRoot, '_css', 'user.css');
        fs.mkdirSync(path.dirname(userCss), { recursive: true });
        fs.writeFileSync(userCss, `/* ${Date.now()} */ body { --frontend-cache-probe: 1; }`);
        try {
            const next = await loadAndRecord(page);
            expect(next.network.map(url => url.split('?')[0])).toEqual(['/', '/css/user.css']);
            expect(next.network[1]).toMatch(/\?stv=/);
            expect(await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--frontend-cache-probe').trim())).toBe('1');
        } finally {
            fs.rmSync(userCss, { force: true });
        }
    });
});

test.describe('frontend cache and extensions', () => {
    /**
     * @param {string} dataRoot
     * @param {string} name
     * @returns {string}
     */
    function writeProbeExtension(dataRoot, name) {
        const directory = path.join(dataRoot, 'default-user', 'extensions', name);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'index.js'), [
            'import { eventSource } from \'../../../../script.js\';',
            'export const sameInstance = eventSource === window.SillyTavern.getContext().eventSource;',
            `export const written = ${Date.now()};`,
        ].join('\n'));
        return directory;
    }

    /**
     * @param {import('@playwright/test').Page} page
     * @param {string} name
     */
    function importProbe(page, name) {
        return page.evaluate(async url => {
            try {
                const module = await import(url);
                return { sameInstance: module.sameInstance, error: null };
            } catch (error) {
                return { sameInstance: null, error: String(error) };
            }
        }, `/scripts/extensions/third-party/${name}/index.js`);
    }

    const created = [];
    test.afterEach(() => {
        for (const directory of created.splice(0)) {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    test('an extension importing our modules by relative path gets the page\'s own copy, versioned or not', async ({ page, stServer }) => {
        created.push(writeProbeExtension(stServer.dataRoot, 'CacheProbeBefore'));
        await testSetup.awaitST({ page });
        await awaitAppReady(page);
        expect(await page.evaluate(() => JSON.parse(document.querySelector('script[type="importmap"]').textContent).imports['/scripts/extensions/third-party/CacheProbeBefore/index.js'])).toMatch(/\?stv=/);
        expect(await importProbe(page, 'CacheProbeBefore')).toEqual({ sameInstance: true, error: null });

        created.push(writeProbeExtension(stServer.dataRoot, 'CacheProbeAfter'));
        expect(await importProbe(page, 'CacheProbeAfter')).toEqual({ sameInstance: true, error: null });
    });

    test('a file changed under an open page fails to load instead of mixing versions, and the page asks for a reload', async ({ page, stServer }) => {
        const directory = writeProbeExtension(stServer.dataRoot, 'CacheProbeStale');
        created.push(directory);
        await testSetup.awaitST({ page });
        await awaitAppReady(page);
        await expect(page.locator('body')).not.toHaveAttribute('data-frontend-outdated', 'true');

        writeProbeExtension(stServer.dataRoot, 'CacheProbeStale');
        const later = new Date(Date.now() + 5000);
        fs.utimesSync(path.join(directory, 'index.js'), later, later);

        const result = await importProbe(page, 'CacheProbeStale');
        expect(result.sameInstance).toBeNull();
        await expect(page.locator('body')).toHaveAttribute('data-frontend-outdated', 'true');
        await expect(page.locator('#toast-container')).toContainText('SillyTavern was updated');
        expect(await page.locator('dialog[open]').count()).toBe(0);

        await page.locator('#toast-container .stReloadPage').click();
        await page.waitForLoadState('load');
        await awaitAppReady(page);
        expect(await importProbe(page, 'CacheProbeStale')).toEqual({ sameInstance: true, error: null });
    });
});
