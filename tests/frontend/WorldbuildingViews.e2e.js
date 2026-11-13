import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { deleteWorld, makeWorld } from './worlds.js';

const unique = (/** @type {string} */ name) => `${name} ${Date.now()}${Math.floor(Math.random() * 1000)}`;

/**
 * @param {number} uid
 * @param {string} title
 * @param {{ inside?: number, owes?: number, order?: number }} [more]
 */
const entry = (uid, title, { inside, owes, order = 100 } = {}) => ({
    uid, key: [title], keysecondary: [], comment: title, content: `About ${title}.`, constant: false, selective: true, order,
    position: 0, depth: 4, disable: false, probability: 100, useProbability: true, displayIndex: uid,
    extensions: {
        names: [title],
        relations: [
            ...(inside === undefined ? [] : [{ kind: 1, target: inside, position: `a${uid}` }]),
            ...(owes === undefined ? [] : [{ kind: 2, target: owes, position: `a${uid}` }]),
        ],
    },
});

const COAST = {
    0: entry(0, 'Saltmarrow'),
    1: entry(1, 'The Lantern House', { inside: 0 }),
    2: entry(2, 'Ilse Varro', { inside: 1 }),
    3: entry(3, 'Harbormaster Quell', { inside: 0, owes: 2 }),
    4: entry(4, 'Season of fog', { order: 80 }),
};

const KINDS = [{ id: 1, name: 'in' }, { id: 2, name: 'owes' }];

const VIEWS = [
    { id: 'places', name: 'Places', groupBy: 1, drawing: 'cards' },
    { id: 'debts', name: 'Debts', groupBy: 2, drawing: 'cards' },
    { id: 'prompt', name: 'Prompt order', groupBy: null, drawing: 'rows', fields: ['relations', 'keys', 'comesIn', 'goes', 'order', 'chance', 'tokens'] },
];

const pane = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#Worldbuilding');
const tab = (/** @type {import('@playwright/test').Page} */ page, /** @type {string} */ name) => pane(page).getByRole('tab', { name });
const region = (/** @type {import('@playwright/test').Page} */ page, /** @type {string} */ title) =>
    pane(page).locator('.wb-region', { has: page.locator(':scope > .wb-region-head .wb-region-name', { hasText: title }) });
const row = (/** @type {import('@playwright/test').Page} */ page, /** @type {string} */ title) =>
    pane(page).locator('.wb-tr[data-entry]', { has: page.getByRole('checkbox', { name: `Select ${title}`, exact: true }) });

test.describe('a world\'s views', () => {
    test.beforeEach(testSetup.awaitST);

    test('the world\'s views are tabs; a change is the tab\'s until saved, discarded or reset', async ({ page }) => {
        const name = unique('Views');
        await page.setViewportSize({ width: 1280, height: 1000 });
        await makeWorld(page, name, COAST, { relationKinds: KINDS, views: VIEWS });

        await expect(tab(page, 'Places')).toHaveAttribute('aria-selected', 'true');
        await expect(region(page, 'Saltmarrow')).toBeVisible();
        await tab(page, 'Debts').click();
        await expect(region(page, 'Ilse Varro').locator('.wb-card', { hasText: 'Harbormaster Quell' })).toBeVisible();

        await tab(page, 'Places').click();
        await pane(page).getByLabel('Inside, grouped by').selectOption({ label: 'owes' });
        await expect(tab(page, 'Places').locator('.wb-vdot')).toBeVisible();
        await expect(region(page, 'Ilse Varro')).toBeVisible();
        await pane(page).getByRole('button', { name: 'Discard' }).click();
        await expect(tab(page, 'Places').locator('.wb-vdot')).toHaveCount(0);
        await expect(region(page, 'Saltmarrow')).toBeVisible();

        await pane(page).getByLabel('Inside, grouped by').selectOption({ label: 'owes' });
        await pane(page).getByRole('button', { name: 'Save' }).click();
        await expect(tab(page, 'Places').locator('.wb-vdot')).toHaveCount(0);
        await tab(page, 'Debts').click();
        await tab(page, 'Places').click();
        await expect(pane(page).getByLabel('Inside, grouped by')).toHaveValue('2');

        await pane(page).getByRole('button', { name: 'Reset to the world’s' }).click();
        await expect(pane(page).getByLabel('Inside, grouped by')).toHaveValue('1');
        await expect(region(page, 'Saltmarrow')).toBeVisible();

        await pane(page).getByRole('button', { name: '+ View' }).click();
        await expect(tab(page, 'New view')).toHaveAttribute('aria-selected', 'true');
        await deleteWorld(page, name);
    });

    test('rows edit a cell; a run of boxes is selected and a bulk change sets every one but the exception', async ({ page }) => {
        const name = unique('Rows');
        await page.setViewportSize({ width: 1280, height: 900 });
        await makeWorld(page, name, COAST, { relationKinds: KINDS, views: VIEWS });
        await tab(page, 'Prompt order').click();
        await expect(row(page, 'Season of fog')).toBeVisible();

        await row(page, 'Season of fog').locator('.wb-cell').nth(1).click();
        await row(page, 'Season of fog').getByLabel('Goes').selectOption({ label: 'Into the chat' });
        await expect(row(page, 'Season of fog')).toContainText('Into the chat, 4 up');

        const box = async (/** @type {string} */ title) => {
            const found = await pane(page).getByRole('checkbox', { name: `Select ${title}`, exact: true }).boundingBox();
            if (!found) throw new Error(`no box for ${title}`);
            return { x: found.x + found.width / 2, y: found.y + found.height / 2 };
        };
        const from = await box('Saltmarrow');
        const to = await box('Ilse Varro');
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 6 });
        await page.mouse.up();
        await expect(pane(page).locator('.wb-bulk')).toContainText('3 selected');
        await pane(page).getByRole('button', { name: 'Clear' }).click();
        await expect(pane(page).locator('.wb-bulk')).toHaveCount(0);

        await pane(page).getByRole('checkbox', { name: 'Select all matching' }).click();
        await expect(pane(page).locator('.wb-bulk')).toContainText('All 5 matching');
        await row(page, 'Season of fog').locator('.wb-cb').click();
        await expect(pane(page).locator('.wb-bulk')).toContainText('All 5 matching, except 1');
        await pane(page).locator('.wb-bulk').getByRole('button', { name: 'Set ▾' }).click();
        await pane(page).locator('.wb-bulk-menu').getByRole('menuitem', { name: 'Always' }).click();
        await expect(row(page, 'Saltmarrow')).toContainText('Always');
        await expect(row(page, 'Ilse Varro')).toContainText('Always');
        await expect(row(page, 'Season of fog')).toContainText('When brought up');

        await pane(page).getByRole('checkbox', { name: 'Select Harbormaster Quell' }).click();
        await pane(page).getByRole('checkbox', { name: 'Select all matching' }).click();
        await row(page, 'Season of fog').locator('.wb-cb').click();
        await pane(page).locator('.wb-bulk').getByRole('button', { name: 'Delete' }).click();
        await page.locator('dialog[open] .popup-button-ok').click();
        await expect(row(page, 'Season of fog')).toBeVisible();
        await expect(pane(page).locator('.wb-tr[data-entry]')).toHaveCount(1);
        await tab(page, 'Places').click();
        await deleteWorld(page, name);
    });
});
