import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';

if (process.env.PLAYWRIGHT_CHROME_PATH) {
    test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROME_PATH } });
}

/**
 * Fakes both migration-notice routes: the list answers `notices`, and each seen request's JSON body is recorded.
 * @param {import('@playwright/test').Page} page
 * @param {any[]} notices
 * @returns {Promise<any[]>} The recorded seen-request bodies, filled in as requests arrive.
 */
async function fakeNoticeRoutes(page, notices) {
    const seenBodies = [];
    await page.route('**/api/migrations/notices', route => route.fulfill({ json: { notices } }));
    await page.route('**/api/migrations/notices/seen', route => {
        seenBodies.push(route.request().postDataJSON());
        return route.fulfill({ json: { cleared: true } });
    });
    return seenBodies;
}

/** @param {import('@playwright/test').Page} page */
const noticeToast = page => page.locator('#toast-container .toast', { has: page.locator('.toast-title', { hasText: 'Embedded lorebook migration' }) });

test.describe('boot-migration notice', () => {
    test('a stored notice shows as a warning that stays until dismissed, and dismissing it marks it seen', async ({ page }) => {
        await page.clock.install();
        const seenBodies = await fakeNoticeRoutes(page, [{
            id: 'unimport-embedded-lore',
            version: 7,
            failing: { total: 1, entries: [{ avatar: 'b.png', world: 'Bob Lore', name: 'Bob' }] },
            skipped: {
                total: 23,
                entries: Array.from({ length: 20 }, (_, i) => ({ avatar: `g${i}.png`, world: `Lost ${i}`, reason: 'world-unreadable', name: `Ghost ${i}` })),
            },
            undone: { total: 2, entries: [{ avatar: 'u.png', world: 'Una Lore', name: 'Una' }, { avatar: 'v.png', world: 'Vic Lore', name: 'Vic' }] },
            noWorld: { total: 2538, entries: [{ avatar: 'n.png', world: 'Nowhere', reason: 'world-missing', name: 'Nomad' }] },
            hasReport: true,
        }]);
        await testSetup.awaitST({ page });
        const toast = noticeToast(page);

        await expect(toast).toBeVisible();
        await expect(toast).toContainText('1 character(s) couldn\'t be updated. This is retried on the next server start:');
        await expect(toast).toContainText('Bob');
        await expect(toast).toContainText('Nothing was lost.');
        await expect(toast).toContainText('23 character(s) couldn\'t be checked, so they were left exactly as they were:');
        await expect(toast).toContainText('Ghost 0: its lorebook Lost 0 couldn\'t be read');
        await expect(toast).toContainText('Ghost 18');
        await expect(toast).toContainText('and 4 more.');
        await expect(toast).toContainText('2 character(s) use their own embedded lorebook again, instead of the separate lorebook file it had been copied into:');
        // The 20 names one notice shows are already used by the cards above, so these two are only counted.
        await expect(toast).toContainText('copied into:and 2 more.');
        await expect(toast).not.toContainText('2538');
        await expect(toast).not.toContainText('Nomad');
        await expect(toast.locator('a', { hasText: 'Download the full list' })).toHaveAttribute('href', '/api/migrations/report/unimport-embedded-lore');
        await expect(toast).not.toContainText('Ghost 19');
        await expect(toast).not.toContainText('server console');

        await page.clock.runFor(60000);
        await expect(toast).toBeVisible();
        expect(seenBodies).toEqual([]);

        await toast.locator('.toast-close-button').click();
        await expect.poll(() => seenBodies).toEqual([{ id: 'unimport-embedded-lore', version: 7 }]);
        await expect.poll(async () => {
            await page.clock.runFor(2000);
            return toast.count();
        }).toBe(0);
    });

    test('clicking the warning marks it seen too', async ({ page }) => {
        const seenBodies = await fakeNoticeRoutes(page, [{
            id: 'unimport-embedded-lore',
            version: 3,
            failing: { total: 0, entries: [] },
            skipped: { total: 1, entries: [{ avatar: 'g.png', world: 'Lost', reason: 'world-unreadable', name: 'Ghost' }] },
        }]);
        await testSetup.awaitST({ page });
        const toast = noticeToast(page);

        await expect(toast).toBeVisible();
        await toast.locator('.toast-message').click();
        await expect.poll(() => seenBodies).toEqual([{ id: 'unimport-embedded-lore', version: 3 }]);
    });

    test('names and lorebook names are shown as text', async ({ page }) => {
        await fakeNoticeRoutes(page, [{
            id: 'unimport-embedded-lore',
            version: 1,
            failing: { total: 0, entries: [] },
            skipped: { total: 1, entries: [{ avatar: 'x.png', world: '<i>W</i>', reason: 'world-unreadable', name: '<b>Bold</b>' }] },
        }]);
        await testSetup.awaitST({ page });
        const toast = noticeToast(page);

        await expect(toast).toContainText('<b>Bold</b>: its lorebook <i>W</i> couldn\'t be read');
        await expect(toast.locator('.toast-message b, .toast-message i')).toHaveCount(0);
    });

    test('no notice, no warning', async ({ page }) => {
        const seenBodies = await fakeNoticeRoutes(page, []);
        const noticesResponse = page.waitForResponse('**/api/migrations/notices');
        await testSetup.awaitST({ page });
        await noticesResponse;

        await expect(noticeToast(page)).toHaveCount(0);
        expect(seenBodies).toEqual([]);
    });
});
