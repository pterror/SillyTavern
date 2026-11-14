import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { openWorld } from './worlds.js';

const SHELF = 'Shelf';
const LIBRARY = 'Library';
const COUNT = 300;

const entry = (/** @type {number} */ i, /** @type {string} */ text) => ({
    uid: i,
    key: [`thing${i}`],
    keysecondary: [],
    comment: `${text} ${i}`,
    content: `${text} ${i} is here.`,
    constant: false,
    selective: true,
    order: 100,
    position: 0,
    disable: i % 6 === 5,
    probability: 100,
    useProbability: true,
    displayIndex: i,
});
const shelf = Object.fromEntries(Array.from({ length: COUNT }, (_, i) => [i, entry(i, 'Book')]));
const library = Object.fromEntries([0, 1, 2].map(i => [i, entry(i, 'Shelved')]));

test.use({
    freshAccount: true,
    upstreamFiles: {
        [`worlds/${SHELF}.json`]: JSON.stringify({ entries: shelf }),
        [`worlds/${LIBRARY}.json`]: JSON.stringify({ entries: library }),
    },
});

const pane = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#Worldbuilding');
const card = (/** @type {import('@playwright/test').Page} */ page, /** @type {string} */ name) =>
    pane(page).locator('.wb-card', { has: page.locator('.wb-card-name', { hasText: new RegExp(`^${name}$`) }) });

/**
 * How many entries each world has, as the page's worlds view says.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<Record<string, number>>}
 */
async function counts(page) {
    return page.evaluate(async () => {
        const { worlds } = await import('/scripts/world-links.js');
        return Object.fromEntries((worlds() ?? []).map(world => [world.name, world.entries]));
    });
}

/**
 * The entry of a world whose title is `title`, as stored.
 * @param {import('@playwright/test').Page} page
 * @param {string} world
 * @param {string} title
 */
async function titled(page, world, title) {
    return page.evaluate(async ({ world, title }) => {
        const { getRequestHeaders } = await import('/scripts/request-headers.js');
        const found = await (await fetch('/api/worldinfo/entry/find', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name: world, field: 'comment', text: title }) })).json();
        if (found.uid === null) return null;
        const read = await fetch('/api/worldinfo/entry/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name: world, uid: found.uid }) });
        return (await read.json()).entry;
    }, { world, title });
}

test.describe('copying and moving entries between worlds', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        const onboarding = page.locator('dialog[open] .onboarding');
        if (await onboarding.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
            await testSetup.awaitFreshST({ page });
        } else {
            await testSetup.awaitST({ page });
        }
        await openWorld(page, SHELF);
    });

    test('a card copies its entry to another world, moves it, and duplicates it in its own', async ({ page }) => {
        const before = await counts(page);
        await card(page, 'Book 10').hover();
        await card(page, 'Book 10').locator('.wb-card-more').click();
        await pane(page).getByRole('menuitem', { name: 'Copy to world…' }).click();
        await pane(page).getByRole('menuitem', { name: LIBRARY }).click();
        await expect.poll(async () => (await counts(page))[LIBRARY]).toBe(before[LIBRARY] + 1);
        expect((await counts(page))[SHELF]).toBe(before[SHELF]);
        await expect(card(page, 'Book 10')).toHaveCount(1);

        await card(page, 'Book 11').hover();
        await card(page, 'Book 11').locator('.wb-card-more').click();
        await pane(page).getByRole('menuitem', { name: 'Move to world…' }).click();
        await pane(page).getByRole('menuitem', { name: LIBRARY }).click();
        await expect(card(page, 'Book 11')).toHaveCount(0);
        await expect.poll(async () => counts(page)).toEqual({ ...before, [SHELF]: before[SHELF] - 1, [LIBRARY]: before[LIBRARY] + 2 });

        await card(page, 'Book 12').hover();
        await card(page, 'Book 12').locator('.wb-card-more').click();
        await pane(page).getByRole('menuitem', { name: 'Duplicate' }).click();
        await expect(card(page, 'Book 12')).toHaveCount(2);
        const names = await pane(page).locator('.wb-card-name').allTextContents();
        expect(names.indexOf('Book 12') + 1).toBe(names.lastIndexOf('Book 12'));

        await openWorld(page, LIBRARY);
        await expect(card(page, 'Book 10')).toHaveCount(1);
        await expect(card(page, 'Book 11')).toHaveCount(1);
    });

    test('an entry\'s page copies it to another world', async ({ page }) => {
        const before = await counts(page);
        await card(page, 'Book 20').locator('.wb-card-open').click();
        await pane(page).locator('.wb-entry-more').click();
        await pane(page).getByRole('menuitem', { name: 'Copy to world…' }).click();
        await pane(page).getByRole('menuitem', { name: LIBRARY }).click();
        await expect.poll(async () => (await counts(page))[LIBRARY]).toBe(before[LIBRARY] + 1);
        await expect(pane(page).locator('.wb-entry')).toBeVisible();
    });

    test('the selected rows are copied, then moved, to another world on the server', async ({ page }) => {
        const before = await counts(page);
        await pane(page).getByRole('button', { name: '+ View' }).click();
        await pane(page).locator('.wb-vseg label').nth(1).click();
        const box = (/** @type {number} */ i) => pane(page).locator('.wb-tr[data-entry]', { hasText: new RegExp(`^Book ${i}(?!\\d)`) }).locator('input[type=checkbox]');
        for (const i of [1, 2, 5]) {
            await box(i).click();
            await expect(box(i)).toBeChecked();
        }
        const bar = pane(page).locator('.wb-bulk');
        await expect(bar).toContainText('3 selected');
        await bar.getByRole('button', { name: 'Copy to world…' }).click();
        await bar.getByRole('menuitem', { name: LIBRARY }).click();
        await expect.poll(async () => (await counts(page))[LIBRARY]).toBe(before[LIBRARY] + 3);
        expect((await counts(page))[SHELF]).toBe(before[SHELF]);
        expect((await titled(page, LIBRARY, 'Book 5'))?.disable).toBe(true);

        await expect(bar).toHaveCount(0);
        await pane(page).getByRole('checkbox', { name: 'Select all matching' }).click();
        await expect(box(0)).toBeChecked();
        await box(0).click();
        await expect(box(0)).not.toBeChecked();
        await bar.getByRole('button', { name: 'Move to world…' }).click();
        await bar.getByRole('menuitem', { name: LIBRARY }).click();
        await expect.poll(async () => counts(page), { timeout: 20000 }).toEqual({ ...before, [SHELF]: 1, [LIBRARY]: before[LIBRARY] + 3 + COUNT - 1 });
    });
});
