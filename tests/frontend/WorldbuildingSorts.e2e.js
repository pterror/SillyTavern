import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { openWorld } from './worlds.js';

const NAME = 'Sorted World';
const COUNT = 240;
const WORDS = ['ash', 'Birch', 'cedar', 'Dune', 'elm', 'Fern', 'gorse', 'Heath', 'iris', 'Juniper'];

// Titles, depths and priorities that don't follow the world's order; some entries off, some always in.
const entries = Object.fromEntries(Array.from({ length: COUNT }, (_, i) => [i, {
    uid: i,
    key: [`k${i}`],
    keysecondary: [],
    comment: `${WORDS[(i * 7) % WORDS.length]} ${String((i * 37) % COUNT).padStart(3, '0')}`,
    content: `Entry ${i}.`,
    constant: i % 9 === 4,
    selective: true,
    order: 100,
    position: 0,
    depth: (i * 13) % 17,
    disable: i % 8 === 3,
    probability: 100,
    useProbability: true,
    displayIndex: i,
}]));
const VIEW = { id: 'all', name: 'All', groupBy: null, drawing: 'cards', fields: [], query: '', chips: [], columns: [], rows: [] };

test.use({ freshAccount: true, upstreamFiles: { [`worlds/${NAME}.json`]: JSON.stringify({ entries, views: [VIEW] }) } });

const pane = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#Worldbuilding');
const shownTitles = async (/** @type {import('@playwright/test').Page} */ page, /** @type {number} */ first) =>
    (await pane(page).locator('.wb-top > .wb-top-cell').evaluateAll(
        (cells, first) => cells.slice(0, first).map(cell => cell.getAttribute('data-name') ?? ''), first));

const byTitle = (/** @type {any} */ a, /** @type {any} */ b) =>
    a.comment.toLowerCase().localeCompare(b.comment.toLowerCase()) || b.order - a.order || a.uid - b.uid;
const byDepth = (/** @type {any} */ a, /** @type {any} */ b) => a.depth - b.depth || b.order - a.order || a.uid - b.uid;
const priority = (/** @type {any} */ e) => (e.disable ? 2 : e.constant ? 0 : 1);
const byPriority = (/** @type {any} */ a, /** @type {any} */ b) => priority(a) - priority(b) || b.order - a.order || a.uid - b.uid;
const titlesBy = (/** @type {(a: any, b: any) => number} */ sort) => Object.values(entries).sort(sort).map(e => e.comment);

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} uid
 */
async function storedOrder(page, uid) {
    return page.evaluate(async ({ name, uid }) => {
        const { getRequestHeaders } = await import('/scripts/request-headers.js');
        const read = await fetch('/api/worldinfo/entry/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name, uid }) });
        return (await read.json()).entry.order;
    }, { name: NAME, uid });
}

test.describe('sorting a world', () => {
    test.beforeEach(async ({ page }) => {
        // The account is the worker's: only its first page shows the onboarding.
        await page.goto('/');
        const onboarding = page.locator('dialog[open] .onboarding');
        if (await onboarding.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
            await testSetup.awaitFreshST({ page });
        } else {
            await testSetup.awaitST({ page });
        }
    });

    test('the Sort control lists every entry by a field, both ways, and Apply as Order writes that order', async ({ page }) => {
        test.setTimeout(120_000);
        await openWorld(page, NAME);
        const order = pane(page).getByRole('combobox', { name: 'Sort', exact: true });

        await order.selectOption({ label: 'Title A-Z' });
        await expect.poll(() => shownTitles(page, 12)).toEqual(titlesBy(byTitle).slice(0, 12));
        await order.selectOption({ label: 'Title Z-A' });
        await expect.poll(() => shownTitles(page, 12)).toEqual(titlesBy(byTitle).reverse().slice(0, 12));
        await order.selectOption({ label: 'Depth ↗' });
        await expect.poll(() => shownTitles(page, 12)).toEqual(titlesBy(byDepth).slice(0, 12));
        await order.selectOption({ label: 'Priority' });
        await expect.poll(() => shownTitles(page, 12)).toEqual(titlesBy(byPriority).slice(0, 12));

        await order.selectOption({ label: 'Title A-Z' });
        await expect.poll(() => shownTitles(page, 3)).toEqual(titlesBy(byTitle).slice(0, 3));
        await pane(page).getByRole('button', { name: 'Apply as Order' }).click();
        const dialog = page.locator('dialog[open]');
        await dialog.getByLabel('Starting value').fill('500');
        await dialog.getByLabel('Step').fill('2');
        await dialog.locator('.popup-button-ok').click();
        const sorted = Object.values(entries).sort(byTitle);
        await expect.poll(() => storedOrder(page, sorted[0].uid)).toBe(500);
        expect(await storedOrder(page, sorted[1].uid)).toBe(498);
        expect(await storedOrder(page, sorted[COUNT - 1].uid)).toBe(500 - 2 * (COUNT - 1));

        await order.selectOption({ label: 'Order ↘' });
        await expect.poll(() => shownTitles(page, 12)).toEqual(sorted.slice(0, 12).map(e => e.comment));
    });

    test('in the world order, a top-level card is dragged to another place, and a row by its grip', async ({ page }) => {
        test.setTimeout(120_000);
        await openWorld(page, NAME);
        const cells = pane(page).locator('.wb-top > .wb-top-cell');
        await expect(cells.nth(3)).toBeVisible();
        const first = await shownTitles(page, 4);
        const moving = cells.nth(3);
        const target = cells.nth(0);
        const [from, to] = [await moving.boundingBox(), await target.boundingBox()];
        if (!from || !to) throw new Error('no boxes');
        await page.mouse.move(from.x + 40, from.y + 20);
        await page.mouse.down();
        await page.mouse.move(from.x + 60, from.y + 30, { steps: 4 });
        await page.mouse.move(to.x + 10, to.y + to.height / 2, { steps: 8 });
        await expect(page.locator('.wb-intent')).toContainText('World order');
        await page.mouse.up();
        await expect.poll(() => shownTitles(page, 4)).toEqual([first[3], first[0], first[1], first[2]]);
        await page.reload();
        await testSetup.awaitST({ page });
        await openWorld(page, NAME);
        await expect.poll(() => shownTitles(page, 4)).toEqual([first[3], first[0], first[1], first[2]]);

        await pane(page).locator('.wb-vseg').getByText('Rows', { exact: true }).click();
        const rows = pane(page).locator('.wb-trs > .wb-top-row');
        await expect(rows.first()).toBeVisible();
        const rowNames = async () => rows.evaluateAll(list => list.slice(0, 3).map(row => row.getAttribute('data-name')));
        const before = await rowNames();
        const grip = rows.nth(2).locator('.wb-grip');
        const gripBox = await grip.boundingBox();
        const top = await rows.nth(0).boundingBox();
        if (!gripBox || !top) throw new Error('no boxes');
        await page.mouse.move(gripBox.x + 3, gripBox.y + 3);
        await page.mouse.down();
        await page.mouse.move(gripBox.x + 3, gripBox.y - 10, { steps: 4 });
        await page.mouse.move(top.x + 200, top.y + 5, { steps: 8 });
        await page.mouse.up();
        await expect.poll(rowNames).toEqual([before[2], before[0], before[1]]);
    });
});
