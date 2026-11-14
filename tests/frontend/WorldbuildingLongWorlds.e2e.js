import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { openWorld } from './worlds.js';

/**
 * @param {number} count
 */
const world = (count) => JSON.stringify({
    entries: Object.fromEntries(Array.from({ length: count }, (_, i) => [i, {
        uid: i,
        key: [`thing${i}`],
        keysecondary: [],
        comment: `Entry ${i}`,
        content: `Entry ${i} is about thing ${i}.`,
        constant: false,
        selective: true,
        order: 100,
        position: 0,
        depth: 4,
        disable: i % 8 === 3,
        probability: 100,
        useProbability: true,
        displayIndex: i,
    }])),
});

test.use({
    freshAccount: true,
    upstreamFiles: { 'worlds/Twelve Hundred.json': world(1200), 'worlds/Three Thousand.json': world(3000) },
});

const pane = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#Worldbuilding .wb-pane');
const drawn = (/** @type {import('@playwright/test').Page} */ page) =>
    page.locator('#Worldbuilding .wb-top > .wb-top-cell, #Worldbuilding .wb-trs > .wb-top-row');

/**
 * Scrolls the pane to its end a screen at a time until `count` top-level entries are drawn, and checks at every step
 * that each entry drawn before is still drawn, at the same place, and that the ranks drawn run without a gap.
 * @param {import('@playwright/test').Page} page
 * @param {number} count
 */
async function scrollThrough(page, count) {
    /** @type {Map<string, number>} */
    const seen = new Map();
    // A pointer resting over the page would point at each card that scrolls under it.
    await page.mouse.move(0, 0);
    for (let step = 0; step < 4000; step++) {
        const now = await page.evaluate(() => {
            const scroller = /** @type {HTMLElement} */ (document.querySelector('#Worldbuilding .wb-pane'));
            const top = scroller.getBoundingClientRect().top - scroller.scrollTop;
            const bottom = scroller.scrollTop + scroller.clientHeight;
            return [...document.querySelectorAll('#Worldbuilding .wb-top > .wb-top-cell, #Worldbuilding .wb-trs > .wb-top-row')]
                .map(item => {
                    const at = Math.round(item.getBoundingClientRect().top - top);
                    return { rank: Number(/** @type {HTMLElement} */ (item).dataset['rank']), top: at, painted: at < bottom };
                });
        });
        expect(now.findIndex((item, at) => item.rank !== at)).toBe(-1);
        // Only what has been on screen is laid out at its own height; it stays where it was.
        const moved = [];
        for (const { rank, top, painted } of now) {
            const before = seen.get(String(rank));
            if (before !== undefined && before !== top) moved.push({ rank, from: before, to: top });
            else if (before === undefined && painted) seen.set(String(rank), top);
        }
        expect(moved).toEqual([]);
        const atEnd = await pane(page).evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 2);
        if (now.length === count && atEnd) return;
        await pane(page).evaluate(element => element.scrollBy(0, 2 * element.clientHeight));
        await page.waitForTimeout(50);
    }
    throw new Error(`the end of ${count} was never reached`);
}

test.describe('a long world is drawn whole as it is scrolled, and nothing drawn goes away', () => {
    test.setTimeout(120_000);
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        const onboarding = page.locator('dialog[open] .onboarding');
        if (await onboarding.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
            await testSetup.awaitFreshST({ page });
        } else {
            await testSetup.awaitST({ page });
        }
    });

    test('1,200 entries: every one is drawn, in order, none jumping, and the cards span the page', async ({ page }) => {
        await openWorld(page, 'Twelve Hundred');
        await expect(drawn(page).first()).toBeVisible();
        const grid = await page.locator('#Worldbuilding .wb-top').boundingBox();
        const shown = await pane(page).boundingBox();
        expect(grid && shown && grid.width).toBeGreaterThan(((shown?.width ?? 0) - 100));
        await scrollThrough(page, 1200);
        await expect(drawn(page)).toHaveCount(1200);
    });

    test('3,000 entries: the rest are read and kept as the page is scrolled', async ({ page }) => {
        await openWorld(page, 'Three Thousand');
        await expect(drawn(page).first()).toBeVisible();
        expect(await drawn(page).count()).toBeLessThan(3000);
        await scrollThrough(page, 3000);
        await expect(drawn(page)).toHaveCount(3000);
        await pane(page).evaluate(element => element.scrollTo(0, 0));
        await expect(drawn(page)).toHaveCount(3000);
    });

    test('drawn as rows, the rows fill the pane, are read as it is scrolled, and a view is renamed and deleted', async ({ page }) => {
        await openWorld(page, 'Three Thousand');
        await page.locator('#Worldbuilding').getByRole('button', { name: '+ View' }).click();
        await page.locator('#Worldbuilding .wb-vseg label', { hasText: 'Rows' }).click();
        await expect(page.locator('#Worldbuilding .wb-trs > .wb-top-row').first()).toBeVisible();
        const box = await pane(page).boundingBox();
        const front = await page.locator('#Worldbuilding .wb-front').boundingBox();
        expect(front && box && Math.round(front.height)).toBeGreaterThanOrEqual(Math.round(box?.height ?? 0));
        await scrollThrough(page, 3000);

        const tab = page.locator('#Worldbuilding .wb-vt', { hasText: 'New view' });
        await tab.locator('.wb-vt-more').click();
        await page.getByRole('menuitem', { name: 'Rename…' }).click();
        await page.locator('dialog[open] input, dialog[open] textarea').first().fill('Everything');
        await page.locator('dialog[open] .popup-button-ok').click();
        const renamed = page.locator('#Worldbuilding .wb-vt', { hasText: 'Everything' });
        await expect(renamed).toBeVisible();

        await renamed.locator('.wb-vt-more').click();
        await page.getByRole('menuitem', { name: 'Delete' }).click();
        await page.locator('dialog[open] .popup-button-ok').click();
        await expect(page.locator('#Worldbuilding .wb-vt', { hasText: 'Everything' })).toHaveCount(0);
    });
});
