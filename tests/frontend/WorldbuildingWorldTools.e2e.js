import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { heldWorlds, openWorld } from './worlds.js';

const SHELF = 'Shelf';
const LIBRARY = 'Library';
const COUNT = 300;

const shelf = Object.fromEntries(Array.from({ length: COUNT }, (_, i) => [i, {
    uid: i,
    key: [`thing${i}`, `alias${i}`],
    keysecondary: [],
    comment: i % 3 === 0 ? '' : `Book ${i}`,
    content: `Book ${i} is here.`,
    constant: false,
    selective: true,
    order: 100,
    position: 0,
    disable: i % 6 === 5,
    probability: 100,
    useProbability: true,
    displayIndex: i,
}]));
const library = { 0: { uid: 0, key: ['shelved'], comment: 'Shelved', content: 'Shelved.', displayIndex: 0 } };

test.use({
    freshAccount: true,
    upstreamFiles: {
        [`worlds/${SHELF}.json`]: JSON.stringify({ entries: shelf }),
        [`worlds/${LIBRARY}.json`]: JSON.stringify({ entries: library }),
    },
});

const pane = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#Worldbuilding');

test.describe('a world\'s tools in the world switcher and the rows', () => {
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

    test('activation settings open from the world switcher, with short names and a sentence each, and save', async ({ page }) => {
        await expect(page.locator('#world_info_settings')).toHaveCount(0);
        await pane(page).getByRole('button', { name: 'Switch world' }).click();
        await pane(page).getByRole('menuitem', { name: 'Activation settings…' }).click();
        const panel = pane(page).getByRole('dialog', { name: 'Activation settings' });
        await expect(panel).toBeVisible();
        const depth = panel.locator('label', { hasText: 'Scan depth' });
        await expect(depth).toHaveAttribute('title', 'How many of the newest messages are scanned for keys.');
        for (const name of ['Budget (% of context)', 'Budget cap (tokens)', 'Recursive scan', 'Max recursion steps', 'Min activations', 'Max depth (messages)', 'Case-sensitive', 'Match whole words', 'Include names', 'Use group scoring', 'Insertion strategy', 'Alert on overflow']) {
            await expect(panel.locator('.wi-settings-name').getByText(name, { exact: true })).toHaveCount(1);
        }
        await panel.locator('#wi_scan_depth').fill('7');
        await panel.locator('#wi_scan_depth').press('Enter');
        await expect.poll(() => page.evaluate(async () => {
            const { newUi } = await import('/scripts/new-ui-page.js');
            return newUi().settings.value('world_info_settings.world_info_depth');
        })).toBe(7);
    });

    test('several worlds are used in every chat from the switcher\'s list, and a row opens its world', async ({ page }) => {
        await pane(page).getByRole('button', { name: 'Switch world' }).click();
        await pane(page).getByRole('checkbox', { name: `${LIBRARY}: used in every chat` }).click();
        await pane(page).getByRole('checkbox', { name: `${SHELF}: used in every chat` }).click();
        await expect.poll(async () => {
            const worlds = await heldWorlds(page);
            return [worlds[SHELF]?.usedInEveryChat, worlds[LIBRARY]?.usedInEveryChat];
        }).toEqual([true, true]);
        await expect(pane(page).getByRole('checkbox', { name: `${LIBRARY}: used in every chat` })).toBeChecked();
        await pane(page).getByRole('menuitem', { name: new RegExp(`^${LIBRARY}`) }).click();
        await expect(pane(page).locator('h1.wb-front-name')).toHaveText(LIBRARY);
    });

    test('empty titles are filled from their keys over the selected rows, on the server', async ({ page }) => {
        await pane(page).getByRole('button', { name: '+ View' }).click();
        await pane(page).locator('.wb-vseg label').nth(1).click();
        await pane(page).getByRole('checkbox', { name: 'Select all matching' }).click();
        const bar = pane(page).locator('.wb-bulk');
        await bar.getByRole('button', { name: 'Set' }).click();
        await bar.getByRole('menuitem', { name: 'Fill empty titles from keys' }).click();
        await expect(pane(page).locator('.wb-tr[data-entry]', { hasText: /^thing0, alias0/ })).toHaveCount(1);
        await expect(pane(page).locator('.wb-tr[data-entry]', { hasText: /^Book 1(?!\d)/ })).toHaveCount(1);
        await expect.poll(() => page.evaluate(async () => {
            const { getRequestHeaders } = await import('/scripts/request-headers.js');
            const read = await fetch('/api/worldinfo/entry/get', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name: 'Shelf', uid: 297 }) });
            return (await read.json()).entry.comment;
        })).toBe('thing297, alias297');
    });
});
