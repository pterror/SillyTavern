import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

const BOOK_WRITE = /\/api\/worldinfo\/(entries\/apply|create)$/;

/**
 * @param {any} body
 */
const writesEntries = body => Array.isArray(body?.entries)
    ? body.entries.some(change => change.data != null)
    : Object.keys(body?.data?.entries ?? {}).length > 0;

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

const AFTER_DEBOUNCE_MS = 2000;

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} worldName
 */
async function createWorldWithEntry(page, worldName) {
    await page.evaluate(async (worldName) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders();
        const data = { entries: { 0: { uid: 0, key: ['old'], content: 'old book' } } };
        const response = await fetch('/api/worldinfo/create', { method: 'POST', headers, body: JSON.stringify({ name: worldName, data, unique: false, replace: true }) });
        if (!response.ok) throw new Error(`world create failed: ${response.status}`);
        const { updateWorldInfoList } = await import('./scripts/world-info.js');
        await updateWorldInfoList();
    }, worldName);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} worldName
 */
async function saveOldBookDebounced(page, worldName) {
    await page.evaluate(async (worldName) => {
        const { saveWorldInfo } = await import('./scripts/world-info.js');
        const data = { entries: { 0: { uid: 0, key: ['old'], content: 'old book, edited' } } };
        await saveWorldInfo(worldName, data, false);
    }, worldName);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} worldName
 */
async function deleteWorld(page, worldName) {
    await page.evaluate(async (worldName) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders();
        await fetch('/api/worldinfo/delete', { method: 'POST', headers, body: JSON.stringify({ name: worldName }) });
    }, worldName);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} worldName
 * @returns {Promise<any>}
 */
async function serverWorld(page, worldName) {
    return page.evaluate(async (worldName) => {
        // @ts-ignore
        const headers = stTest.context().getRequestHeaders();
        const list = await (await fetch('/api/settings/get', { method: 'POST', headers, body: '{}' })).json();
        if (!list.world_names?.includes(worldName)) return null;
        const response = await fetch('/api/worldinfo/get', { method: 'POST', headers, body: JSON.stringify({ name: worldName }) });
        return response.json();
    }, worldName);
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {'create'|'import'} how
 * @param {string} worldName
 * @returns {Promise<unknown>}
 */
async function overwriteWorld(page, how, worldName) {
    return page.evaluate(async ({ how, worldName }) => {
        const { createNewWorldInfo, importWorldInfo } = await import('./scripts/world-info.js');
        const { Popup, POPUP_RESULT } = await import('./scripts/popup.js');
        const originalConfirm = Popup.show.confirm;
        Popup.show.confirm = async () => POPUP_RESULT.AFFIRMATIVE;
        try {
            if (how === 'create') {
                return await createNewWorldInfo(worldName, { interactive: true });
            }
            const file = new File([JSON.stringify({ entries: {} })], `${worldName}.json`, { type: 'application/json' });
            return await importWorldInfo(file, { interactive: true });
        } finally {
            Popup.show.confirm = originalConfirm;
        }
    }, { how, worldName });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {'create'|'import'} how
 * @param {string} worldName
 * @param {string} newName
 * @returns {string[]}
 */
function recordRequests(page, how, worldName, newName) {
    /** @type {string[]} */
    const events = [];
    page.on('request', (request) => {
        const pathname = new URL(request.url()).pathname;
        if (pathname === '/api/worldinfo/import') {
            events.push('new book sent');
        } else if (BOOK_WRITE.test(pathname)) {
            const body = JSON.parse(request.postData() ?? '{}');
            if (body.name !== worldName && body.name !== newName) return;
            const isOld = writesEntries(body);
            events.push(isOld ? 'old save sent' : (how === 'create' ? 'new book sent' : 'empty save sent'));
        }
    });
    return events;
}

const droppedToast = (page, worldName) => page.locator('#toast-container .toast-warning .toast-message', { hasText: `Changes to lorebook ${worldName} made while it was being overwritten were not saved.` });

test.describe('overwriting a lorebook with a save of it pending', () => {
    test.beforeEach(testSetup.awaitST);

    for (const how of /** @type {const} */ (['create', 'import'])) {
        test(`${how}: a save pending before the overwrite is written before it, and never after the new contents`, async ({ page }) => {
            const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const worldName = `WI_OVERWRITE_PENDING_${how.toUpperCase()}_${s}`;
            const newName = worldName.toLowerCase();

            await createWorldWithEntry(page, worldName);
            try {
                const events = recordRequests(page, how, worldName, newName);
                await saveOldBookDebounced(page, worldName);
                expect(await overwriteWorld(page, how, newName)).toBeTruthy();
                // eslint-disable-next-line playwright/no-wait-for-timeout
                await page.waitForTimeout(AFTER_DEBOUNCE_MS);

                expect(events).toEqual(['old save sent', 'new book sent']);
                const book = await serverWorld(page, newName);
                expect(book).not.toBeNull();
                expect(Object.keys(book.entries ?? {})).toEqual([]);
                await expect(droppedToast(page, worldName)).toHaveCount(0);
            } finally {
                await deleteWorld(page, worldName);
                await deleteWorld(page, newName);
            }
        });

        test(`${how}: a save made while the overwrite is under way is dropped with a warning`, async ({ page }) => {
            const s = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
            const worldName = `WI_OVERWRITE_DURING_${how.toUpperCase()}_${s}`;
            const newName = worldName.toLowerCase();

            await createWorldWithEntry(page, worldName);
            try {
                const events = recordRequests(page, how, worldName, newName);
                const overwritePath = `**/api/worldinfo/${how}`;
                let releaseWrite = () => {};
                const writeReleased = new Promise(resolve => { releaseWrite = () => resolve(undefined); });
                let writeSeen = () => {};
                const writeArrived = new Promise(resolve => { writeSeen = () => resolve(undefined); });
                await page.route(overwritePath, async (route) => {
                    writeSeen();
                    await writeReleased;
                    await route.continue();
                });
                try {
                    const overwrite = overwriteWorld(page, how, newName);
                    await writeArrived;
                    await saveOldBookDebounced(page, worldName);
                    releaseWrite();
                    expect(await overwrite).toBeTruthy();
                } finally {
                    releaseWrite();
                    await page.unroute(overwritePath);
                }
                // eslint-disable-next-line playwright/no-wait-for-timeout
                await page.waitForTimeout(AFTER_DEBOUNCE_MS);

                expect(events).toEqual(['new book sent']);
                const book = await serverWorld(page, newName);
                expect(book).not.toBeNull();
                expect(Object.keys(book.entries ?? {})).toEqual([]);
                await expect(droppedToast(page, worldName)).toHaveCount(1);
                const cached = await page.evaluate(async (worldName) => {
                    const { loadWorldInfo } = await import('./scripts/world-info.js');
                    const data = await loadWorldInfo(worldName);
                    return Object.keys(data?.entries ?? {});
                }, worldName);
                expect(cached).toEqual([]);
            } finally {
                await deleteWorld(page, worldName);
                await deleteWorld(page, newName);
            }
        });
    }
});
