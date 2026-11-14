import { test, expect } from './fixtures.js';
import { testSetup } from './frontent-test-utils.js';
import { deleteWorld, makeWorld } from './worlds.js';

const unique = (/** @type {string} */ name) => `${name} ${Date.now()}${Math.floor(Math.random() * 1000)}`;

/**
 * @param {number} uid
 * @param {string} title
 * @param {{ inside?: number, works?: number }} [more]
 */
const entry = (uid, title, { inside, works } = {}) => ({
    uid, key: [title], keysecondary: [], comment: title, content: `About ${title}.`, constant: false, selective: true, order: 100,
    position: 0, depth: 4, disable: false, probability: 100, useProbability: true, displayIndex: uid,
    extensions: {
        names: [title],
        relations: [
            ...(inside === undefined ? [] : [{ kind: 1, target: inside, position: `a${uid}` }]),
            ...(works === undefined ? [] : [{ kind: 2, target: works, position: `a${uid}` }]),
        ],
    },
});

const COAST = {
    0: entry(0, 'Saltmarrow'),
    1: entry(1, 'The Lantern House', { inside: 0 }),
    2: entry(2, 'Ilse Varro', { inside: 1, works: 1 }),
    3: entry(3, 'Harbormaster Quell', { inside: 0, works: 4 }),
    4: entry(4, 'The Tidegate', { inside: 0 }),
    5: entry(5, 'Sister Oriel', { works: 6 }),
    6: entry(6, 'The Pale Choir'),
};

const KINDS = [{ id: 1, name: 'in' }, { id: 2, name: 'works at' }];

const at = (/** @type {number} */ target) => ({ kind: 2, is: { target, depth: 'directly' } });

const VIEWS = [
    { id: 'places', name: 'Places', groupBy: 1, drawing: 'cards' },
    { id: 'who', name: 'Who works where', groupBy: null, drawing: 'cards', columns: [at(1), at(4), at(6)] },
];

const pane = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#Worldbuilding');
const tab = (/** @type {import('@playwright/test').Page} */ page, /** @type {string} */ name) => pane(page).getByRole('tab', { name });
const column = (/** @type {import('@playwright/test').Page} */ page, /** @type {string} */ title) =>
    pane(page).locator('.wb-bcol', { has: page.locator('.wb-bh', { hasText: title }) });
const card = (/** @type {import('@playwright/test').Locator} */ within, /** @type {string} */ title) =>
    within.locator('.wb-ec', { hasText: title });

/**
 * Drags a card into the column with `into` in its header, holding Alt over it when `alt`.
 * @param {import('@playwright/test').Page} page
 * @param {string} title
 * @param {string} into
 * @param {boolean} [alt]
 */
async function drag(page, title, into, alt = false) {
    const from = await card(pane(page), title).first().boundingBox();
    const to = await column(page, into).boundingBox();
    if (!from || !to) throw new Error('the card or the column is not on screen');
    await page.mouse.move(from.x + 60, from.y + 30);
    await page.mouse.down();
    await page.mouse.move(from.x + 80, from.y + 40, { steps: 3 });
    await page.mouse.move(to.x + to.width / 2, to.y + 200, { steps: 10 });
    if (alt) await page.keyboard.down('Alt');
    await page.mouse.move(to.x + to.width / 2 + 5, to.y + 205, { steps: 2 });
    await expect(pane(page).locator('.wb-intent')).toBeVisible();
    await page.mouse.up();
    if (alt) await page.keyboard.up('Alt');
}

test.describe('boards and grids', () => {
    test.beforeEach(testSetup.awaitST);

    test('a card dragged to another column changes its relation; with Alt it keeps both', async ({ page }) => {
        const name = unique('Board');
        await page.setViewportSize({ width: 1280, height: 900 });
        await makeWorld(page, name, COAST, { relationKinds: KINDS, views: VIEWS });
        await tab(page, 'Who works where').click();

        await expect(column(page, 'The Lantern House').locator('.wb-bct')).toHaveText('1');
        await expect(card(column(page, 'The Pale Choir'), 'Sister Oriel')).toBeVisible();

        await drag(page, 'Sister Oriel', 'The Lantern House');
        await expect(card(column(page, 'The Lantern House'), 'Sister Oriel')).toBeVisible();
        await expect(card(column(page, 'The Pale Choir'), 'Sister Oriel')).toHaveCount(0);
        await expect(column(page, 'The Lantern House').locator('.wb-bct')).toHaveText('2');

        await drag(page, 'Harbormaster Quell', 'The Pale Choir', true);
        await expect(card(column(page, 'The Pale Choir'), 'Harbormaster Quell')).toBeVisible();
        await expect(card(column(page, 'The Tidegate'), 'Harbormaster Quell')).toBeVisible();

        await tab(page, 'Places').click();
        await deleteWorld(page, name);
    });

    test('columns and rows are added, toggled to any depth and taken off from the view bar', async ({ page }) => {
        const name = unique('Axes');
        await page.setViewportSize({ width: 1280, height: 900 });
        await makeWorld(page, name, COAST, { relationKinds: KINDS, views: VIEWS });
        const bar = pane(page).locator('.wb-vbar');

        await bar.getByRole('button', { name: 'Add to Rows' }).click();
        await bar.getByRole('menuitem', { name: 'in…' }).click();
        await bar.getByRole('textbox', { name: 'in: choose entry' }).fill('Saltmarrow');
        await bar.locator('.wb-pick-row', { hasText: 'Saltmarrow' }).click();
        await expect(tab(page, 'Places').locator('.wb-vdot')).toBeVisible();
        const saltmarrow = pane(page).locator('.wb-grh', { hasText: 'Saltmarrow' });
        await expect(saltmarrow.locator('.wb-bct')).toHaveText('3');

        await bar.getByRole('button', { name: 'Add to Columns' }).click();
        await bar.getByRole('menuitem', { name: 'works at…' }).click();
        await bar.getByRole('menuitem', { name: 'works at: any' }).click();
        await expect(pane(page).locator('.wb-gch', { hasText: 'works at' })).toBeVisible();
        const cell = pane(page).locator('.wb-gcell').first();
        await expect(card(cell, 'Harbormaster Quell')).toBeVisible();
        await expect(card(cell, 'Ilse Varro')).toHaveCount(0);

        await bar.getByRole('button', { name: 'in: Saltmarrow', exact: true }).click();
        await expect(bar.getByRole('button', { name: 'in: Saltmarrow · any depth', exact: true })).toBeVisible();
        await expect(card(cell, 'Ilse Varro')).toBeVisible();
        await expect(saltmarrow.locator('.wb-bct')).toHaveText('4');
        await saltmarrow.getByRole('button', { name: 'any depth' }).click();
        await expect(card(cell, 'Ilse Varro')).toHaveCount(0);

        await bar.getByRole('button', { name: 'Remove in: Saltmarrow' }).click();
        await expect(pane(page).locator('.wb-grh')).toHaveCount(0);
        await expect(column(page, 'works at')).toBeVisible();
        await bar.getByRole('button', { name: 'Remove works at: any' }).click();
        await expect(pane(page).locator('h1.wb-front-name')).toHaveText(name);
        await expect(tab(page, 'Places').locator('.wb-vdot')).toHaveCount(0);

        await deleteWorld(page, name);
    });
});
